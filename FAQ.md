# Wantlist Tracker — FAQ para developers

## "Os checks são live no momento? Tens data cached/scrapped das lojas?"

**São live, sim.** Quando carregas em "Check", a app faz requests em tempo real a cada loja. Não há nenhuma base de dados pré-carregada com inventários de lojas — cada check é fresco.

Mas há 3 estratégias diferentes conforme a loja:

### 1. Website search (Matéria Prima, Porto Calling, Socorro, M&R, Baú, Louie Louie, Flur, Vinyl Disc)
O browser faz GET/POST ao **Cloudflare Worker** → o Worker faz fetch ao site da loja → extrai título, preço, body text → devolve JSON ao browser → o frontend faz match por artista + título.

É literalmente o mesmo que ires ao site da loja e pesquisares. O Worker é só um proxy CORS.

### 2. GraphQL / Catalogue search (Peekaboo, Carpet & Snares)
Estas lojas usam a plataforma **Common Ground**, que tem uma API GraphQL pública. O browser chama directamente `peekaboorecords.pt/graphql` com um `query search($term)` — sem precisar do Worker. CORS totalmente aberto.

Devolve título, artista, preço, stock e URL do produto. É a API interna que o próprio site usa.

### 3. Discogs seller inventory (Bunker, Circus, Piranha)
Estas lojas vendem no Discogs Marketplace. O Worker faz fetch da inventory completa via Discogs API, guarda tudo no **Cloudflare KV** com TTL de 6 horas. Primeiro fetch pode demorar ~45s (Bunker tem ~4300 items), mas os seguintes são instantâneos.

O match é por **Discogs release ID** exacto — não é fuzzy, é literal.

---

## "Que stack é isto?"

- **Frontend**: HTML único (`index.html`), vanilla JS, zero frameworks, zero build step
- **Hosting**: GitHub Pages (branch `main`)
- **Backend**: Cloudflare Worker (free tier) com KV storage
- **APIs**: Discogs API, Common Ground GraphQL, sites das lojas via proxy

Literalmente um ficheiro HTML e um Worker. Sem React, sem Node, sem base de dados.

---

## "Os Shopify stores (M&R, Baú, Flur) — como funciona?"

Shopify expõe um endpoint `search/suggest.json` que devolve produtos em JSON. Tipo:

```
https://www.flur.pt/search/suggest.json?q=Aphex+Twin&resources[type]=product&limit=10
```

Não precisa de auth, não precisa de API key. O Worker faz proxy porque não tem CORS aberto.

---

## "E o Common Ground GraphQL? Como descobriste isso?"

Abri o DevTools no `peekaboorecords.pt`, fui ao Network tab, pesquisei um artista, e vi requests para `/graphql`. Depois fui buscar o JS bundle e extraí a query:

```graphql
query search($term: String!, $stocked: Boolean) {
  search(term: $term, stocked: $stocked) {
    items {
      id
      path
      data { title, artists { name }, labels { name, catno } }
      listings { available, stock { quantity } }
    }
  }
}
```

A 8mm Records, Carpet & Snares e Peekaboo usam todas Common Ground. O CORS é `*`, então o browser chama directamente — sem Worker.

Rate limit: 100 requests / 60 segundos por domínio.

---

## "O Worker tem rate limits?"

O Worker em si é Cloudflare free tier: 100k requests/dia, 10ms CPU time por request. Para uso pessoal e partilha com amigos, nem de perto chegas ao limite.

As lojas é que têm os seus limites. A app respeita-os com throttling:
- **Web search stores**: 4 em paralelo, 250ms entre batches
- **GraphQL stores**: 3 em paralelo, 700ms entre batches (Peekaboo e C&S correm em paralelo porque são servidores diferentes)
- **Discogs API**: 1 por segundo (rate limit oficial)
- **Louie Louie (Magento)**: 1 de cada vez, 1.5s entre cada — o servidor é frágil

