const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
};

const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
const FETCH_TIMEOUT = 10000; // 10 secounds
const MAX_REDIRECTS = 5;
const CACHE_TTL = 3600 * 1000; // 1 hour

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

function getTemplateData(text) {
  const match = text.match(/var\s+templateData\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return null;
  }
}

function getJsToken(text) {
  const m = text.match(/%22([\s\S]*?)%22/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function fetchFollowCookies(url, headers, method = "GET", maxRedirects = MAX_REDIRECTS) {
  let cookieStore = headers["Cookie"] || "";
  let currentUrl = url;

  for (let i = 0; i < maxRedirects; i++) {
    console.log(currentUrl);
    const hdrs = { ...headers };
    if (cookieStore) hdrs["Cookie"] = cookieStore;

    const res = await fetchWithTimeout(currentUrl, {
      headers: hdrs,
      method: method,
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
    const fid = params.fid;
    const download = params.download;

    if (!fid)
      return {
        statusCode: 400,
        headers: { CORS_HEADERS, "Content-Type": "application/json; charset=UTF-8", },
        body: JSON.stringify({ error: "Missing fid" }),
      };

    const cached = getCache(fid);
    if (cached && !download)
      return {
        statusCode: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json; charset=UTF-8",
          "Netlify-Functions-Cache": "HIT",
        },
        body: JSON.stringify(cached),
      };
    if (cached && download)
      return {
        statusCode: 302,
        headers: { ...CORS_HEADERS,
          Location: cached.direct_link,
          "Netlify-Functions-Cache": "HIT",
        },
        body: "",
      };

    const headers = {
      "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.terabox.app/main",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Upgrade-Insecure-Requests": "0",
      "User-Agent": USER_AGENT,
    };
    
    if (process.env.COOKIE) headers["Cookie"] = process.env.COOKIE;

    let pageRes;
    // Step 1: Get jsToken and bdstoken
    pageRes = await fetchFollowCookies("http://www.terabox.app/main", headers);
    const html = await pageRes.text();
    const templateData = getTemplateData(html);
    const jsToken = getJsToken(templateData.jsToken);
    if (!jsToken)
      return {
        statusCode: 500,
        headers: { CORS_HEADERS, "Content-Type": "application/json; charset=UTF-8", },
        body: JSON.stringify({ error: "jsToken not found" }),
      };
    if (!templateData.bdstoken)
      return {
        statusCode: 500,
        headers: { CORS_HEADERS, "Content-Type": "application/json; charset=UTF-8", },
        body: JSON.stringify({ error: "bdstoken not found" }),
      };

    // Step 2: Get info
    pageRes = await fetchFollowCookies("http://www.terabox.app/api/home/info?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=" +
    jsToken, headers);
    const info = await pageRes.json();
    const src = info?.data?.sign2?.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const s = new Function(`return ${src}`)(); // s(j, r)
    const signature = btoa(s(info?.data?.sign3, info?.data?.sign1));

    // Step 3: Get download
    pageRes = await fetchFollowCookies(
      "http://www.terabox.app/api/download?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=" + jsToken +
      "&fidlist=[" + fid + "]&type=dlink&vip=2&sign=" + signature + "&timestamp=" +  info?.data?.timestamp +
      "&need_speed=0&bdstoken=" + templateData.bdstoken, headers);
    const download2 = await pageRes.json();
    const file = download2?.dlink[0]?.dlink;
    if (!file)
      return {
        statusCode: 404,
        headers: { CORS_HEADERS, "Content-Type": "application/json; charset=UTF-8", },
        body: JSON.stringify({ error: "File not found" }),
      };

    // Step 4: Get direct link
    headers.Range = "bytes=0-0";
    const headRes = await fetchFollowCookies(file, headers);
    const direct_link = headRes.url;

    const result = {
      fs_id: download2?.dlink[0]?.fs_id,
      dlink: download2?.dlink[0]?.dlink,
      direct_link,
      filename: download2?.file_info?.filename || "",
      size: download2?.file_info?.size || 0,
    };

    setCache(fid, result);

    // -------------------- download 支援 --------------------
    if (download)
      return {
        statusCode: 302,
        headers: { ...CORS_HEADERS,
          Location: direct_link,
          "Netlify-Functions-Cache": "MISS",
          "Netlify-CDN-Cache-Control": "public, durable, max-age=3600",
          "Netlify-Vary": "query",
        },
        body: "",
      };

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS,
        "Content-Type": "application/json; charset=UTF-8",
        "Netlify-Functions-Cache": "MISS",
        "Netlify-CDN-Cache-Control": "public, durable, max-age=3600",
        "Netlify-Vary": "query",
      },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { CORS_HEADERS, "Content-Type": "application/json; charset=UTF-8", },
      body: JSON.stringify({
        error: err?.name === "AbortError" ? "Timeout" : err?.message,
      }),
    };
  }
}