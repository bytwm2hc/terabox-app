export interface Env {
  COOKIE_KV: KVNamespace;
  USER_AGENT?: string;
}

/* ========= utils ========= */

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

function normalizeCookie(cookie: string) {
  return cookie
    .split(";")
    .map(v => v.trim())
    .filter(Boolean)
    .sort()
    .join("; ");
}

/* ========= fetch with redirect + cookie ========= */

async function fetchFollowWithCookies(
  url: string,
  headers: Headers,
  maxRedirects = 10
): Promise<{ response: Response; cookie: string }> {
  let current = url;
  let cookieStore = headers.get("Cookie") ?? "";

  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(current, {
      headers,
      redirect: "manual",
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      cookieStore += (cookieStore ? "; " : "") + setCookie;
      headers.set("Cookie", cookieStore);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { response: res, cookie: cookieStore };
      current = loc.startsWith("http") ? loc : new URL(loc, current).toString();
      continue;
    }

    return { response: res, cookie: cookieStore };
  }

  throw new Error("Too many redirects");
}

/* ========= proxy download ========= */

async function proxyDownload(
  req: Request,
  url: string,
  headers: Headers
): Promise<Response> {
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  const upstream = await fetchFollowWithCookies(url, headers);
  const res = upstream.response;

  if (!res.ok && res.status !== 206) {
    throw new Error(`Upstream error: ${res.status}`);
  }

  const outHeaders = new Headers();
  res.headers.forEach((v, k) => {
    if (
      k.toLowerCase().startsWith("content") ||
      k.toLowerCase() === "accept-ranges"
    ) {
      outHeaders.set(k, v);
    }
  });

  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Access-Control-Expose-Headers", "*");

  return new Response(res.body, {
    status: res.status,
    headers: outHeaders,
  });
}

/* ========= handler ========= */

interface ListResponse {
  list: Array<{
    dlink: string;
    server_filename: string;
    size: string;
    thumbs?: { url3: string };
  }>;
}

export async function onRequest(
  context: { request: Request; env: Env }
): Promise<Response> {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const link = url.searchParams.get("data");

    if (!link) {
      return new Response(JSON.stringify({ error: "Missing data" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    /* ===== headers ===== */

    const headers = new Headers({
      "User-Agent":
        env.USER_AGENT ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143",
      Referer: "https://1024terabox.com/",
    });

    /* ===== load cookie from KV ===== */

    const oldCookie = (await env.COOKIE_KV.get("cookie")) ?? "";
    if (oldCookie) headers.set("Cookie", oldCookie);
    let finalCookie = oldCookie;

    /* ===== step 1: share page ===== */

    const pageResObj = await fetchFollowWithCookies(link, headers);
    finalCookie = pageResObj.cookie;

    const pageRes = pageResObj.response;
    const finalUrl = new URL(pageRes.url);

    const surl = finalUrl.searchParams.get("surl");
    if (!surl) {
      return new Response(JSON.stringify({ error: "Missing surl" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const html = await pageRes.text();
    const jsToken = findBetween(html, "fn%28%22", "%22%29");
    if (!jsToken) {
      return new Response(JSON.stringify({ error: "Missing jsToken" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    /* ===== step 2: list api ===== */

    const api =
      "https://www.terabox.com/share/list" +
      `?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${jsToken}` +
      `&page=1&num=20&order=asc&shorturl=${surl}&root=1`;

    const listResObj = await fetchFollowWithCookies(api, headers);
    finalCookie = listResObj.cookie;

    if (normalizeCookie(finalCookie) !== normalizeCookie(oldCookie)) {
      await env.COOKIE_KV.put("cookie", finalCookie);
    }

    const json = (await listResObj.response.json()) as ListResponse;
    if (!json.list?.length) {
      return new Response(JSON.stringify({ error: "Empty list" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const file = json.list[0];

    /* ===== proxy mode ===== */

    if (url.searchParams.has("proxy")) {
      return await proxyDownload(request, file.dlink, headers);
    }

    /* ===== direct link ===== */

    let direct_link = "";
    if (!url.searchParams.has("nodirectlink")) {
      const d = await fetchFollowWithCookies(file.dlink, headers);
      direct_link = d.response.url;
    }

    if (url.searchParams.has("download")) {
      return Response.redirect(direct_link, 302);
    }

    /* ===== response ===== */

    return new Response(
      JSON.stringify({
        file_name: file.server_filename,
        link: file.dlink,
        direct_link,
        thumb: file.thumbs?.url3 ?? "",
        size: getFormattedSize(+file.size),
        sizebytes: +file.size,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message ?? "Unknown Error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
