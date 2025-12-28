import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/* ================= Types ================= */
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
function getFormattedSize(bytes?: number): string {
  if (!Number.isFinite(bytes ?? NaN)) return "Unknown";
  if ((bytes ?? 0) >= 1024 * 1024) return ((bytes ?? 0) / 1024 / 1024).toFixed(2) + " MB";
  if ((bytes ?? 0) >= 1024) return ((bytes ?? 0) / 1024).toFixed(2) + " KB";
  return (bytes ?? 0) + " bytes";
}

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "*"
};

/* ================= Fetch with cookies ================= */
async function fetchFollowWithCookies(
  url: string,
  headers: Headers,
  method: "GET" | "HEAD" = "GET",
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
      current = location.startsWith("http")
        ? location
        : new URL(location, current).href;
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
    const state = JSON.parse(match[1]) as { jsToken?: string };
    if (!state.jsToken) return null;

    const decoded = decodeURIComponent(state.jsToken);
    const tokenMatch = decoded.match(/fn\("([^"]+)"\)/);
    return tokenMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

/* ================= Cache helpers ================= */
async function getCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  return caches.open("terabox-api");
}

function buildCacheKey(shareUrl: string): string {
  // 僅依賴 data 本身，忽略 proxy / download / query 順序
  return `https://cache.terabox.local/meta?data=${encodeURIComponent(shareUrl)}`;
}

async function getFromCache(key: string) {
  const cache = await getCache();
  if (!cache) return null;

  const res = await cache.match(key);
  if (!res) return null;

  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function putToCache(key: string, value: unknown, ttl = 600) {
  const cache = await getCache();
  if (!cache) return;

  const res = new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`
    }
  });

  await cache.put(key, res);
}

/* ================= GET ================= */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const shareUrl = searchParams.get("data");

  if (!shareUrl) {
    return NextResponse.json(
      { error: "Missing data" },
      { status: 400, headers: corsHeaders }
    );
  }

  const cacheKey = buildCacheKey(shareUrl);
  const cached = await getFromCache(cacheKey);

  /* ===== Cache HIT ===== */
  if (cached) {
    const hitHeaders = { ...corsHeaders, "X-Cache": "HIT" };

    if (searchParams.has("proxy")) {
      return proxyDownload(req, cached.direct_link);
    }
    if (searchParams.has("download")) {
      return NextResponse.redirect(cached.direct_link, 302);
    }
    return NextResponse.json(cached, { headers: hitHeaders });
  }

  /* ===== Cache MISS ===== */
  try {
    const headers = new Headers({
      "User-Agent": process.env.USER_AGENT ?? "Mozilla/5.0"
    });
    if (process.env.COOKIE) headers.set("Cookie", process.env.COOKIE);

    const pageRes = await fetchFollowWithCookies(shareUrl, headers);
    const html = await pageRes.text();

    const jsToken = extractJsToken(html);
    if (!jsToken) {
      return NextResponse.json(
        { error: "Missing jsToken" },
        { status: 400, headers: { ...corsHeaders, "X-Cache": "BYPASS" } }
      );
    }

    const pageURL = new URL(pageRes.url);
    const surl =
      pageURL.searchParams.get("surl") ||
      pageURL.pathname.match(/^\/s\/([^/?]+)/)?.[1];

    if (!surl) {
      return NextResponse.json(
        { error: "Missing surl" },
        { status: 400, headers: { ...corsHeaders, "X-Cache": "BYPASS" } }
      );
    }

    const apiUrl =
      `https://www.1024tera.com/share/list` +
      `?app_id=250528&web=1&channel=dubox&clienttype=0` +
      `&jsToken=${encodeURIComponent(jsToken)}` +
      `&page=1&num=20&order=asc&shorturl=${surl}&root=1`;

    headers.set("Referer", "https://www.1024tera.com/");
    headers.set("X-Requested-With", "XMLHttpRequest");

    const listRes = await fetchFollowWithCookies(apiUrl, headers);
    const json = (await listRes.json()) as ShareListResponse;

    const file = json.list?.[0];
    if (!file?.dlink) {
      return NextResponse.json(
        { error: "File not found" },
        { status: 404, headers: { ...corsHeaders, "X-Cache": "BYPASS" } }
      );
    }

    headers.delete("Referer");
    headers.delete("X-Requested-With");

    const headRes = await fetchFollowWithCookies(file.dlink, headers, "HEAD");

    const result = {
      file_name: file.server_filename ?? "",
      link: file.dlink,
      direct_link: headRes.url,
      thumb: file.thumbs?.url3 ?? "",
      size: getFormattedSize(Number(file.size)),
      sizebytes: Number(file.size) || 0
    };

    await putToCache(cacheKey, result);

    if (searchParams.has("proxy")) return proxyDownload(req, result.direct_link);
    if (searchParams.has("download")) return NextResponse.redirect(result.direct_link, 302);

    return NextResponse.json(result, {
      headers: { ...corsHeaders, "X-Cache": "MISS" }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown Error" },
      { status: 500, headers: { ...corsHeaders, "X-Cache": "BYPASS" } }
    );
  }
}

/* ================= OPTIONS ================= */
export function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

/* ================= Proxy download ================= */
async function proxyDownload(req: NextRequest, url: string): Promise<Response> {
  const headers = new Headers({
    "User-Agent": process.env.USER_AGENT ?? "Mozilla/5.0"
  });

  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  const upstream = await fetch(url, { headers });

  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (k.startsWith("content") || k === "accept-ranges") {
      resHeaders.set(k, v);
    }
  });

  resHeaders.set("Access-Control-Allow-Origin", "*");
  resHeaders.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  resHeaders.set("Access-Control-Expose-Headers", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders
  });
}