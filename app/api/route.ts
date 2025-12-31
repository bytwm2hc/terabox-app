import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/* ================= Type Definitions ================= */
type TeraBoxFile = {
  dlink?: string;
  server_filename?: string;
  size?: number | string;
  thumbs?: { url3?: string };
};

type ShareListResponse = {
  list?: TeraBoxFile[];
};

type CachedResult = {
  file_name: string;
  link: string;
  direct_link: string;
  thumb: string;
  size: string;
  sizebytes: number;
};

/* ================= Utils ================= */
function getFormattedSize(bytes?: number): string {
  if (!Number.isFinite(bytes ?? NaN)) return "Unknown";
  if ((bytes ?? 0) >= 1024 * 1024) return ((bytes ?? 0) / 1024 / 1024).toFixed(2) + " MB";
  if ((bytes ?? 0) >= 1024) return ((bytes ?? 0) / 1024).toFixed(2) + " KB";
  return (bytes ?? 0) + " bytes";
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "*",
};

/* ================= Fetch with cookies ================= */
async function fetchFollowWithCookies(
  url: string,
  headers: Headers,
  method: string = "GET",
  maxRedirects = 10
): Promise<Response> {
  let current = url;
  let cookieStore = headers.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    const hdrs = new Headers(headers);
    if (cookieStore) hdrs.set("Cookie", cookieStore);

    const res = await fetch(current, { headers: hdrs, method, redirect: "manual" });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const cookiePair = setCookie.split(";")[0];
      cookieStore += (cookieStore ? "; " : "") + cookiePair;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = location.startsWith("http") ? location : new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/* ================= Extract jsToken ================= */
function extractJsToken(html: string): string | null {
  const match = html.match(/window\.__INITIAL_STATE__=({.*?});/);
  if (!match) return null;

  try {
    const state = JSON.parse(match[1]);
    let raw = state.jsToken;
    raw = decodeURIComponent(raw);
    if (!raw) return null;

    const tokenMatch = raw.match(/fn\("([^"]+)"\)/);
    return tokenMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

/* ================= Cloudflare Cache Helper ================= */
async function getFromCache(key: string): Promise<CachedResult | null> {
  if (typeof caches !== "undefined" && (caches as any).default) {
    try {
      const cache = (caches as any).default as Cache;
      const cachedResp = await cache.match(key);
      if (!cachedResp) return null;
      return (await cachedResp.json()) as CachedResult;
    } catch {
      return null;
    }
  }
  return null;
}

async function putToCache(key: string, value: CachedResult, ttl = 60 * 5) {
  if (typeof caches !== "undefined" && (caches as any).default) {
    try {
      const cache = (caches as any).default as Cache;
      const resp = new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
      resp.headers.set("Cache-Control", `public, max-age=${ttl}`);
      await cache.put(key, resp);
    } catch {
      // 忽略快取錯誤
    }
  }
}

/* ================= GET ================= */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const shareUrl = searchParams.get("data");
    if (!shareUrl)
      return NextResponse.json({ error: "Missing data" }, { status: 400, headers: corsHeaders });

    const cacheKey = new Request(shareUrl);
    const cached = await getFromCache(cacheKey.url);
    if (cached) {
      // 快取 HIT
      if (searchParams.has("proxy")) return proxyDownload(req, cached.direct_link);
      if (searchParams.has("download")) return NextResponse.redirect(cached.direct_link, 302);
      return NextResponse.json(cached, { headers: corsHeaders });
    }

    const headers = new Headers({
      "User-Agent": process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
    });
    if (process.env.COOKIE) headers.set("Cookie", process.env.COOKIE);

    /* Step 1：抓分享頁 HTML */
    const pageRes = await fetchFollowWithCookies(shareUrl, headers);
    const html = await pageRes.text();

    const jsToken = extractJsToken(html);
    if (!jsToken)
      return NextResponse.json({ error: "Missing jsToken" }, { status: 400, headers: corsHeaders });

    /* Step 2：取得 surl */
    const pageURL = new URL(pageRes.url);
    const surl = pageURL.searchParams.get("surl") || pageURL.pathname.match(/^\/s\/([^/?]+)/)?.[1];
    if (!surl)
      return NextResponse.json({ error: "Missing surl" }, { status: 400, headers: corsHeaders });

    /* Step 3：List API */
    const apiUrl = `https://www.1024tera.com/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${encodeURIComponent(
      jsToken
    )}&page=1&num=20&order=asc&shorturl=${surl}&root=1`;

    headers.set("Referer", "https://www.1024tera.com/");
    headers.set("X-Requested-With", "XMLHttpRequest");
    const listRes = await fetchFollowWithCookies(apiUrl, headers);
    const json = (await listRes.json()) as ShareListResponse;

    const file = json?.list?.[0];
    if (!file || !file.dlink)
      return NextResponse.json({ error: "File not found" }, { status: 400, headers: corsHeaders });

    /* Step 4：Direct link */
    headers.delete("Referer");
    headers.delete("Host");
    headers.delete("X-Requested-With");
    const dlinkRes = await fetchFollowWithCookies(file.dlink, headers, "HEAD");
    const direct_link = dlinkRes.url;
    if (!direct_link)
      return NextResponse.json({ error: "Direct link failed" }, { status: 500, headers: corsHeaders });

    const result: CachedResult = {
      file_name: file.server_filename ?? "",
      link: file.dlink,
      direct_link,
      thumb: file.thumbs?.url3 ?? "",
      size: getFormattedSize(Number(file.size)),
      sizebytes: Number(file.size) || 0,
    };

    // Put successful result to cache (15 minutes)
    await putToCache(cacheKey.url, result, 60 * 15);

    if (searchParams.has("proxy")) return proxyDownload(req, direct_link);
    if (searchParams.has("download")) return NextResponse.redirect(direct_link, 302);

    return NextResponse.json(result, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown Error" }, { status: 500, headers: corsHeaders });
  }
}

/* ================= OPTIONS ================= */
export async function OPTIONS() {
  return new NextResponse(null, { headers: corsHeaders });
}

/* ================= Proxy download ================= */
async function proxyDownload(req: NextRequest, url: string): Promise<Response> {
  const headers = new Headers();
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  //headers.set("User-Agent", process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36");

  const upstream = await fetch(url, { headers });
  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    //if (k.startsWith("content") || k === "accept-ranges") resHeaders.set(k, v);
    resHeaders.set(k, v);
  });
  resHeaders.set("Access-Control-Allow-Origin", "*");
  resHeaders.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  resHeaders.set("Access-Control-Expose-Headers", "*");

  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}