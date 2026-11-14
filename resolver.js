import vm from "node:vm";
import { load } from "cheerio";
import { isSafePublicHost } from "./allowlist.js";
import { isPacked, unpackDeanEdwards } from "./packer.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchPageHtml(url, customHeaders = {}) {
  let html = "";
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...customHeaders,
      },
    });
    if (res.ok) html = await res.text();
  } catch {}

  if (!html || html.includes("<title>Just a moment...</title>") || html.includes("cf-browser-verification")) {
    try {
      const pr = await fetchWithTimeout(`https://r.jina.ai/${url}?_t=${Date.now()}`, {
        headers: { "X-Return-Format": "html", "X-No-Cache": "true" },
      });
      if (pr.ok) html = await pr.text();
    } catch {}
  }
  return html;
}

/**
 * Resolves 9stream player used by play.playkrx18.site
 */
export async function resolve9Stream(embedUrl, pageReferer) {
  const html = await fetchPageHtml(embedUrl, { referer: pageReferer });
  if (!html) throw new Error("Failed to load embed page");
  const $ = load(html);

  const fileMatch = html.match(/const\s+idfile_enc\s*=\s*["']([^"']+)["']/i);
  const userMatch = html.match(/const\s+idUser_enc\s*=\s*["']([^"']+)["']/i);
  const apiMatch = html.match(/const\s+DOMAIN_API\s*=\s*["']([^"']+)["']/i);
  const viewMatch = html.match(/const\s+DOMAIN_API_VIEW\s*=\s*["']([^"']+)["']/i);

  if (!fileMatch || !userMatch || !apiMatch) {
    throw new Error("Could not extract 9stream parameters from embed");
  }

  const idfile_enc = fileMatch[1];
  const idUser_enc = userMatch[1];
  const DOMAIN_API = apiMatch[1];
  const DOMAIN_API_VIEW = viewMatch ? viewMatch[1] : "";

  let appJsSrc = "";
  $("script").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (src.includes("appv1.js") || src.includes("app.js")) {
      appJsSrc = src;
    }
  });
  if (!appJsSrc) {
    appJsSrc = "https://js-9str.str0611.cfd/js/appv1.js?v2";
  }
  if (appJsSrc.startsWith("//")) appJsSrc = "https:" + appJsSrc;

  const appJsRes = await fetchWithTimeout(appJsSrc, {
    headers: { "user-agent": UA, referer: embedUrl },
  });
  if (!appJsRes.ok) throw new Error(`App JS fetch failed: status ${appJsRes.status}`);
  const appJsCode = await appJsRes.text();

  const embedHost = new URL(embedUrl).origin;
  const pageOrigin = new URL(pageReferer).origin;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("9stream resolution timed out"));
    }, 10000);

    const listeners = [];
    const sandbox = {
      idfile_enc,
      idUser_enc,
      data_subs: "",
      DOMAIN_API,
      DOMAIN_API_VIEW,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      crypto,
      atob: (s) => Buffer.from(s, "base64").toString("binary"),
      btoa: (s) => Buffer.from(s, "binary").toString("base64"),
      console: {
        log: (...args) => console.log("[9STR_LOG]", ...args),
        error: (...args) => console.error("[9STR_ERR]", ...args),
        warn: (...args) => console.warn("[9STR_WARN]", ...args),
      },
      fetch: async (url, opts) => {
        if (url.includes("view/")) return { ok: true, status: 200 };
        try {
          const r = await fetchWithTimeout(url, {
            ...opts,
            headers: {
              ...(opts?.headers || {}),
              "user-agent": UA,
              referer: embedUrl,
              origin: embedHost,
            },
          });
          const text = await r.text();
          let j = {};
          try {
            j = JSON.parse(text);
          } catch (pe) {
            console.error("[9STR_JSON_ERR]", r.status, text.slice(0, 300));
          }
          return { ok: r.ok, status: r.status, json: async () => j };
        } catch (fe) {
          console.error("[9STR_FETCH_ERR]", fe.message);
          throw fe;
        }
      },
      document: {
        referrer: pageReferer,
        readyState: "complete",
        addEventListener: (ev, fn) => {
          if (ev === "DOMContentLoaded") listeners.push(fn);
        },
        getElementById: () => ({ style: {}, innerHTML: "" }),
        createElement: () => ({ style: {} }),
        location: {
          origin: embedHost,
          hostname: new URL(embedUrl).hostname,
          href: embedUrl,
          ancestorOrigins: [pageOrigin],
        },
      },
      player_9stream: (playlist) => {
        clearTimeout(timeout);
        let link = "";
        if (typeof playlist === "string") {
          link = playlist;
        } else if (Array.isArray(playlist) && playlist[0]?.file) {
          link = playlist[0].file;
        }
        if (link) {
          resolve({ videoUrl: link, referer: embedUrl });
        } else {
          reject(new Error("player_9stream received empty playlist"));
        }
      },
      showMsg: (m) => {
        clearTimeout(timeout);
        reject(new Error(`9stream showMsg: ${m}`));
      },
      jwplayer: () => ({ setup: () => {}, on: () => {} }),
    };

    sandbox.window = sandbox;
    sandbox.top = sandbox;
    sandbox.self = sandbox;
    sandbox.location = sandbox.document.location;

    try {
      const ctx = vm.createContext(sandbox);
      vm.runInContext(appJsCode, ctx);

      (async () => {
        if (listeners.length === 0) {
          clearTimeout(timeout);
          reject(new Error("No DOMContentLoaded listener registered by 9stream script"));
          return;
        }
        for (const fn of listeners) {
          await fn();
        }
      })().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

/**
 * Generic hoster scraper fallback for other embeds (abyss, streamtape, filemoon, etc.)
 */
export async function resolveHoster(embedUrl, pageReferer) {
  try {
    if (!isSafePublicHost(embedUrl)) return null;

    const html = await fetchPageHtml(embedUrl, { referer: pageReferer });
    if (!html) return null;
    const $ = load(html);
    let fullText = html;

    $("script").each((_, el) => {
      const text = $(el).html() || "";
      if (isPacked(text)) {
        const unpacked = unpackDeanEdwards(text);
        if (unpacked) fullText += "\n" + unpacked;
      }
    });

    let m = fullText.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i);
    if (m) return { videoUrl: m[1].replace(/\\\//g, "/"), referer: embedUrl };

    m = fullText.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
    if (m) return { videoUrl: m[1].replace(/\\\//g, "/"), referer: embedUrl };

    m = fullText.match(/["']file["']\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
    if (m) return { videoUrl: m[1].replace(/\\\//g, "/"), referer: embedUrl };

    if (embedUrl.includes("streamtape")) {
      const sm =
        fullText.match(/id=['"](?:robotlink|videolink)['"][^>]*>([^<]+)/i) ||
        fullText.match(
          /document\.getElementById\(['"](?:robotlink|videolink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*['"]([^'"]+)['"]/i
        );
      if (sm) {
        let link = sm[1] + (sm[2] || "");
        if (link.startsWith("//")) link = "https:" + link;
        return { videoUrl: link, referer: embedUrl };
      }
    }

    const src = $("video source").attr("src") || $("video").attr("src") || $("source").attr("src");
    if (src) return { videoUrl: src, referer: embedUrl };

    m = fullText.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/i);
    if (m) return { videoUrl: m[0].replace(/\\\//g, "/"), referer: embedUrl };

    return null;
  } catch {
    return null;
  }
}
