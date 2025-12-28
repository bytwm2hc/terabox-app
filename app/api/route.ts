import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type TeraBoxFile = {
  dlink?: string;
  server_filename?: string;
  size?: number | string;
  thumbs?: { url3?: string };
};

type ShareListResponse = {
  list?: TeraBoxFile[];
};

/* ================= Utils ================= */
function getFormattedSize(bytes?: number) {
  if (!Number.isFinite(bytes)) return "Unknown";
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "*",
};

async function fetchFollowWithCookies(
  url: string,
  baseHeaders: Headers,
  maxRedirects = 10
): Promise<Response> {
  if (!url) throw new Error("Invalid URL");

  let current = url;
  let cookieStore = baseHeaders.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    const headers = new Headers(baseHeaders);
    if (cookieStore) headers.set("Cookie", cookieStore);

    const res = await fetch(current, { headers, redirect: "manual" });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const cookiePair = setCookie.split(";")[0];
      cookieStore += (cookieStore ? "; " : "") + cookiePair;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;

      current = location.startsWith("http")
        ? location
        : new URL(location, current).href;

      continue;
    }

    return res;
  }

  throw new Error("Too many redirects");
}

/* ================= GET ================= */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const shareUrl = searchParams.get("data");

    if (!shareUrl) {
      return NextResponse.json({ error: "Missing data" }, { status: 400, headers: corsHeaders });
    }

    const headers = new Headers({
      "User-Agent":
        process.env.USER_AGENT ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Referer: "https://www.1024tera.com/",
    });

    if (process.env.COOKIE) {
      headers.set("Cookie", process.env.COOKIE);
    }

    /* Step 1：抓分享頁 */
    const pageRes = await fetchFollowWithCookies(shareUrl, headers);
    const html = await pageRes.text();

    /* Step 2：取得 shorturl（新版是路徑，不是 ?surl=） */
    const pageURL = new URL(pageRes.url);
    const pathMatch = pageURL.pathname.match(/^\/s\/([^/?]+)/);
    const shorturl = pathMatch?.[1];

    if (!shorturl) {
      return NextResponse.json({ error: "Missing shorturl" }, { status: 400, headers: corsHeaders });
    }

    /* Step 3：jsToken */
    const jsToken =
      findBetween(html, 'fn("', '")') ||
      findBetween(html, "fn%28%22", "%22%29") ||
      findBetween(html, 'jsToken":"', '"');

    if (!jsToken) {
      return NextResponse.json({ error: "Missing jsToken" }, { status: 400, headers: corsHeaders });
    }

    /* Step 4：List API */
    const api =
      `https://www.1024tera.com/share/list?` +
      `app_id=250528&web=1&channel=dubox&clienttype=0` +
      `&jsToken=${encodeURIComponent(jsToken)}` +
      `&page=1&num=20&order=asc&shorturl=${shorturl}&root=1`;

    const listRes = await fetchFollowWithCookies(api, headers);
    const json = (await listRes.json()) as ShareListResponse;

    const file = json?.list?.[0];
    if (!file || !file.dlink) {
      return NextResponse.json({ error: "File not found" }, { status: 400, headers: corsHeaders });
    }

    /* Step 5：Direct link */
    const dlinkRes = await fetchFollowWithCookies(file.dlink, headers);
    const direct_link = dlinkRes.url;

    if (!direct_link) {
      return NextResponse.json({ error: "Direct link failed" }, { status: 500, headers: corsHeaders });
    }

    /* Proxy download */
    if (searchParams.has("proxy")) {
      return proxyDownload(req, direct_link);
    }

    /* Redirect */
    if (searchParams.has("download")) {
      return NextResponse.redirect(direct_link, 302);
    }

    return NextResponse.json(
      {
        file_name: file.server_filename ?? "",
        link: file.dlink,
        direct_link,
        thumb: file.thumbs?.url3 ?? "",
        size: getFormattedSize(Number(file.size)),
        sizebytes: Number(file.size) || 0,
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown Error" },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

/* ================= proxy ================= */
async function proxyDownload(req: NextRequest, url: string): Promise<Response> {
  const headers = new Headers();
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  headers.set("Referer", "https://www.1024tera.com/");
  headers.set("User-Agent", "Mozilla/5.0");

  const upstream = await fetch(url, { headers });

  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (k.startsWith("content") || k === "accept-ranges") {
      resHeaders.set(k, v);
    }
  });

  resHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}