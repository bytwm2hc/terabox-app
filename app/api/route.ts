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

type JsonResult = {
  file_name: string;
  link: string;
  direct_link: string;
  thumb: string;
  size: string;
  sizebytes: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
};

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

    const res = await fetch(current, {
      headers: hdrs,
      method,
      redirect: "manual",
    });

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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    });
    if (process.env.COOKIE) headers.set("Cookie", process.env.COOKIE);

    /* Step 1：抓分享頁 HTML */
    const pageRes = await fetchFollowWithCookies(shareUrl, headers);
    const html = await pageRes.text();

    const jsToken = extractJsToken(html);
    if (!jsToken)
      return NextResponse.json(
        { error: "Missing jsToken" },
        { status: pageRes.status, headers: corsHeaders }
      );

    /* Step 2：取得 surl */
    const pageURL = new URL(pageRes.url);
    const surl =
      pageURL.searchParams.get("surl") ||
      pageURL.pathname.match(/^\/s\/([^/?]+)/)?.[1];
    if (!surl)
      return NextResponse.json(
        { error: "Missing surl" },
        { status: pageRes.status, headers: corsHeaders }
      );

    /* Step 3：List API */
    const apiUrl = `https://www.1024tera.com/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${encodeURIComponent(
      jsToken
    )}&page=1&num=20&by=name&order=asc&site_referer=&shorturl=${surl}&root=1`;

    headers.set("Referer", "https://www.1024tera.com/");
    headers.set("X-Requested-With", "XMLHttpRequest");
    const listRes = await fetchFollowWithCookies(apiUrl, headers);
    const json = (await listRes.json()) as ShareListResponse;

    const file = json?.list?.[0];
    if (!file || !file.dlink)
      return NextResponse.json(
        { error: "File not found" },
        { status: listRes.status, headers: corsHeaders }
      );

    /* Step 4：Direct link */
    headers.delete("Referer");
    headers.delete("X-Requested-With");
    const dlinkRes = await fetchFollowWithCookies(
      file.dlink,
      headers,
      "HEAD"
    );
    const direct_link = dlinkRes.url;
    if (!direct_link)
      return NextResponse.json(
        { error: "Direct link failed" },
        { status: dlinkRes.status, headers: corsHeaders }
      );

    const result: JsonResult = {
      file_name: file.server_filename ?? "",
      link: file.dlink,
      direct_link,
      thumb: file.thumbs?.url3 ?? "",
      size: getFormattedSize(Number(file.size)),
      sizebytes: Number(file.size) || 0,
    };

    if (searchParams.has("download"))
      return NextResponse.redirect(direct_link, 302);

    return NextResponse.json(result, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown Error" },
      { status: 500, headers: corsHeaders }
    );
  }
}