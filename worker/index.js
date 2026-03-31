// ============================================================
// Porto Wantlist Tracker — Cloudflare Worker (v3.4)
// ============================================================
// Endpoints:
//   ?url=<target>          — CORS proxy for store websites
//   ?inventory=<seller>    — KV-cached Discogs seller inventory
//   ?vinyldisc=<query>     — Vinyl Disc search proxy
//   ?wantlist=<user>       — Discogs wantlist proxy (uses DISCOGS_TOKEN)
//   ?catalog=<storeId>     — Return pre-fetched store catalog from KV
//   ?market=<releaseId>    — Check Discogs marketplace for PT listings (2h KV cache)
//   ?suggest (POST)        — Create a GitHub issue for store suggestions (needs GITHUB_TOKEN)
//
// Scheduled (cron every 6h):
//   Fetches full Shopify catalogs for configured stores → KV
//
// Bindings required:
//   INVENTORY_KV   — KV namespace for cached inventories
//   DISCOGS_TOKEN  — Secret: Discogs personal access token
//   GITHUB_TOKEN   — Secret: GitHub PAT with issues write scope
// ============================================================

// Shopify stores to pre-fetch on schedule
const CATALOG_STORES = [
  { id: "musicriots",  type: "shopify", domain: "shopmusicandriots.com" },
  { id: "discosdobau", type: "shopify", domain: "discosdobau.pt" },
  { id: "flur",        type: "shopify", domain: "www.flur.pt" },
];

// KV TTL for catalogs: 12 hours
const CATALOG_TTL = 12 * 60 * 60;

// Max pages to fetch per store (250 products/page = 5,000 products)
const CATALOG_MAX_PAGES = 20;

const ALLOWED_DOMAINS = new Set([
  "www.8mm-records.com", "8mm-records.com",
  "www.louielouie.pt", "louielouie.pt",
  "www.materiaprima.pt", "materiaprima.pt",
  "portocalling.com", "www.portocalling.com",
  "shopmusicandriots.com", "www.shopmusicandriots.com",
  "socorro.pt", "www.socorro.pt",
  "cdgo.com", "www.cdgo.com",
  "tubitek.pt", "www.tubitek.pt",
  "discosdobau.pt", "www.discosdobau.pt",
  "www.flur.pt", "flur.pt",
  "shop.carpetandsnares.com",
  "www.peekaboorecords.pt", "peekaboorecords.pt",
]);

// KV cache TTL: 6 hours (in seconds)
const KV_TTL = 6 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const { searchParams } = new URL(request.url);

    // --- Catalog read endpoint ---
    const catalogId = searchParams.get("catalog");
    if (catalogId !== null) {
      return handleCatalogRead(catalogId, env);
    }

    // --- Manual catalog refresh (admin) — fire and forget, returns immediately ---
    if (searchParams.get("refresh_catalogs") !== null) {
      ctx.waitUntil(scheduledFetch(env));
      return json({ ok: true, stores: CATALOG_STORES.map((s) => s.id) });
    }

    // --- Wantlist endpoint ---
    const wlUser = searchParams.get("wantlist");
    if (wlUser !== null) {
      return handleWantlist(wlUser, searchParams.get("page"), env);
    }

    // --- Inventory endpoint ---
    const seller = searchParams.get("inventory");
    if (seller) {
      return handleInventory(seller, env);
    }

    // --- Vinyl Disc search endpoint ---
    const vinylQuery = searchParams.get("vinyldisc");
    if (vinylQuery !== null) {
      return handleVinylDisc(vinylQuery);
    }

    // --- ID resolution endpoint ---
    const resolveQuery = searchParams.get("resolve");
    if (resolveQuery !== null) {
      return handleResolve(resolveQuery, env);
    }

    // --- Marketplace PT endpoint ---
    const marketId = searchParams.get("market");
    if (marketId !== null) {
      return handleMarket(marketId, env);
    }

    // --- Artwork endpoint (iTunes Search) ---
    const artworkQuery = searchParams.get("artwork");
    if (artworkQuery !== null) {
      return handleArtwork(artworkQuery, env);
    }

    // --- Store suggestion endpoint (POST) ---
    if (searchParams.has("suggest")) {
      return handleSuggest(request, env);
    }

    // --- Proxy endpoint ---
    const target = searchParams.get("url");
    if (!target) return json({ error: "Missing ?url=, ?inventory=, ?vinyldisc=, ?wantlist=, ?catalog=, ?resolve=, or ?market= parameter" }, 400);

    return handleProxy(target);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduledFetch(env));
  },
};

