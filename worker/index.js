// ============================================================
// Porto Wantlist Tracker — Cloudflare Worker (v3.0)
// ============================================================
// CORS proxy + KV-cached Discogs seller inventories.
//
// Bindings required:
//   - INVENTORY_KV: KV namespace for cached inventories
//   - DISCOGS_TOKEN: secret with Discogs personal access token
//
// Endpoints:
//   GET ?url=...         → proxy a store website (existing)
//   GET ?inventory=SELLER → return cached seller inventory
// ============================================================

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
]);

const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours in ms
const DISCOGS_API = "https://api.discogs.com";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const { searchParams } = new URL(request.url);

    // --- Inventory endpoint ---
    const seller = searchParams.get("inventory");
    if (seller) {
      return handleInventory(seller, env);
    }

    // --- Proxy endpoint ---
    const target = searchParams.get("url");
    if (!target) return json({ error: "Missing ?url= or ?inventory= parameter" }, 400);

    let parsed;
    try { parsed = new URL(target); }
    catch { return json({ error: "Invalid URL" }, 400); }

    if (!ALLOWED_DOMAINS.has(parsed.hostname)) {
      return json({ error: `Domain not allowed: ${parsed.hostname}` }, 403);
    }

    try {
      const isJson = target.includes(".json");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PortoWantlistTracker/3.0)",
          "Accept": isJson ? "application/json" : "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const body = await resp.text();
      const ct = resp.headers.get("content-type") || "";

      // JSON response (Shopify)
      if (ct.includes("application/json") || ct.includes("text/json") || isJson) {
        try {
          const jsonData = JSON.parse(body);
          return json({ json: jsonData, status: resp.status, finalUrl: resp.url });
        } catch { /* fall through */ }
      }

      // HTML response
      const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";
      const hasBasket = /add.to.(basket|cart|carrinho)/i.test(body);
      const hasPrice = /"price"/i.test(body) || /€\s*\d/.test(body) || /\d+[.,]\d{2}\s*€/.test(body);
      const hasBuyButton = /\b(buy|comprar|adicionar|add to)\b/i.test(body);
      const hasOutOfStock = /out.of.stock|esgotado|fora.de.stock|indispon/i.test(body);
      const metaDesc = body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || "";
      const ogTitle = body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i)?.[1] || "";

      const bodyText = body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/&#\d+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10000);

      return json({
        title, ogTitle, metaDesc,
        hasBasket, hasPrice, hasBuyButton, hasOutOfStock,
        bodyText, status: resp.status, finalUrl: resp.url,
      });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  },
};

// ============================================================
// Inventory endpoint — KV cached Discogs seller inventories
// ============================================================

async function handleInventory(seller, env) {
  // Validate seller name
  if (!/^[a-zA-Z0-9._-]+$/.test(seller)) {
    return json({ error: "Invalid seller name" }, 400);
  }

  const kvKey = `inv:${seller}`;

  // Check KV cache
  const cached = await env.INVENTORY_KV.get(kvKey, "json");
  if (cached && cached.ts && (Date.now() - cached.ts < CACHE_TTL)) {
    return json({
      seller,
      ids: cached.ids,
      count: cached.ids.length,
      cached: true,
      age: Math.round((Date.now() - cached.ts) / 60000),
    });
  }

  // Fetch fresh from Discogs
  try {
    const ids = await fetchDiscogsInventory(seller, env.DISCOGS_TOKEN);

    // Store in KV (expires in 24h as a safety net, but we use ts for freshness)
    await env.INVENTORY_KV.put(kvKey, JSON.stringify({
      ids,
      ts: Date.now(),
      seller,
    }), { expirationTtl: 86400 });

    return json({
      seller,
      ids,
      count: ids.length,
      cached: false,
      age: 0,
    });
  } catch (err) {
    // If fresh fetch fails but we have stale cache, return it
    if (cached && cached.ids) {
      return json({
        seller,
        ids: cached.ids,
        count: cached.ids.length,
        cached: true,
        stale: true,
        age: Math.round((Date.now() - cached.ts) / 60000),
      });
    }
    return json({ error: `Failed to fetch inventory: ${err.message}` }, 502);
  }
}

async function fetchDiscogsInventory(seller, token) {
  const ids = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${DISCOGS_API}/users/${encodeURIComponent(seller)}/inventory?per_page=100&page=${page}&sort=listed&sort_order=desc&token=${encodeURIComponent(token)}`;

    const resp = await fetch(url, {
      headers: { "User-Agent": "PortoWantlistTracker/3.0" },
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        // Rate limited — wait and retry
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`Discogs API error: ${resp.status}`);
    }

    const data = await resp.json();
    totalPages = data.pagination?.pages || 1;

    for (const listing of (data.listings || [])) {
      if (listing.release?.id) {
        ids.push(String(listing.release.id));
      }
    }

    page++;
    if (page <= totalPages) {
      await new Promise(r => setTimeout(r, 1050));
    }
  }

  return ids;
}

// ============================================================
// Helpers
// ============================================================

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
      "Cache-Control": status === 200 ? "public, max-age=300" : "no-cache",
    },
  });
}
