import { NextRequest, NextResponse } from "next/server";

// ✅ 必須啟用，否則 Cloudflare Pages 無法處理 Fetch 跳轉
export const runtime = "edge";
export const dynamic = "force-dynamic";

type TeraBoxFile = {
  dlink: string;
  server_filename: string;
  size: number | string;
  thumbs?: { url3?: string };
};

type ShareListResponse = { list: TeraBoxFile[] };

/* ================= Utils ================= */
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

// 統一 CORS 標頭
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/* ========== fetch with redirect + cookie ========== */
async function fetchFollowWithCookies(url: string, baseHeaders: Headers, maxRedirects = 10): Promise<Response> {
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
      current = location.startsWith("http") ? location : new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/* ================= GET handler ================= */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const link = searchParams.get("data");

    if (!link) return NextResponse.json({ error: "Missing data" }, { status: 400, headers: corsHeaders });

    const headers = new Headers({
      "User-Agent": process.env["USER_AGENT"] ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": "https://1024terabox.com/",
    });
    if (process.env.COOKIE) headers.set("Cookie", process.env.COOKIE);

    /* Step 1：解析分享頁 */
    const pageRes = await fetchFollowWithCookies(link, headers);
    const html = await pageRes.text();
    const finalUrl = new URL(pageRes.url);
    const surl = finalUrl.searchParams.get("surl");

    if (!surl) return NextResponse.json({ error: "Missing surl" }, { status: 400, headers: corsHeaders });

    const jsToken = findBetween(html, 'fn("', '")') || findBetween(html, "fn%28%22", "%22%29") || findBetween(html, 'jsToken":"', '"');
    if (!jsToken) return NextResponse.json({ error: "Missing jsToken" }, { status: 400, headers: corsHeaders });

    /* Step 2：List API */
    headers.set("Referer", pageRes.url);
    const api = `https://www.terabox.com/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${jsToken}&page=1&num=20&order=asc&shorturl=${surl}&root=1`;

    const listRes = await fetchFollowWithCookies(api, headers);
    const json = (await listRes.json()) as ShareListResponse;

    if (!json?.list?.length) return NextResponse.json({ error: "Empty list or invalid cookie" }, { status: 400, headers: corsHeaders });

    const file = json.list[0];

    /* Proxy 模式 */
    if (searchParams.has("proxy")) return await proxyDownload(req, file.dlink);

    /* Direct Link */
    let direct_link = "";
    if (!searchParams.has("nodirectlink")) {
      const dlinkRes = await fetchFollowWithCookies(file.dlink, headers);
      direct_link = dlinkRes.url;
    }

    if (searchParams.has("download") && direct_link) return NextResponse.redirect(direct_link, 302);

    return NextResponse.json(
      {
        file_name: file.server_filename,
        link: file.dlink,
        direct_link,
        thumb: file.thumbs?.url3 ?? "",
        size: getFormattedSize(+file.size),
        sizebytes: +file.size,
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown Error" }, { status: 500, headers: corsHeaders });
  }
}

// 必須處理 OPTIONS，否則前端跨域會掛掉
export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

/* ================= proxy download ================= */
async function proxyDownload(req: NextRequest, url: string): Promise<Response> {
  const headers = new Headers();
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  const upstream = await fetch(url, { headers });
  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("content") || key === "accept-ranges") {
      resHeaders.set(key, value);
    }
  });

  resHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}