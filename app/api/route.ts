export const runtime = "edge";
import axios from "axios";
import { NextRequest, NextResponse } from "next/server";
import { env } from "process";

function getFormattedSize(sizeBytes: number) {
  let size, unit;

  if (sizeBytes >= 1024 * 1024) {
    size = sizeBytes / (1024 * 1024);
    unit = "MB";
  } else if (sizeBytes >= 1024) {
    size = sizeBytes / 1024;
    unit = "KB";
  } else {
    size = sizeBytes;
    unit = "bytes";
  }

  return `${size.toFixed(2)} ${unit}`;
}

if (!env.COOKIE) {
  throw new Error("Missing COOKIE in env");
}

interface ResponseData {
  file_name: string;
  link: string;
  direct_link: string;
  thumb: string;
  size: string;
  sizebytes: number;
}

function findBetween(str: string, start: string, end: string) {
  const startIndex = str.indexOf(start) + start.length;
  const endIndex = str.indexOf(end, startIndex);
  return str.substring(startIndex, endIndex);
}

export async function GET(req: NextRequest, res: NextResponse) {
  const { searchParams } = new URL(req.url);
  if (!searchParams.has("data")) {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }
  const link = searchParams.get("data");
  if (!link) {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }
  const userAgent = env["USER-AGENT"] || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
  const headers = new Headers({ "User-Agent": userAgent });
  env.COOKIE ? (headers.set("Cookie", env.COOKIE)) : false;
  headers.set("Host", "www.terabox.com");
  headers.set("Referer", "https://www.terabox.com/");
  try {
    const response1 = await fetch(link, { method: "GET", headers: headers } );
    if (!response1)
      return NextResponse.json({ error: "Parsing Link Error" }, { status: 400 });
    let { searchParams: searchParams1, href } = new URL(response1.url);
    if (!searchParams1.has("surl")) {
      return NextResponse.json({ error: "Missing surl" }, { status: 400 });
    }
    const surl = searchParams1.get("surl");
    const text1 = await response1.text();
    const jsToken = findBetween(text1, "fn%28%22", "%22%29");
    const bdstoken = findBetween(text1, 'bdstoken":"', '"');
    if (!jsToken || !bdstoken) {
      return NextResponse.json({ error: "Invalid Response" }, { status: 400 });
    }
    
    let searchParams2 = "?app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=";
    let response2Url = "https://www.terabox.com/share/list";
    if (searchParams.has("nephobox")) {
        headers.set("User-Agent", "netdisk;P2SP;1.0.0.10");
        headers.set("Host", "nephobox.com");
        headers.set("Referer", "http://nephobox.com/");
        searchParams2 = "?app_id=250528&clienttype=9&jsToken=";
        response2Url = "http://nephobox.com/share/list";
    }
    searchParams2 = searchParams2.concat(jsToken ?? "", "&page=1&num=20&by=name&order=asc&site_referer=", encodeURIComponent(href ?? ""), "&shorturl=", surl ?? "", "&root=1");
    const response2 = await fetch(response2Url + searchParams2, { method: "GET", headers: headers });
    const json2 = await response2.json();
    if (!json2 || !("list" in json2)) {
      return NextResponse.json({ error: "Parsing JSON Error" }, { status: 400 });
    }

    if (searchParams.has("proxy")) {
        try {
          let response1 = await fetch(json2["list"][0]["dlink"], { headers: headers });
          if (!response1.ok)
            return NextResponse.json({ error: "Upstream Error" }, { status: 400 });
          const proxyHeaders = new Headers(response1.headers);
          proxyHeaders.set("Access-Control-Allow-Methods", "*");
          proxyHeaders.set("Access-Control-Allow-Origin", "*");
          proxyHeaders.set("Access-Control-Expose-Headers", "*");
          return new NextResponse(response1.body, { headers: proxyHeaders });
        } catch (error) {
          return NextResponse.json({ error: "Failed to proxy download" }, { status: 400 });
        }
    }

    const shouldFetch = !searchParams.has("nodirectlink");
    const response3 = shouldFetch ? await fetch(json2.list[0].dlink, { method: "HEAD", headers }) : null;
    const direct_link = response3?.url ?? null;
    
    let thumb = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    if (json2["list"][0]["thumbs"]) {
        thumb = json2["list"][0]["thumbs"]["url3"];
    }
    const data: ResponseData = {
      file_name: json2["list"][0]["server_filename"],
      link: json2["list"][0]["dlink"],
      direct_link: direct_link ?? "",
      thumb: thumb,
      size: getFormattedSize(parseInt(json2["list"][0]["size"])),
      sizebytes: parseInt(json2["list"][0]["size"]),
    };
    
    if (searchParams.has("download")) {
        if (direct_link === null) {
            return NextResponse.json({ error: "No direct_link! Maybe you used with nodirectlink." }, { status: 400 });
        }
        return NextResponse.redirect(direct_link, 302);
    }
    let response = NextResponse.json(data, { status: 200 });
    response.headers.set("Access-Control-Allow-Methods", "*");
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Expose-Headers", "*");
    response.headers.set("Cache-Control", "no-store, must-revalidate");
    return response;
  } catch (error) {
    return NextResponse.json({ error: "Unknown Error" }, { status: 400 });
  }
}
