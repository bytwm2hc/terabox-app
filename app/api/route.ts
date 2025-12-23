declare const COOKIE_KV: KVNamespace;  // 告訴 TS 這是 global
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// 型別安全 interface
interface ListResponse {
  list: Array<{
    dlink: string;
    server_filename: string;
    size: string;
    thumbs?: { url3: string };
  }>;
}

// 工具函式
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

function normalizeCookie(cookie: string) {
  return cookie
    .split(";")
    .map(c => c.trim())
    .filter(Boolean)
    .sort()
    .join("; ");
}

async function fetchFollowWithCookies(
  url: string,
  headers: Headers,
  maxRedirects = 10
): Promise<{ response: Response; cookie: string }> {
  let current = url;
  let cookieStore = headers.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(current, { headers, redirect: "manual" });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      cookieStore += (cookieStore ? "; " : "") + setCookie;
      headers.set("Cookie", cookieStore);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { response: res, cookie: cookieStore };
      current = location.startsWith("http") ? location : new URL(location, current).toString();
      continue;
    }

    return { response: res, cookie: cookieStore };
  }

  throw new Error("Too many redirects");
}

async function proxyDownload(req: NextRequest, url: string, headers: Headers): Promise<Response> {
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  const upstream = await fetchFollowWithCookies(url, headers);
  const { response } = upstream;

  if (!response.ok && response.status !== 206)
    throw new Error(`Response error: ${response.status}`);

  const resHeaders = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("content") || key.toLowerCase() === "accept-ranges")
      resHeaders.set(key, value);
  });

  resHeaders.set("Access-Control-Allow-Origin", "*");
  resHeaders.set("Access-Control-Expose-Headers", "*");

  return new Response(response.body, { status: response.status, headers: resHeaders });
}

// ---------------------------
// 改動的核心：使用 env 取得 KV
// ---------------------------
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const link = searchParams.get("data");
    if (!link) return NextResponse.json({ error: "Missing data" }, { status: 400 });

    const headers = new Headers({
      "User-Agent":
        process.env["USER-AGENT"] ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      Referer: "https://1024terabox.com/",
    });

    // ✅ 從 env 拿 KV
    const oldCookie = (await COOKIE_KV.get("cookie")) ?? "";
    if (oldCookie) headers.set("Cookie", oldCookie);
    let finalCookie = oldCookie;

    const pageResObj = await fetchFollowWithCookies(link, headers);
    finalCookie = pageResObj.cookie;
    const pageRes = pageResObj.response;

    const finalUrl = new URL(pageRes.url);
    const surl = finalUrl.searchParams.get("surl");
    if (!surl) return NextResponse.json({ error: "Missing surl" }, { status: 400 });

    const html = await pageRes.text();
    const jsToken = findBetween(html, "fn%28%22", "%22%29");
    if (!jsToken) return NextResponse.json({ error: "Missing jsToken" }, { status: 400 });

    const api =
      "https://www.terabox.com/share/list" +
      `?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${jsToken}` +
      `&page=1&num=20&order=asc&shorturl=${surl}&root=1`;

    const listResObj = await fetchFollowWithCookies(api, headers);
    finalCookie = listResObj.cookie;
    const listRes = listResObj.response;

    if (normalizeCookie(finalCookie) !== normalizeCookie(oldCookie)) {
      await COOKIE_KV.put("cookie", finalCookie);
    }

    const json = (await listRes.json()) as ListResponse;
    if (!json.list?.length) return NextResponse.json({ error: "Empty list" }, { status: 400 });

    const file = json.list[0];

    if (searchParams.has("proxy")) return await proxyDownload(req, file.dlink, headers);

    let direct_link = "";
    if (!searchParams.has("nodirectlink")) {
      const dlinkResObj = await fetchFollowWithCookies(file.dlink, headers);
      direct_link = dlinkResObj.response.url;
    }

    if (searchParams.has("download")) return NextResponse.redirect(direct_link, 302);

    return NextResponse.json(
      {
        file_name: file.server_filename,
        link: file.dlink,
        direct_link,
        thumb: file.thumbs?.url3 ?? "",
        size: getFormattedSize(+file.size),
        sizebytes: +file.size,
      },
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown Error" }, { status: 500 });
  }
}