---

## "Porque é que a Vinyl Disc tem 'confirm stock'?"

A Vinyl Disc não é uma loja online com carrinho. É mais uma montra — o site mostra o catálogo mas para comprar tens de contactar a loja. Não há botão de "Add to cart" nem indicação fiável de stock. Por isso o badge diz "confirm stock" para distinguir de lojas onde podes comprar directamente.

---

## "Os resultados são fiáveis? False positives?"

Depende do método:

| Método | Fiabilidade | Razão |
|--------|-------------|-------|
| Discogs seller (Bunker, Circus, Piranha) | Alta | Match por release ID exacto |
| GraphQL (Peekaboo, C&S) | Alta | Search por título+artista no catálogo real, com dados de stock |
| Shopify (M&R, Baú, Flur) | Boa | Título tem de estar no nome do produto, artista no vendor ou título |
| Web search (Matéria, Socorro, etc.) | Boa com caveats | Pode apanhar menções em descrições, recomendações, ou CDs quando queres vinil |

O badge amber "format may differ" aparece quando o match é por search (não por ID) e o item na wantlist não é vinil — porque a maioria destas lojas vende maioritariamente vinil.

---

## "Isto vai parar de funcionar se uma loja mudar o site?"

Sim, potencialmente. Cada loja tem a sua lógica de detecção (`detect` function). Se a Matéria Prima mudar o layout do site, ou a Flur mudar de Shopify, ou o Peekaboo mudar de Common Ground — a detecção para essa loja pode partir.

Na prática, stores on Shopify e Common Ground são estáveis porque são plataformas. Os mais frágeis são os custom sites como Matéria Prima e Socorro.

---

## "A 8mm não devia usar GraphQL também?"

A 8mm já funciona bem com web-direct — constrói a URL `/release/{discogs_id}/{slug}` e verifica se a página existe. É rápido e tem zero false positives porque usa o ID exacto do Discogs.

GraphQL seria melhor para encontrar *pressings diferentes* do mesmo álbum (match por título em vez de ID), mas para já o web-direct é mais preciso.

---

## "Posso contribuir / adicionar lojas?"

A arquitectura suporta 4 tipos de loja:
- `web` — URL directa com detecção de produto (8mm)
- `web-search` — pesquisa no site + match no body text (Matéria, Louie, Vinyl Disc)
- `graphql` — Common Ground GraphQL API (Peekaboo, C&S)
- `discogs` — Discogs seller com KV cache (Bunker, Circus, Piranha)

Para adicionar uma loja, precisas de:
1. Descobrir como pesquisar no site (inspect Network tab)
2. Escrever uma `detect` function que devolve `{s:"found"}` ou `{s:"no"}`
3. Adicionar o domínio ao `ALLOWED_DOMAINS` no Worker (se precisar de proxy)
4. Testar com uma wantlist real

---

## "Porque é que o token Discogs é preciso?"

Para aceder à wantlist. A API do Discogs permite ver wantlists públicas sem token, mas muitos users têm wantlists privadas. O token é um Personal Access Token que geras em `discogs.com/settings/developers`.

O token **nunca sai do teu browser** excepto nos headers do request ao Discogs (feito directamente do browser, não via Worker). O Worker só usa o seu próprio `DISCOGS_TOKEN` para buscar inventários de sellers.

---

## "Qual é o plano a longo prazo?"

Ideias que ficaram na mesa:
- Mais lojas em Lisboa (Groovie, Tabatô, TNT, Discolecção, Sound Club, etc.)
- Tubitek — `cdgo.com` bloqueia bots, precisa de solução alternativa
- Deep dive analytics — buscar géneros, país de release via Discogs API (mais calls)
- Localizador global de lojas usando Discogs sellers por localização
- Mobile responsiveness

---

*v0.5.6 · Março 2026 · github.com/J-deAlmeida/Discogs-Wantlist-Tracker*
