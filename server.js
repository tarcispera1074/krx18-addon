// krx18-addon — Stremio / Nuvio Addon for krx18.com & javeng.tv

import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load } from "cheerio";
import {
  checkProxyUrl,
  isSafePublicHost,
  parseHostList,
  normalizeHost,
} from "./allowlist.js";
import {
  resolve9Stream,
  resolveHoster,
  fetchWithTimeout,
  fetchPageHtml,
} from "./resolver.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8")
);

const PORT = Number(process.env.PORT || 7005);
const KRX_BASE = "https://krx18.com";
const JAVENG_BASE = "https://javeng.tv";

const CATALOG_TTL_MS = Number(process.env.CATALOG_TTL_MINUTES || 10) * 60_000;
const STREAM_TTL_MS = Number(process.env.STREAM_TTL_MINUTES || 5) * 60_000;
const PROXY_ALLOW_ANY = process.env.PROXY_ALLOW_ANY === "1";
const EXTRA_ALLOWED_HOSTS = parseHostList(process.env.ALLOWED_EXTRA_HOSTS || "");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const POSTER_FALLBACK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" fill="#e50914" font-family="sans-serif" font-weight="bold" font-size="32" text-anchor="middle">KRX18</text></svg>`
  );

function log(scope, msg) {
  console.log(`[${scope}] ${msg}`);
}

// ---------------------------------------------------------------------------
// HOST POLICY STATE
// ---------------------------------------------------------------------------
const learnedHosts = new Set();
const MAX_LEARNED = 300;

function learnHost(rawHost) {
  const h = normalizeHost(rawHost);
  if (!h || h.includes(":")) return;
  if (learnedHosts.size >= MAX_LEARNED) return;
  learnedHosts.add(h);
  const parts = h.split(".");
  if (parts.length > 2) learnedHosts.add(parts.slice(-2).join("."));
}

function proxyOptions() {
  return {
    allowAny: PROXY_ALLOW_ANY,
    extraHosts: EXTRA_ALLOWED_HOSTS,
    learned: learnedHosts,
  };
}

// ---------------------------------------------------------------------------
// GENRES FOR RECENTLY ADDED (MOVIES)
// ---------------------------------------------------------------------------
const GENRES = [
  { name: "Korea", slug: "korea" },
  { name: "Japan", slug: "japan" },
  { name: "Philippines", slug: "philippines" },
  { name: "China", slug: "china" },
  { name: "Taiwan", slug: "taiwan" },
  { name: "Thailand", slug: "thailand" },
  { name: "Indonesia", slug: "indonesia" },
  { name: "India", slug: "india" },
  { name: "France", slug: "france" },
  { name: "Germany", slug: "germany" },
  { name: "Italy", slug: "italy" },
  { name: "Spain", slug: "spain" },
  { name: "Russia", slug: "russia" },
  { name: "Poland", slug: "poland" },
  { name: "USA", slug: "usa" },
  { name: "UK", slug: "uk" },
  { name: "Eng Sub", slug: "eng-sub" },
  { name: "X Clip", slug: "xxx" },
];

