import { NextRequest, NextResponse } from "next/server";

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

type JsonResult = {
  file_name: string;
  link: string;
  direct_link: string;
  thumb: string;
  size: string;
  sizebytes: number;
};

/* ================= Config ================= */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
};

const CACHE_TTL = 25 * 60 * 1000; // 25 min

const cacheHeaders = {
  ...corsHeaders,
  "Cache-Control": "no-store, must-revalidate",
  "Netlify-CDN-Cache-Control":
    "public, durable, s-maxage=1800, stale-while-revalidate=3600",
  "Netlify-Vary": "query",
};

/* ================= Memory Cache ================= */
type CacheEntry = {
  expire: number;
  data: JsonResult;
};

const globalCache =
  (globalThis as any).__TERABOX_CACHE__ ??
  ((globalThis as any).__TERABOX_CACHE__ = new Map<string, CacheEntry>());

function getCache(key: string): JsonResult | null {
  const hit = globalCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expire) {
    globalCache.delete(key);
    return null;
  }
  return hit.data;
}

function setCache(key: string, data: JsonResult) {
  globalCache.set(key, {
    data,
    expire: Date.now() + CACHE_TTL,
  });
}

/* ================= Utils ================= */
function getFormattedSize(bytes?: number): string {
  if (!Number.isFinite(bytes ?? NaN)) return "Unknown";
  if ((bytes ?? 0) >= 1024 * 1024)
    return ((bytes ?? 0) / 1024 / 1024).toFixed(2) + " MB";
  if ((bytes ?? 0) >= 1024)
    return ((bytes ?? 0) / 1024).toFixed(2) + " KB";
  return (bytes ?? 0) + " bytes";
}

function extractJsToken(html: string): string | null {
  const encodedMatch = html.match(
    /decodeURIComponent\(\s*`([^`]+)`\s*\)/
  );
  if (!encodedMatch) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedMatch[1]);
  } catch {
    return null;
  }

  const tokenMatch = decoded.match(/["']([A-F0-9]{32,})["']/);
  return tokenMatch?.[1] ?? null;
}

async function fetchFollowWithCookies(
  url: string,
  baseHeaders: Headers,
  method = "GET",
  maxRedirects = 5
): Promise<Response> {
  let currentUrl = url;
  let cookieStore = baseHeaders.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    const headers = new Headers();
    baseHeaders.forEach((v, k) => {
      if (k.toLowerCase() !== "cookie") headers.set(k, v);
    });
    if (cookieStore) headers.set("Cookie", cookieStore);

    const res = await fetch(currentUrl, {
      method,
      headers,
      redirect: "manual",
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      if (!cookieStore.includes(pair)) {
        cookieStore += (cookieStore ? "; " : "") + pair;
      }
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      currentUrl = loc.startsWith("http")
        ? loc
        : new URL(loc, currentUrl).href;
      continue;
    }

    return res;
  }

  throw new Error("Too many redirects");
}

/* ================= Handler ================= */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const shareUrl = searchParams.get("data");
    if (!shareUrl)
      return NextResponse.json(
        { error: "Missing data" },
        { status: 400, headers: corsHeaders }
      );

    const headers = new Headers({
      "User-Agent":
        process.env.USER_AGENT ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });
    if (process.env.COOKIE) headers.set("Cookie", process.env.COOKIE);

    /* Step 1：先抓 HTML（只為了 surl + token） */
    const pageRes = await fetchFollowWithCookies(shareUrl, headers);
    const html = await pageRes.text();

    const jsToken = extractJsToken(html);
    if (!jsToken)
      return NextResponse.json(
        { error: "Missing jsToken" },
        { status: 500, headers: corsHeaders }
      );

    const pageURL = new URL(pageRes.url);
    const surl =
      pageURL.searchParams.get("surl") ||
      pageURL.pathname.match(/^\/s\/([^/?]+)/)?.[1];

    if (!surl)
      return NextResponse.json(
        { error: "Missing surl" },
        { status: 500, headers: corsHeaders }
      );

    /* 🚀 Cache hit */
    const cached = getCache(surl);
    if (cached) {
      return NextResponse.json(cached, { headers: cacheHeaders });
    }

    /* Step 2：List API */
    const apiUrl = `http://www.terabox.app/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${encodeURIComponent(
      jsToken
    )}&page=1&num=20&by=name&order=asc&site_referer=&shorturl=${surl}&root=1`;

    headers.set("Referer", "http://www.terabox.app/");
    headers.set("X-Requested-With", "XMLHttpRequest");

    const listRes = await fetchFollowWithCookies(apiUrl, headers);
    const json = (await listRes.json()) as ShareListResponse;

    const file = json?.list?.[0];
    if (!file?.dlink)
      return NextResponse.json(
        { error: "File not found" },
        { status: 404, headers: corsHeaders }
      );

    /* Step 3：Resolve direct link */
    headers.delete("Referer");
    headers.delete("X-Requested-With");

    const dlinkRes = await fetchFollowWithCookies(
      file.dlink,
      headers,
      "HEAD",
      3
    );

    try {
      dlinkRes.body?.cancel();
    } catch {}

    const direct_link = dlinkRes.url;
    if (!direct_link)
      return NextResponse.json(
        { error: "Direct link failed" },
        { status: 502, headers: corsHeaders }
      );

    const result: JsonResult = {
      file_name: file.server_filename ?? "",
      link: file.dlink,
      direct_link,
      thumb: file.thumbs?.url3 ?? "",
      size: getFormattedSize(Number(file.size)),
      sizebytes: Number(file.size) || 0,
    };

    /* 💾 Store cache */
    setCache(surl, result);

    if (searchParams.has("download"))
      return NextResponse.redirect(direct_link, 302);

    return NextResponse.json(result, { headers: cacheHeaders });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown Error" },
      { status: 500, headers: corsHeaders }
    );
  }
}