export async function handler(event) {
  const query = event.rawQuery || ""
  const targetUrl = `https://www.terabox.app/api/streaming?${query}`

  const res = await fetch(targetUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
      "Cookie": process.env.COOKIE,
      "Accept": "*/*",
      "Referer": "https://www.terabox.app/",
    },
  })

  const body = await res.text()

  return {
    statusCode: res.status,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
    },
    body,
  }
}