const GENRE_SLUG_MAP = new Map();
for (const g of GENRES) {
  GENRE_SLUG_MAP.set(g.name.toLowerCase(), g.slug);
  GENRE_SLUG_MAP.set(g.slug.toLowerCase(), g.slug);
}

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------
const manifest = {
  id: "org.krx18.addon",
  version: pkg.version,
  name: "KRX18",
  description: "Adult movies, X clips, & JAV from krx18.com & javeng.tv",
  logo: POSTER_FALLBACK,
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["krx18:", "javeng:"],
  catalogs: [
    {
      type: "movie",
      id: "krx18_featured",
      name: "Featured 18+",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "movie",
      id: "krx18_latest_home",
      name: "Latest Movies 18+",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "movie",
      id: "krx18_movies_recent",
      name: "Recently Added (Movies)",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", isRequired: false, options: GENRES.map((g) => g.name) },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "krx18_xxx_recent",
      name: "Recently Added (X Clip)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "javeng_movies",
      name: "Movies (JavEng)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  behaviorHints: { configurable: false },
};

// ---------------------------------------------------------------------------
// CACHES
// ---------------------------------------------------------------------------
const catalogCache = new Map();
const metaCache = new Map();
const streamCache = new Map();

function cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (e.expires < Date.now()) {
    map.delete(key);
    return null;
  }
  return e.val;
}

function cacheSet(map, key, val, ttl) {
  map.set(key, { val, expires: Date.now() + ttl });
  if (map.size > 2000) map.delete(map.keys().next().value);
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
};

function sendJson(req, res, status, data, extraHeaders = {}) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
    "cache-control": extraHeaders["cache-control"] || "max-age=600, stale-while-revalidate=1200",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function getProxyBase(req) {
  if (process.env.CF_WORKER_URL) {
    return process.env.CF_WORKER_URL.replace(/\/+$/, "");
  }
  const proto = req.headers["x-forwarded-proto"]?.split(",")[0]?.trim() || "http";
  const host =
    req.headers["x-forwarded-host"]?.split(",")[0]?.trim() ||
    req.headers.host ||
    `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function httpUrl(pathAndQuery, req) {
  return `${getProxyBase(req)}${pathAndQuery}`;
}

function parseArticle($, el, prefix = "krx18") {
  const aTag = $(el).find(".data h3 a, h3 a, a").first();
  const link = aTag.attr("href") || $(el).find("a").first().attr("href");
  if (!link || link === "https://krx18.com/movies/" || link.includes("?movies=1")) return null;

  let title =
    $(el).find(".data h3, h3").first().text().trim() ||
    $(el).find("img").attr("alt") ||
    "Movie";
  title = title.replace(/\s+/g, " ").trim();

  let poster =
    $(el).find("img").attr("src") ||
    $(el).find("img").attr("data-src") ||
    $(el).find("img").attr("data-original") ||
    POSTER_FALLBACK;
  if (poster.startsWith("//")) poster = "https:" + poster;

  const id = `${prefix}:${encodeURIComponent(link)}`;

  return {
    id,
    type: "movie",
    name: title,
    poster,
    background: poster,
    website: link,
  };
}

async function fetchJsonWithFallback(url, headers = {}) {
  try {
    const res = await fetchWithTimeout(url, { headers });
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch {}

  try {
    const pr = await fetchWithTimeout(`https://r.jina.ai/${url}?_t=${Date.now()}`, {
      headers: { "X-No-Cache": "true" },
    });
    if (pr.ok) {
      const text = await pr.text();
      const m = text.match(/\{[\s\S]*"embed_url"[\s\S]*\}/);
      if (m) {
        return JSON.parse(m[0]);
      }
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// CATALOG SCRAPERS
// ---------------------------------------------------------------------------
async function fetchCatalog({ catId, skip = 0, search = "", genre = "" }) {
  const cacheKey = `${catId}:${skip}:${search}:${genre}`;
  const cached = cacheGet(catalogCache, cacheKey);
  if (cached) return cached;

  let metas = [];

  try {
    if (catId === "krx18_featured") {
      // 1. Featured 18+ (from krx18.com homepage carousel)
      if (skip === 0) {
        const html = await fetchPageHtml(KRX_BASE);
        if (html) {
          const $ = load(html);
          $("#featured-titles article").each((_, el) => {
            const item = parseArticle($, el, "krx18");
            if (item) metas.push(item);
          });
        }
      }
    } else if (catId === "krx18_latest_home") {
      // 2. Latest Movies 18+ (from krx18.com homepage module)
      const html = await fetchPageHtml(KRX_BASE);
      if (html) {
        const $ = load(html);
        const allItems = [];
        $(".module:has(header:contains('Latest Movies')) article, .content:has(header:contains('Latest Movies')) article").each(
          (_, el) => {
            const item = parseArticle($, el, "krx18");
            if (item) allItems.push(item);
          }
        );
        metas = allItems.slice(skip, skip + 30);
      }
    } else if (catId === "krx18_movies_recent") {
      // 3. Recently Added (Movies)
      const page = Math.floor(skip / 30) + 1;
      let targetUrl = `${KRX_BASE}/movies/page/${page}/`;
      if (genre) {
        const gSlug = GENRE_SLUG_MAP.get(genre.toLowerCase()) || genre.toLowerCase();
        targetUrl = `${KRX_BASE}/genre/${gSlug}/page/${page}/`;
      } else if (search) {
        targetUrl = `${KRX_BASE}/page/${page}/?s=${encodeURIComponent(search)}`;
      }

      const html = await fetchPageHtml(targetUrl);
      if (html) {
        const $ = load(html);
        $("article.item, article").each((_, el) => {
          const item = parseArticle($, el, "krx18");
          if (item) metas.push(item);
        });
      }
    } else if (catId === "krx18_xxx_recent") {
      // 4. Recently Added (X Clip)
      const page = Math.floor(skip / 40) + 1;
      let targetUrl = `${KRX_BASE}/genre/xxx/page/${page}/`;
      if (search) {
        targetUrl = `${KRX_BASE}/page/${page}/?s=${encodeURIComponent(search)}`;
      }

      const html = await fetchPageHtml(targetUrl);
      if (html) {
        const $ = load(html);
        $("article.item, article").each((_, el) => {
          const item = parseArticle($, el, "krx18");
          if (item) metas.push(item);
        });
      }
    } else if (catId === "javeng_movies") {
      // 5. Movies (JavEng)
      const page = Math.floor(skip / 30) + 1;
      let targetUrl = `${JAVENG_BASE}/jav-eng-sub/page/${page}/`;
      if (search) {
        targetUrl = `${JAVENG_BASE}/page/${page}/?s=${encodeURIComponent(search)}`;
      }

      const html = await fetchPageHtml(targetUrl);
      if (html) {
        const $ = load(html);
        $("article.item, article").each((_, el) => {
          const item = parseArticle($, el, "javeng");
          if (item) metas.push(item);
        });
      }
    }
  } catch (err) {
    log("CATALOG", `Error fetching ${catId}: ${err.message}`);
  }

  // Deduplicate
  const seen = new Set();
  const deduped = [];
  for (const m of metas) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      deduped.push(m);
      cacheSet(metaCache, m.id, m, CATALOG_TTL_MS);
    }
  }

  cacheSet(catalogCache, cacheKey, deduped, CATALOG_TTL_MS);
  return deduped;
}

