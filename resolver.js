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

/**
 * Resolves 9stream player used by play.playkrx18.site
 */
export async function resolve9Stream(embedUrl, pageReferer) {
  const res = await fetchWithTimeout(embedUrl, {
    headers: {
      "user-agent": UA,
      referer: pageReferer,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`Embed fetch failed: status ${res.status}`);
  const html = await res.text();
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
      console: { log: () => {}, error: () => {}, warn: () => {} },
      fetch: async (url, opts) => {
        if (url.includes("view/")) return { ok: true, status: 200 };
        const r = await fetchWithTimeout(url, {
          ...opts,
          headers: {
            ...(opts?.headers || {}),
            "user-agent": UA,
            referer: embedUrl,
            origin: embedHost,
          },
        });
        const j = await r.json();
        return { ok: r.ok, status: r.status, json: async () => j };
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
      showMsg: () => {},
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

    const r = await fetchWithTimeout(embedUrl, {
      headers: {
        "user-agent": UA,
        referer: pageReferer,
        accept: "text/html,application/xhtml+xml,*/*",
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
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
