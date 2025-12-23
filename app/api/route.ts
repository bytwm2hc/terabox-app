export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";

function getFormattedSize(bytes: number) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + " KB";
  return bytes + " bytes";
}

function findBetween(str: string, start: string, end: string) {
  const s = str.indexOf(start);
  if (s === -1) return null;
  const e = str.indexOf(end, s + start.length);
  if (e === -1) return null;
  return str.substring(s + start.length, e);
}

async function fetchFollowWithCookies(
  url: string,
  headers: Headers,
  maxRedirects = 10
): Promise<Response> {
  let current = url;
  let cookieStore = headers.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(current, {
      headers,
      redirect: "manual",
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      cookieStore += (cookieStore ? "; " : "") + setCookie;
      headers.set("Cookie", cookieStore);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = location.startsWith("http")
        ? location
        : new URL(location, current).toString();
      continue;
    }

    return res;
  }

  throw new Error("Too many redirects");
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const link = searchParams.get("data");
    if (!link) {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    const headers = new Headers({
      "User-Agent":
        process.env["USER-AGENT"] ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      "Referer": "https://1024terabox.com/",
    });

    if (process.env.COOKIE) {
      headers.set("Cookie", process.env.COOKIE);
    }

    /* ===== Step 1：分享頁（完整 redirect + cookie） ===== */
    const pageRes = await fetchFollowWithCookies(link, headers);
    const finalUrl = new URL(pageRes.url);

    const surl = finalUrl.searchParams.get("surl");
    if (!surl) {
      return NextResponse.json({ error: "Missing surl" }, { status: 400 });
    }

    const html = await pageRes.text();    const jsToken = findBetween(html, "fn%28%22", "%22%29");
    if (!jsToken) {
      return NextResponse.json({ error: "Missing jsToken" }, { status: 400 });
    }

    /* ===== Step 2：list API（同樣帶 cookie） ===== */
    const api =
      "https://www.terabox.com/share/list" +
      `?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${jsToken}` +
      `&page=1&num=20&order=asc&shorturl=${surl}&root=1`;

    const listRes = await fetchFollowWithCookies(api, headers);
    const json = await listRes.json();

    if (!json?.list?.length) {
      return NextResponse.json({ error: "Empty list" }, { status: 400 });
    }

    const file = json.list[0];

    /* ===== proxy 模式（Edge streaming） ===== */
    if (searchParams.has("proxy")) {
      return await proxyDownload(req, file.dlink, headers);
    }

    /* ===== direct link（GET，不用 HEAD） ===== */
    let direct_link = "";
    if (!searchParams.has("nodirectlink")) {
      const dlinkRes = await fetchFollowWithCookies(file.dlink, headers);
      direct_link = dlinkRes.url;
    }

    if (searchParams.has("download")) {
      return NextResponse.redirect(direct_link, 302);
    }

    return NextResponse.json(
      {
        file_name: file.server_filename,
        link: file.dlink,
        direct_link,
        thumb: file.thumbs?.url3 ?? "",
        size: getFormattedSize(+file.size),
        sizebytes: +file.size,
      },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown Error" },
      { status: 500 }
    );
  }
}

async function proxyDownload(
  req: NextRequest,
  url: string,
  headers: Headers
): Promise<Response> {
  // 轉發 Range / If-Range
  const range = req.headers.get("range");
  if (range) {
    headers.set("Range", range);
  }

  const upstream = await fetchFollowWithCookies(url, headers);

  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`Upstream error: ${upstream.status}`);
  }

  // 複製上游 headers（但過濾危險的）
  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (
      key.toLowerCase().startsWith("content") ||
      key === "accept-ranges"
    ) {
      resHeaders.set(key, value);
    }
  });

  // CORS
  resHeaders.set("Access-Control-Allow-Origin", "*");
  resHeaders.set("Access-Control-Expose-Headers", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}