// ---------------------------------------------------------------------------
// META DETAILS
// ---------------------------------------------------------------------------
async function fetchMeta(pageUrl, prefix = "krx18") {
  const id = `${prefix}:${encodeURIComponent(pageUrl)}`;
  const cached = cacheGet(metaCache, id);
  if (cached && cached.description) return cached;

  try {
    const html = await fetchPageHtml(pageUrl);
    if (!html) return cached || null;
    const $ = load(html);

    const title =
      $("h1").first().text().trim() ||
      $(".data h1").text().trim() ||
      $("title").text().trim();

    let poster =
      $(".poster img").attr("src") ||
      $(".poster img").attr("data-src") ||
      $('meta[property="og:image"]').attr("content") ||
      POSTER_FALLBACK;
    if (poster.startsWith("//")) poster = "https:" + poster;

    const description =
      $("#info .wp-content, .wp-content p, .sbox p").first().text().trim() ||
      $('meta[property="og:description"]').attr("content") ||
      "";

    const genres = [];
    $(".sgenres a, .genres a").each((_, g) => {
      const gt = $(g).text().trim();
      if (gt) genres.push(gt);
    });

    const meta = {
      id,
      type: "movie",
      name: title,
      poster,
      background: poster,
      description,
      genres,
      website: pageUrl,
    };

    cacheSet(metaCache, id, meta, CATALOG_TTL_MS);
    return meta;
  } catch (err) {
    log("META", `fetchMeta error for ${pageUrl}: ${err.message}`);
    return cached || null;
  }
}

// ---------------------------------------------------------------------------
// STREAM RESOLUTION
// ---------------------------------------------------------------------------
function extractPageUrl(rawId) {
  let s = String(rawId || "");
  try {
    s = decodeURIComponent(s);
  } catch {}
  s = s.replace(/:\d+:\d+$/, "");
  s = s.replace(/^(?:krx18|javeng):/, "");
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s);
    } catch {}
  }
  return s.trim();
}

function normalizeSitePageUrl(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = normalizeHost(u.hostname);
  if (
    host !== "krx18.com" &&
    !host.endsWith(".krx18.com") &&
    host !== "javeng.tv" &&
    !host.endsWith(".javeng.tv")
  ) {
    return null;
  }
  u.protocol = "https:";
  return u.toString();
}

