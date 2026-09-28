/*
 * Cloudflare Workers Proxy
 * Solves: Mixed Content, Bot Detection, Protocol Issues, Proxy Connection Failures
 */

interface Env {
  TARGET_HOST: string;
  TARGET_SCHEME: string;
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
  Connection: "keep-alive",
};

function sanitizeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (!parsed.protocol || !parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

function rewriteHtmlAssetUrls(html: string, proxyBaseUrl: string): string {
  let rewritten = html;

  // Rewrite all src, href, srcset attributes to proxy through this worker
  rewritten = rewritten.replace(/\b(src|href|srcset)=["']([^"']+)["']/g, (match, attr, url) => {
    // Skip data URIs, anchors, and javascript
    if (url.startsWith("data:") || url.startsWith("#") || url.startsWith("javascript:")) {
      return match;
    }

    // If it's a relative URL, make it absolute
    let absoluteUrl = url;
    if (url.startsWith("/")) {
      absoluteUrl = `https://crazygames.com${url}`;
    } else if (!url.startsWith("http")) {
      absoluteUrl = `https://crazygames.com/${url}`;
    }

    const proxiedUrl = `${proxyBaseUrl}?url=${encodeURIComponent(absoluteUrl)}`;
    return `${attr}="${proxiedUrl}"`;
  });

  return rewritten;
}

function buildUpstreamHeaders(request: Request, targetHost: string): Record<string, string> {
  const headers = new Headers(BROWSER_HEADERS);

  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("Cookie", cookie);

  headers.set("Host", targetHost);
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  return Object.fromEntries(headers);
}

async function proxyRequest(url: URL, request: Request, env: Env): Promise<Response> {
  const upstreamHeaders = buildUpstreamHeaders(request, env.TARGET_HOST);
  const upstreamRequest = new Request(url, {
    method: request.method,
    headers: upstreamHeaders,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : null,
  });

  try {
    const response = await fetch(upstreamRequest);
    const contentType = response.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");

    if (isHtml) {
      let html = await response.text();
      html = rewriteHtmlAssetUrls(html, "/proxy");

      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...Object.fromEntries(response.headers),
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      });
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    });
  } catch (error) {
    console.error("Upstream fetch failed:", error);
    return new Response("Gateway Error: Could not reach upstream", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

function handleHealth(env: Env): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      target: `${env.TARGET_SCHEME}://${env.TARGET_HOST}`,
      timestamp: new Date().toISOString(),
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return handleHealth(env);
  }

  if (url.pathname === "/proxy") {
    const rawUrl = url.searchParams.get("url");
    if (!rawUrl) {
      return new Response("Missing ?url= parameter", { status: 400 });
    }

    const target = sanitizeUrl(rawUrl);
    if (!target) {
      return new Response("Invalid URL", { status: 400 });
    }

    // Allow all URLs to be proxied
    return proxyRequest(target, request, env);
  }

  // For any other path, proxy it to the target host
  const targetUrl = new URL(url.pathname + url.search, `${env.TARGET_SCHEME}://${env.TARGET_HOST}`);
  return proxyRequest(targetUrl, request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
