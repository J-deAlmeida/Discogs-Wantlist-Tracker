# FAQ

### What is this?

A tool that checks your [Discogs](https://www.discogs.com) wantlist against record stores in Porto and Lisbon, Portugal. It tells you which records on your wantlist are currently available at local stores — with direct links to each listing.

### Is it safe? What happens to my token?

Your Discogs token stays in your browser. It's only used to fetch your wantlist directly from the Discogs API — it's never sent to our server. The token is stored in your browser session and disappears when you close the tab.

### Are the checks live?

Yes. When you click "Check", the app searches each store in real time. There's no pre-built database of store inventories. It's the same as visiting each store's website and searching manually — just automated.

The only exception is stores that sell via Discogs Marketplace (Bunker, Circus, Piranha). Their inventories are cached for 6 hours to keep things fast.

### Why does checking take a while?

The app respects each store's server limits. It checks items in small batches with pauses between them to avoid overloading anyone's website. With 10+ stores and 100+ wantlist items, this adds up. You can skip slow stores anytime.

### What does "confirm stock" mean?

Some stores (like Vinyl Disc) show their catalogue online but don't have an "Add to cart" button — you need to contact the store to check availability. The "confirm stock" label flags these so you know to reach out before visiting.

### What does "format may differ" mean?

When the app searches a store by title instead of exact release ID, it might find a CD when you wanted vinyl (or vice versa). The amber badge appears when your wantlist item isn't vinyl and the match is title-based — most of these stores sell primarily vinyl.

### Which stores are supported?

**Porto**: 8mm Records, Matéria Prima, Porto Calling, Socorro, Music & Riots, Discos do Baú, Bunker Store, Circus Records, Piranha, Louie Louie, Vinyl Disc

**Lisbon**: Flur, Carpet & Snares, Peekaboo

### A store shows a result but the record isn't actually there?

It can happen with search-based stores. The app matches by artist + title in the store's search results, which occasionally picks up mentions in descriptions or recommendations rather than actual listings. Discogs-based stores and catalogue searches (Peekaboo, C&S) are more reliable since they match by exact ID or structured data.

### Can I use this on my phone?

It works in mobile browsers, though the experience is best on desktop. Mobile responsiveness improvements are planned.

### Who made this?

Built by [J. de Almeida](https://github.com/J-deAlmeida). Visit your neighbourhood record stores and shop locally.