async function resolveVideoFromPage(pageUrl) {
  const cached = cacheGet(streamCache, pageUrl);
  if (cached) return cached;

  log("STREAM", `Resolving video from: ${pageUrl}`);
  const html = await fetchPageHtml(pageUrl);
  if (!html) throw new Error("Failed to load article page");
  const $ = load(html);

  const baseOrigin = new URL(pageUrl).origin;

  // 1. Extract DooPlayer options
  const playerOptions = [];
  $("#playeroptionsul li").each((_, li) => {
    const post = $(li).attr("data-post");
    const type = $(li).attr("data-type") || "movie";
    const nume = $(li).attr("data-nume");
    const name = $(li).find(".title, span.server").text().trim() || $(li).text().trim();
    if (post && nume) {
      playerOptions.push({ post, type, nume, name });
    }
  });

  log("STREAM", `Found ${playerOptions.length} player options`);

  // Try each player option
  for (const opt of playerOptions) {
    const epUrl = `${baseOrigin}/wp-json/dooplayer/v2/${opt.post}/${opt.type}/${opt.nume}`;
    try {
      const data = await fetchJsonWithFallback(epUrl, {
        "user-agent": UA,
        referer: pageUrl,
      });
      if (!data) continue;
      let embedUrl = data.embed_url;
      if (!embedUrl) continue;
      if (embedUrl.startsWith("//")) embedUrl = "https:" + embedUrl;

      log("STREAM", `Option ${opt.nume} (${opt.name}) -> embed: ${embedUrl}`);

      // If it's playkrx18 or 9stream
      if (embedUrl.includes("playkrx18") || embedUrl.includes("9str")) {
        try {
          const resolved = await resolve9Stream(embedUrl, pageUrl);
          if (resolved?.videoUrl) {
            learnHost(resolved.videoUrl);
            learnHost(embedUrl);
            cacheSet(streamCache, pageUrl, resolved, STREAM_TTL_MS);
            return resolved;
          }
        } catch (err) {
          log("STREAM", `9stream resolver error on option ${opt.nume}: ${err.message}`);
        }
      }

      // If it's a generic hoster (mov18plus, abyss, etc.)
      try {
        const resolved = await resolveHoster(embedUrl, pageUrl);
        if (resolved?.videoUrl) {
          learnHost(resolved.videoUrl);
          learnHost(embedUrl);
          cacheSet(streamCache, pageUrl, resolved, STREAM_TTL_MS);
          return resolved;
        }
      } catch (err) {
        log("STREAM", `Hoster resolver error on option ${opt.nume}: ${err.message}`);
      }
    } catch (e) {
      log("STREAM", `Error querying option ${opt.nume}: ${e.message}`);
    }
  }

  // 2. Direct embed / iframe fallback
  $("iframe").each((_, el) => {
    let src = $(el).attr("src") || $(el).attr("data-src") || "";
    if (src.startsWith("//")) src = "https:" + src;
    if (src && isSafePublicHost(src)) {
      playerOptions.push({ embedUrl: src });
    }
  });

  for (const opt of playerOptions.filter((o) => o.embedUrl)) {
    const resolved = await resolveHoster(opt.embedUrl, pageUrl);
    if (resolved?.videoUrl) {
      learnHost(resolved.videoUrl);
      cacheSet(streamCache, pageUrl, resolved, STREAM_TTL_MS);
      return resolved;
    }
  }

  log("STREAM", `No playable stream found on ${pageUrl}`);
  return null;
}

// ---------------------------------------------------------------------------
// PROXY & M3U8 REWRITING
// ---------------------------------------------------------------------------
function proxyLink(absUrl, referer, req) {
  let ext = ".ts";
  if (absUrl.includes(".m3u8")) ext = ".m3u8";
  else if (absUrl.includes(".key")) ext = ".key";
  return httpUrl(
    `/proxy/hls${ext}?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`,
    req
  );
}

function learnPlaylistHosts(text, baseUrl) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      learnHost(new URL(trimmed, baseUrl).hostname);
    } catch {}
  }
}

function rewriteM3u8(text, baseUrl, referer, req) {
  const lines = text.split(/\r?\n/);
  const out = [];

  const rewriteUri = (raw) => {
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return raw;
    }
    return proxyLink(abs, referer, req);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (/URI="/i.test(trimmed)) {
        out.push(trimmed.replace(/URI="([^"]+)"/gi, (_, u) => `URI="${rewriteUri(u)}"`));
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(rewriteUri(trimmed));
  }
  return out.join("\n");
}

