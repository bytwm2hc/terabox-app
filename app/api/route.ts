import { NextRequest, NextResponse } from "next/server";
// Edge Runtime
export const runtime = "edge";
export const dynamic = "force-dynamic";

/* ================= 1. 工具函數 ================= */

function getFormattedSize(bytes: number) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function extractToken(html: string) {
  const patterns = [/fn\("(.+?)"\)/, /fn%28%22(.+?)%22%29/, /"jsToken":"(.+?)"/];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

async function fetchFollowWithCookies(
  url: string,
  baseHeaders: Headers,
  maxRedirects = 10
): Promise<Response> {
  let currentUrl = url;
  let cookieStore = baseHeaders.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    const headers = new Headers(baseHeaders);
    if (cookieStore) headers.set("Cookie", cookieStore);

    const res = await fetch(currentUrl, { headers, redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const cookies = setCookie.split(/,(?=[^;]+?=)/).map(s => s.split(";")[0].trim());
      cookieStore = [...new Set([...cookieStore.split("; "), ...cookies])].join("; ");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error("跳轉次數過多");
}

/* ================= 2. GET Handler ================= */

export async function GET(req: NextRequest) {
  try {
    const { searchParams, origin } = new URL(req.url);
    const link = searchParams.get("data");

    if (!link) return NextResponse.json({ error: "請提供有效連結" }, { status: 400 });

    // --- A. 快取讀取 ---
    // 將 caches 轉型為 any，繞過標準 Web 類型的檢查
    const cache = (caches as any).default; 

    const cacheUrl = new URL(`${origin}/api/_cache/terabox`);
    cacheUrl.searchParams.set("q", link);
    const cacheKey = new Request(cacheUrl.toString());

    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const headers = new Headers(cachedResponse.headers);
      headers.set("X-Cache-Status", "HIT");
      return new Response(cachedResponse.body, { headers });
    }

    // --- B. 正常解析邏輯 ---
    const baseHeaders = new Headers({
      "User-Agent": process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": "https://1024terabox.com/",
    });

    if (process.env.COOKIE) baseHeaders.set("Cookie", process.env.COOKIE);

    const pageRes = await fetchFollowWithCookies(link, baseHeaders);
    const html = await pageRes.text();
    const surl = new URL(pageRes.url).searchParams.get("surl");
    if (!surl) throw new Error("解析連結失敗 (Missing surl)");

    const jsToken = extractToken(html);
    if (!jsToken) throw new Error("無法獲取 jsToken (Cookie 可能失效)");

    const listApi = `https://www.terabox.com/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${jsToken}&page=1&num=20&order=asc&shorturl=${surl}&root=1`;
    const listHeaders = new Headers(baseHeaders);
    listHeaders.set("Referer", pageRes.url);

    const listRes = await fetchFollowWithCookies(listApi, listHeaders);
    const json = await listRes.json() as any;
    if (!json?.list?.[0]) throw new Error("檔案列表為空");

    const file = json.list[0];
    const dlinkRes = await fetchFollowWithCookies(file.dlink, listHeaders);
    const direct_link = dlinkRes.url;

    const resultData = {
      file_name: file.server_filename,
      link: file.dlink,
      direct_link,
      thumb: file.thumbs?.url3 || file.thumbs?.url1 || "",
      size: getFormattedSize(+file.size),
      sizebytes: +file.size,
      timestamp: Date.now()
    };

    // --- C. 生成回應 ---
    const responseHeaders = new Headers({
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600",
      "X-Cache-Status": "MISS"
    });

    const response = new Response(JSON.stringify(resultData), {
      status: 200, // 只有 200 會進入快取寫入條件
      headers: responseHeaders,
    });

    // --- D. 修正後的快取寫入：確保只快取成功結果 ---
    if (req.method === "GET") {
      // 僅針對成功回應進行克隆與存儲
      const cacheToStore = response.clone();
      
      // 使用 try/catch 包圍 cache.put，避免存儲失敗影響用戶返回
      // 雖然 Route Handler 沒有顯式的 event.waitUntil，但 Edge Runtime 會嘗試完成背景 promise
      (async () => {
        try {
          await cache.put(cacheKey, cacheToStore);
        } catch (e) {
          console.error("Cache Write Error:", e);
        }
      })();
    }

    return response;

  } catch (error: any) {
    // 錯誤回應不設置 Cache-Control 中的 s-maxage，或設置為 no-store
    return NextResponse.json(
      { error: error?.message || "Internal Server Error" }, 
      { 
        status: 500,
        headers: { "Cache-Control": "no-store" } // 確保錯誤不被快取
      }
    );
  }
}