// ============================================================
// Wantlist endpoint: proxy Discogs wantlist API
// ============================================================
async function handleWantlist(user, pageParam, env) {
  if (!/^[\w.-]{1,50}$/.test(user)) {
    return json({ error: "Invalid username" }, 400);
  }
  if (!env.DISCOGS_TOKEN) {
    return json({ error: "Token not configured" }, 500);
  }
  const page = parseInt(pageParam || "1", 10);
  const url = `https://api.discogs.com/users/${encodeURIComponent(user)}/wants?per_page=100&page=${page}&sort=added&sort_order=desc`;
  try {
    const r = await fetch(url, {
      headers: {
        "Authorization": `Discogs token=${env.DISCOGS_TOKEN}`,
        "User-Agent": "PortoWantlistTracker/3.2",
      },
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
    return new Response(JSON.stringify(body), {
      status: r.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return json({ error: "fetch failed: " + err.message }, 502);
  }
}

// ============================================================
// Vinyl Disc search endpoint
// ============================================================
async function handleVinylDisc(query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch("https://vinyldisc.pt/web/get_page/0", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; PortoWantlistTracker/3.2)",
      },
      body: "query=" + encodeURIComponent(query),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await resp.json();
    return json({ json: data });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

// ============================================================
// Inventory endpoint: fetch full Discogs seller inventory
// ============================================================
async function handleInventory(seller, env) {
  const kvKey = `inv:${seller}`;

  // Check KV cache first
  try {
    const cached = await env.INVENTORY_KV.get(kvKey, "json");
    if (cached) {
      return json({ ids: cached.ids, count: cached.ids.length, cached: true });
    }
  } catch (e) {
    // KV miss or error — continue to fresh fetch
  }

  // Fetch full inventory from Discogs API
  const token = env.DISCOGS_TOKEN || "";
  const allIds = [];
  let page = 1;
  let pages = 1;

  try {
    while (page <= pages) {
      const url =
        `https://api.discogs.com/users/${encodeURIComponent(seller)}/inventory` +
        `?per_page=100&page=${page}&sort=listed&sort_order=desc` +
        (token ? `&token=${token}` : "");

      const resp = await fetch(url, {
        headers: {
          "User-Agent": "PortoWantlistTracker/3.2",
          Accept: "application/vnd.discogs.v2.discogs+json",
        },
      });

      if (!resp.ok) {
        if (resp.status === 429) {
          await sleep(2500);
          continue;
        }
        return json({ error: `Discogs API error ${resp.status} for seller ${seller}` }, 502);
      }

      const data = await resp.json();
      pages = data.pagination?.pages || 1;

      const listings = data.listings || [];
      for (const l of listings) {
        const rid = l.release?.id;
        if (rid) allIds.push(String(rid));
      }

      page++;
      if (page <= pages) await sleep(1100);
    }

    // Store in KV with TTL
    try {
      await env.INVENTORY_KV.put(kvKey, JSON.stringify({ ids: allIds }), {
        expirationTtl: KV_TTL,
      });
    } catch (e) {
      // KV write failed — non-fatal, still return data
    }

    return json({ ids: allIds, count: allIds.length, cached: false });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

// ============================================================
// Proxy endpoint: fetch store websites
// ============================================================
async function handleProxy(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "Invalid URL" }, 400);
  }

  if (!ALLOWED_DOMAINS.has(parsed.hostname)) {
    return json({ error: `Domain not allowed: ${parsed.hostname}` }, 403);
  }

  try {
    const isJson = target.includes(".json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PortoWantlistTracker/3.2)",
        Accept: isJson
          ? "application/json"
          : "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const body = await resp.text();
    const ct = resp.headers.get("content-type") || "";

    // --- JSON response (Shopify search endpoints) ---
    if (ct.includes("application/json") || ct.includes("text/json") || isJson) {
      try {
        const jsonData = JSON.parse(body);
        return json({ json: jsonData, status: resp.status, finalUrl: resp.url });
      } catch {
        /* fall through to HTML handling */
      }
    }

    // --- HTML response ---
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";

    const hasBasket = /add.to.(basket|cart|carrinho)/i.test(body);
    const hasPrice =
      /"price"/i.test(body) ||
      /€\s*\d/.test(body) ||
      /\d+[.,]\d{2}\s*€/.test(body);
    const hasBuyButton = /\b(buy|comprar|adicionar|add to)\b/i.test(body);
    const hasOutOfStock =
      /out.of.stock|esgotado|fora.de.stock|indispon/i.test(body);

    const metaDesc =
      body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || "";
    const ogTitle =
      body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i)?.[1] || "";

    // --- Body text for search result matching ---
    const bodyText = body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/&#\d+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10000);

    // --- Extract individual product titles from search result pages ---
    const productTitles = [];
    const ptRe = /<a[^>]+class=["'][^"']*product[- ](?:item[- ]link|name)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let ptm;
    while ((ptm = ptRe.exec(body)) !== null && productTitles.length < 200) {
      const txt = ptm[1].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/&#\d+;/gi, " ").replace(/\s+/g, " ").trim();
      if (txt.length > 1) productTitles.push(txt);
    }

    return json({
      title,
      ogTitle,
      metaDesc,
      hasBasket,
      hasPrice,
      hasBuyButton,
      hasOutOfStock,
      bodyText,
      productTitles: productTitles.length > 0 ? productTitles : undefined,
      status: resp.status,
      finalUrl: resp.url,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

// ============================================================
// Catalog read endpoint
// ============================================================
async function handleCatalogRead(storeId, env) {
  if (!/^[a-z0-9_-]{1,30}$/.test(storeId)) {
    return json({ error: "Invalid store id" }, 400);
  }
  try {
    const data = await env.INVENTORY_KV.get(`catalog:shopify:${storeId}`, "json");
    if (!data) return json({ error: "not_cached" }, 404);
    return json(data);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ============================================================
// Scheduled: pre-fetch all store catalogs into KV
// ============================================================
async function scheduledFetch(env) {
  await Promise.all(CATALOG_STORES.map(async (store) => {
    try {
      if (store.type === "shopify") await fetchShopifyCatalog(store, env);
    } catch (e) {
      console.error(`[catalog] Failed ${store.id}:`, e.message);
    }
  }));
}

async function fetchShopifyCatalog(store, env) {
  const products = [];
  let page = 1;

  while (true) {
    const url = `https://${store.domain}/products.json?limit=250&page=${page}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "PortoWantlistTracker/3.3" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} on page ${page}`);

    const data = await resp.json();
    const batch = data.products || [];
    if (batch.length === 0) break;

    for (const p of batch) {
      products.push({
        title: p.title || "",
        vendor: p.vendor || "",
        available: p.variants ? p.variants.some((v) => v.available) : false,
      });
    }

    if (batch.length < 250 || page >= CATALOG_MAX_PAGES) break;
    page++;
    await sleep(500);
  }

  await env.INVENTORY_KV.put(
    `catalog:shopify:${store.id}`,
    JSON.stringify({ storeId: store.id, fetched: Date.now(), products }),
    { expirationTtl: CATALOG_TTL }
  );
  console.log(`[catalog] ${store.id}: ${products.length} products cached`);
}

// ============================================================
// ID Resolution endpoint: search Discogs for a release ID by artist+title
// ============================================================
async function handleResolve(query, env) {
  const parts = decodeURIComponent(query).split("\n");
  const artist = (parts[0] || "").trim();
  const title = (parts[1] || "").trim();
  if (!artist || !title) return json({ id: null });

  const cacheKey = "resolve:" + (artist + ":" + title).toLowerCase().slice(0, 80);
  try {
    const cached = await env.INVENTORY_KV.get(cacheKey);
    if (cached !== null) {
      // Handle both new JSON format {id,thumb} and legacy plain-string format
      try { const obj = JSON.parse(cached); return json({ ...obj, cached: true }); }
      catch (_) { return json({ id: cached || null, cached: true }); }
    }
  } catch (e) {}

  try {
    const url = `https://api.discogs.com/database/search?` +
      `artist=${encodeURIComponent(artist)}&` +
      `release_title=${encodeURIComponent(title)}&` +
      `type=release&per_page=3`;
    const r = await fetch(url, {
      headers: {
        "Authorization": `Discogs token=${env.DISCOGS_TOKEN}`,
        "User-Agent": "PortoWantlistTracker/3.4",
      },
    });
    if (!r.ok) return json({ id: null });
    const data = await r.json();
    const results = data.results || [];
    const id = results.length > 0 ? String(results[0].id) : "";
    const thumb = results.length > 0 ? (results[0].cover_image || results[0].thumb || "") : "";
    try {
      await env.INVENTORY_KV.put(cacheKey, JSON.stringify({ id: id || null, thumb: thumb || null }), { expirationTtl: 7 * 24 * 60 * 60 });
    } catch (e) {}
    return json({ id: id || null, thumb: thumb || null });
  } catch (err) {
    return json({ id: null, error: err.message });
  }
}

// ============================================================
// Artwork endpoint: fetch cover art via iTunes Search API
// ============================================================
async function handleArtwork(query, env) {
  const parts = decodeURIComponent(query).split("\n");
  const artist = (parts[0] || "").trim();
  const title = (parts[1] || "").trim();
  if (!artist && !title) return json({ thumb: null });

  const cacheKey = "art:" + (artist + ":" + title).toLowerCase().slice(0, 80);
  try {
    const cached = await env.INVENTORY_KV.get(cacheKey);
    if (cached !== null) return json({ thumb: cached || null, cached: true });
  } catch (e) {}

  try {
    const term = encodeURIComponent(artist + " " + title);
    const url = `https://itunes.apple.com/search?term=${term}&entity=album&limit=3`;
    const r = await fetch(url);
    if (!r.ok) return json({ thumb: null });
    const data = await r.json();
    const results = data.results || [];
    let thumb = "";
    if (results.length > 0) {
      thumb = results[0].artworkUrl100 || "";
      if (thumb) thumb = thumb.replace("100x100", "300x300");
    }
    try {
      await env.INVENTORY_KV.put(cacheKey, thumb, { expirationTtl: 7 * 24 * 60 * 60 });
    } catch (e) {}
    return json({ thumb: thumb || null });
  } catch (err) {
    return json({ thumb: null });
  }
}

// ============================================================
// Store suggestion endpoint: create a GitHub issue
// ============================================================
async function handleSuggest(request, env) {
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN not configured" }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON" }, 400); }

  const name = (body.name || "").trim();
  const city = (body.city || "").trim();
  const website = (body.website || "").trim();
  const notes = (body.notes || "").trim();
  if (!name) return json({ error: "Store name is required" }, 400);

  const issueBody = [
    `**Store name:** ${name}`,
    `**City:** ${city || "Not specified"}`,
    `**Website:** ${website || "Not provided"}`,
    notes ? `**Notes:** ${notes}` : "",
    "",
    "---",
    "_Submitted via Wantlist Tracker_",
  ].filter(Boolean).join("\n");

  try {
    const r = await fetch("https://api.github.com/repos/J-deAlmeida/Discogs-Wantlist-Tracker/issues", {
      method: "POST",
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "User-Agent": "PortoWantlistTracker/3.4",
        "Content-Type": "application/json",
        "Accept": "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        title: `Store suggestion: ${name}`,
        body: issueBody,
        labels: ["store-suggestion"],
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      return json({ error: "GitHub API error (" + r.status + ")", detail: err }, 500);
    }
    const issue = await r.json();
    return json({ ok: true, url: issue.html_url });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ============================================================
// Marketplace PT endpoint: check Discogs marketplace for PT listings
// ============================================================
async function handleMarket(releaseId, env) {
  if (!/^\d{1,10}$/.test(releaseId)) return json({ found: false });

  const cacheKey = `mkt:${releaseId}`;
  try {
    const cached = await env.INVENTORY_KV.get(cacheKey, "json");
    if (cached) return json({ ...cached, cached: true });
  } catch (e) {}

  try {
    const url = `https://api.discogs.com/marketplace/search?release_id=${encodeURIComponent(releaseId)}&ships_from=Portugal&per_page=50`;
    const r = await fetch(url, {
      headers: {
        "Authorization": `Discogs token=${env.DISCOGS_TOKEN}`,
        "User-Agent": "PortoWantlistTracker/3.4",
      },
    });
    if (!r.ok) return json({ found: false });
    const data = await r.json();
    const results = data.results || [];
    // Filter for Portugal seller location (client-side safety net if ships_from param is ignored)
    const count = results.filter((item) => {
      const loc = (item.seller?.location || "").toLowerCase();
      return loc.includes("portugal") || loc === "pt";
    }).length;
    const result = { found: count > 0, count };
    try {
      await env.INVENTORY_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 2 * 60 * 60 });
    } catch (e) {}
    return json(result);
  } catch (err) {
    return json({ found: false, error: err.message });
  }
}

// ============================================================
// Helpers
// ============================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cors(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