async function handleProxy(req, res, u) {
  if (req.method === "OPTIONS") return sendJson(req, res, 204, null);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(req, res, 405, { error: "Method not allowed" });
  }

  const rawTarget = u.searchParams.get("url");
  const referer = u.searchParams.get("referer") || `${KRX_BASE}/`;
  if (!rawTarget) return sendJson(req, res, 400, { error: "Missing url" });

  const check = checkProxyUrl(rawTarget, proxyOptions());
  if (!check.ok) {
    log("PROXY BLOCK", `${check.reason} ${check.host || String(rawTarget).slice(0, 80)}`);
    return sendJson(req, res, 403, { error: "Host not allowed", reason: check.reason });
  }

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  const range = req.headers.range;
  const targetOrigin = new URL(referer).origin;
  const upstreamHeaders = {
    "user-agent": UA,
    referer,
    origin: targetOrigin,
    accept: "*/*",
  };
  if (range) upstreamHeaders.range = range;

  try {
    const currentUrl = check.url.toString();
    const r = await fetch(currentUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: ac.signal,
    });

    if (!r.ok && r.status !== 206) {
      log("PROXY FAIL", `${r.status} ${currentUrl.slice(0, 80)}`);
      return sendJson(req, res, r.status === 404 ? 404 : 502, {
        error: "Upstream error",
        status: r.status,
      });
    }

    let contentType = r.headers.get("content-type") || "video/mp4";
    const looksLikeM3u8 =
      currentUrl.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    if (looksLikeM3u8) {
      const text = await r.text();
      learnPlaylistHosts(text, currentUrl);
      const rewritten = rewriteM3u8(text, currentUrl, referer, req);
      const body = Buffer.from(rewritten, "utf-8");
      res.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
        ...CORS_HEADERS,
        "cache-control": "no-store",
        "content-length": body.length,
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    }

    if (contentType === "application/octet-stream") contentType = "video/mp4";

    const headers = {
      "content-type": contentType,
      ...CORS_HEADERS,
      "cache-control": "no-store",
      "accept-ranges": r.headers.get("accept-ranges") || "bytes",
    };
    const cl = r.headers.get("content-length");
    const cr = r.headers.get("content-range");
    if (cl) headers["content-length"] = cl;
    if (cr) headers["content-range"] = cr;

    res.writeHead(r.status === 206 ? 206 : 200, headers);
    if (!r.body || req.method === "HEAD") return res.end();

    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r2) => res.once("drain", r2));
    }
    res.end();
  } catch (e) {
    if (e.name === "AbortError") return;
    console.error("[PROXY ERR]", e.message);
    if (!res.headersSent) sendJson(req, res, 502, { error: "Proxy failed", detail: e.message });
    else res.end();
  }
}

