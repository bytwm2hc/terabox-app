const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
};

const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const FETCH_TIMEOUT = 5000; // 5 秒 timeout
const MAX_REDIRECTS = 5;
const CACHE_TTL = 10 * 60 * 1000; // 10 分鐘

const globalCache =
  globalThis.__TERABOX_CACHE__ ?? (globalThis.__TERABOX_CACHE__ = new Map());

function getCache(key) {
  const hit = globalCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expire) {
    globalCache.delete(key);
    return null;
  }
  return hit.data;
}

function setCache(key, data) {
  globalCache.set(key, { data, expire: Date.now() + CACHE_TTL });
}

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractJsToken(html) {
  const m = html.match(/decodeURIComponent\(\s*`([^`]+)`\s*\)/);
  if (!m) return null;
  try {
    const decoded = decodeURIComponent(m[1]);
    const token = decoded.match(/["']([A-F0-9]{32,})["']/);
    return token?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchFollowCookies(url, headers, maxRedirects = MAX_REDIRECTS) {
  let cookieStore = headers["Cookie"] || "";
  let currentUrl = url;

  for (let i = 0; i < maxRedirects; i++) {
    const hdrs = { ...headers };
    if (cookieStore) hdrs["Cookie"] = cookieStore;

    const res = await fetchWithTimeout(currentUrl, {
      headers: hdrs,
      redirect: "manual",
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      if (!cookieStore.includes(pair))
        cookieStore += (cookieStore ? "; " : "") + pair;
    }

    if (!(res.status >= 300 && res.status < 400)) return res;

    const loc = res.headers.get("location");
    if (!loc) return res;
    currentUrl = loc.startsWith("http") ? loc : new URL(loc, currentUrl).href;
  }

  throw new Error("Too many redirects");
}

// -------------------- Lambda Handler --------------------
export async function handler(event) {
  try {
    const params = event.queryStringParameters || {};
    const shareUrl = params.data;
    const download = params.download;

    if (!shareUrl)
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing data" }),
      };

    const cached = getCache(shareUrl);
    if (cached && !download)
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" },
        body: JSON.stringify(cached),
      };

    const headers = { "User-Agent": USER_AGENT };
    if (process.env.COOKIE) headers["Cookie"] = process.env.COOKIE;

    // Step 1：抓 HTML
    const pageRes = await fetchFollowCookies(shareUrl, headers);
    const html = await pageRes.text();

    const jsToken = extractJsToken(html);
    if (!jsToken)
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "jsToken not found" }),
      };

    const pageURL = new URL(pageRes.url);
    const surl =
      pageURL.searchParams.get("surl") ||
      pageURL.pathname.match(/^\/s\/([^/?]+)/)?.[1];
    if (!surl)
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "surl not found" }),
      };

    // Step 2：List API
    const apiUrl =
      `https://www.terabox.app/share/list?app_id=250528&web=1&channel=dubox&clienttype=0` +
      `&jsToken=${encodeURIComponent(jsToken)}&page=1&num=1&order=asc&shorturl=${surl}&root=1`;

    const apiRes = await fetchFollowCookies(apiUrl, {
      ...headers,
      Referer: "https://www.terabox.app/",
      "X-Requested-With": "XMLHttpRequest",
    });

    const json = await apiRes.json();
    const file = json?.list?.[0];
    if (!file?.dlink)
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "File not found" }),
      };

    // Step 3：HEAD 確認 direct link
    const headRes = await fetchFollowCookies(file.dlink, headers, 3);
    const direct_link = headRes.url;

    const result = {
      file_name: file.server_filename || "",
      link: file.dlink,
      direct_link,
      size: Number(file.size) || 0,
      thumb: file.thumbs?.url3 || "",
    };

    setCache(shareUrl, result);

    // -------------------- download 支援 --------------------
    if (download)
      return {
        statusCode: 302,
        headers: { Location: direct_link },
        body: "",
      };

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: err?.name === "AbortError" ? "Timeout" : err?.message,
      }),
    };
  }
}