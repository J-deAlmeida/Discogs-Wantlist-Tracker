// ============================================================
// Porto Wantlist Tracker — Cloudflare Worker (v2.0)
// ============================================================
// Generalized CORS proxy for checking record store websites.
// Discogs marketplace checks go direct from the frontend
// (no proxy needed — Discogs API supports browser CORS).
//
// Deploy: wrangler deploy
// ============================================================

const ALLOWED_DOMAINS = new Set([
  // 8mm Records
  "www.8mm-records.com",
  "8mm-records.com",
  // Louie Louie (Magento)
  "www.louielouie.pt",
  "louielouie.pt",
  // Matéria Prima (also has Discogs seller — web check is backup)
  "www.materiaprima.pt",
  "materiaprima.pt",
  // Porto Calling
  "portocalling.com",
  "www.portocalling.com",
  // Music and Riots (Shopify)
  "shopmusicandriots.com",
  "www.shopmusicandriots.com",
  // Socorro
  "socorro.pt",
  "www.socorro.pt",
  // Tubitek (via CDGO platform)
  "cdgo.com",
  "www.cdgo.com",
  "tubitek.pt",
  "www.tubitek.pt",
  // Discos do Baú
  "discosdobau.pt",
  "www.discosdobau.pt",
]);

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get("url");

    if (!target) {
      return json({ error: "Missing ?url= parameter" }, 400);
    }

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
      const resp = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; PortoWantlistTracker/2.0)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
      });

      const html = await resp.text();

      // --- Extract common page signals ---
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      const hasBasket = /add.to.(basket|cart|carrinho)/i.test(html);
      const hasPrice =
        /"price"/i.test(html) ||
        /€\s*\d/.test(html) ||
        /\d+[.,]\d{2}\s*€/.test(html);
      const hasBuyButton = /\b(buy|comprar|adicionar|add to)\b/i.test(html);
      const hasOutOfStock =
        /out.of.stock|esgotado|fora.de.stock|indispon/i.test(html);

      // --- Extra: grab meta description and og:title for richer matching ---
      const metaDesc =
        html.match(
          /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i
        )?.[1] || "";
      const ogTitle =
        html.match(
          /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i
        )?.[1] || "";

      return json({
        title,
        ogTitle,
        metaDesc,
        hasBasket,
        hasPrice,
        hasBuyButton,
        hasOutOfStock,
        status: resp.status,
        finalUrl: resp.url,
      });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  },
};

// --- Helpers ---

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