// ---------------------------------------------------------------------------
// HTTP SERVER ROUTING
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname;
  log("HTTP", `${req.method} ${p}${u.search ? u.search.slice(0, 100) : ""}`);

  if (req.method === "OPTIONS") return sendJson(req, res, 204, null);

  if (p === "/healthz") {
    return sendJson(req, res, 200, {
      ok: true,
      name: manifest.name,
      version: manifest.version,
      uptimeSeconds: Math.round(process.uptime()),
      caches: {
        catalogs: catalogCache.size,
        metas: metaCache.size,
        streams: streamCache.size,
      },
      knownHosts: learnedHosts.size,
    });
  }

  if (p === "/manifest.json" || p === "/mainfest.json") return sendJson(req, res, 200, manifest);

  if (p === "/") {
    return sendJson(req, res, 200, {
      name: manifest.name,
      manifest: "/manifest.json",
      install: `stremio://${req.headers.host}/manifest.json`,
    });
  }

  if (p === "/proxy" || p.startsWith("/proxy/")) return handleProxy(req, res, u);

  // -------------------------------------------------------------------------
  // CATALOG
  // -------------------------------------------------------------------------
  if (p.startsWith("/catalog/")) {
    const parts = p.split("/").filter(Boolean);
    const catId = parts[2] ? parts[2].replace(/\.json$/, "") : "";
    const extraStr = parts[3] ? parts[3].replace(/\.json$/, "") : "";

    let skip = 0;
    let search = "";
    let genre = "";

    for (const part of extraStr.split("&")) {
      if (!part) continue;
      if (part.startsWith("skip=")) skip = Number(part.slice(5)) || 0;
      if (part.startsWith("search=")) search = decodeURIComponent(part.slice(7));
      if (part.startsWith("genre=")) genre = decodeURIComponent(part.slice(6));
    }

    if (u.searchParams.has("skip")) skip = Number(u.searchParams.get("skip")) || skip;
    if (u.searchParams.has("search")) search = u.searchParams.get("search") || search;
    if (u.searchParams.has("genre")) genre = u.searchParams.get("genre") || genre;

    try {
      const metas = await fetchCatalog({ catId, skip, search, genre });
      log("CATALOG", `Returned ${metas.length} items for ${catId} (skip=${skip}, q="${search}", genre="${genre}")`);
      return sendJson(req, res, 200, { metas, cacheMaxAge: 1800 });
    } catch (e) {
      console.error("[CATALOG ERR]", e.message);
      return sendJson(req, res, 200, { metas: [] });
    }
  }

  // -------------------------------------------------------------------------
  // META
  // -------------------------------------------------------------------------
  if (p.startsWith("/meta/")) {
    const m = p.match(/\/meta\/movie\/(.+)\.json$/);
    const rawId = m ? m[1] : "";
    const pageUrl = extractPageUrl(rawId);
    const prefix = rawId.startsWith("javeng:") ? "javeng" : "krx18";
    const id = `${prefix}:${encodeURIComponent(pageUrl)}`;

    const meta = await fetchMeta(pageUrl, prefix);
    if (meta) {
      return sendJson(req, res, 200, { meta });
    }

    const fallbackTitle = pageUrl.split("/").filter(Boolean).pop()?.replace(/-/g, " ") || "Video";
    return sendJson(req, res, 200, {
      meta: {
        id,
        type: "movie",
        name: fallbackTitle,
        poster: POSTER_FALLBACK,
      },
    });
  }

  // -------------------------------------------------------------------------
  // STREAM
  // -------------------------------------------------------------------------
  if (p.startsWith("/stream/")) {
    const m = p.match(/\/stream\/movie\/(.+)\.json$/);
    const rawId = m ? m[1] : "";
    const requested = extractPageUrl(rawId);
    const pageUrl = normalizeSitePageUrl(requested);

    if (!pageUrl) {
      log("STREAM", `Refused id that is not a valid krx18 or javeng URL: ${requested}`);
      return sendJson(req, res, 200, { streams: [] });
    }

    try {
      const resolved = await resolveVideoFromPage(pageUrl);
      if (!resolved || !resolved.videoUrl) {
        log("STREAM", `Resolution failed for ${pageUrl}`);
        return sendJson(req, res, 200, { streams: [] });
      }

      const { videoUrl, referer } = resolved;
      log("STREAM", `Resolved playable URL: ${videoUrl.slice(0, 100)}`);

      const title = videoUrl.includes(".mp4") ? "Direct MP4" : "Fast HLS (1080p Auto)";
      const ref = referer || pageUrl;

      const proxyUrl = httpUrl(
        `/proxy/master.m3u8?url=${encodeURIComponent(videoUrl)}&referer=${encodeURIComponent(ref)}`,
        req
      );

      return sendJson(
        req,
        res,
        200,
        {
          streams: [
            {
              name: "KRX18",
              title,
              url: proxyUrl,
              behaviorHints: { notWebReady: false },
            },
          ],
        },
        { "cache-control": "no-cache, no-store, must-revalidate" }
      );
    } catch (e) {
      log("STREAM", `Failed: ${e.message}`);
      return sendJson(req, res, 200, { streams: [] });
    }
  }

  return sendJson(req, res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`\n🚀 KRX18 Addon running on port ${PORT}`);
  console.log(`   Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`   Health:   http://localhost:${PORT}/healthz`);
  console.log(`   Catalogs:`);
  console.log(`     i)   Featured 18+              -> http://localhost:${PORT}/catalog/movie/krx18_featured.json`);
  console.log(`     ii)  Latest Movies 18+         -> http://localhost:${PORT}/catalog/movie/krx18_latest_home.json`);
  console.log(`     iii) Recently Added (Movies)   -> http://localhost:${PORT}/catalog/movie/krx18_movies_recent.json`);
  console.log(`     iv)  Recently Added (X Clip)   -> http://localhost:${PORT}/catalog/movie/krx18_xxx_recent.json`);
  console.log(`     v)   Movies (JavEng)           -> http://localhost:${PORT}/catalog/movie/javeng_movies.json\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} received — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
