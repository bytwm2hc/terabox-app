import { NextRequest, NextResponse } from "next/server";

//export const runtime = "edge";
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
  // 1️⃣ 找出 encodeURIComponent(...) 裡的 payload
  const encodedMatch = html.match(
    /decodeURIComponent\(\s*`([^`]+)`\s*\)/
  );
  if (!encodedMatch) return null;

  // 2️⃣ decode
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedMatch[1]);
  } catch {
    return null;
  }

  // 3️⃣ 抓 token（hex / 高熵字串）
  const tokenMatch = decoded.match(
    /["']([A-F0-9]{32,})["']/
  );

  return tokenMatch?.[1] ?? null;
}

async function fetchFollowWithCookies(
  url: string,
  baseHeaders: Headers,
  method: string = "GET",
  maxRedirects = 5
): Promise<Response> {
  let currentUrl = url;
  let cookieStore = baseHeaders.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    // ⚠️ 每一跳都 new Headers（Edge-safe）
    const headers = new Headers();

    baseHeaders.forEach((v, k) => {
      if (k.toLowerCase() !== "cookie") {
        headers.set(k, v);
      }
    });

    if (cookieStore) {
      headers.set("Cookie", cookieStore);
    }

    const res = await fetch(currentUrl, {
      method,
      headers,
      redirect: "manual",
    });

    // ⚠️ Edge 有時拿不到 set-cookie，要容錯
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const cookiePair = setCookie.split(";")[0];
      if (!cookieStore.includes(cookiePair)) {
        cookieStore += (cookieStore ? "; " : "") + cookiePair;
      }
    }

    // redirect handling
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;

      currentUrl = location.startsWith("http")
        ? location
        : new URL(location, currentUrl).href;

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
    const apiUrl = `http://www.terabox.app/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${encodeURIComponent(
      jsToken
    )}&page=1&num=20&by=name&order=asc&site_referer=&shorturl=${surl}&root=1`;

    headers.set("Referer", "http://www.terabox.app/");
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
      "HEAD",
      3
    );
    // ⚠️ 立刻取消 body（避免 Edge 下載檔案）
    try {
        dlinkRes.body?.cancel();
    } catch {}
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