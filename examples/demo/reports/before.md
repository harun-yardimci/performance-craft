# Performance audit: http://localhost:8820/before.html

2026-11-07 10:51 UTC · Chrome 156.0.8078.80 · 3 cold run(s) per profile · lab data from this machine (not field data).

## Mobile (Slow 4G, 4x CPU)

| Metric | Median of 3 | Range | Good / poor | Rating |
| --- | --- | --- | --- | --- |
| TTFB | **1 ms** | 1 ms – 6 ms | 800 ms / 1800 ms | good |
| FCP | **3484 ms** | 3472 ms – 3504 ms | 1800 ms / 3000 ms | poor |
| LCP | **28112 ms** | 28100 ms – 28128 ms | 2500 ms / 4000 ms | poor |
| CLS | **0.154** | 0.154 – 0.205 | 0.100 / 0.250 | needs improvement |
| TBT (lab) | **0 ms** | 0 ms – 0 ms | 200 ms / 600 ms | good |
| INP proxy (clicks) | **424 ms** | 408 ms – 448 ms | 200 ms / 500 ms | needs improvement |

**LCP element:** section#hero.hero "Handmade ceramics, fired in small batches" (localhost:8820/img/hero.jpg)  
Sub-parts (median run): TTFB 1 ms · resource load delay 3471 ms · resource load time 24620 ms · render delay 20 ms. Fix the largest one first.

### Findings (leads - confirm in DevTools or code)

| # | Severity | Rule | What was measured | Suggested fix |
| --- | --- | --- | --- | --- |
| 1 | high | `page-heavy` | 4579 KB transferred in total (budget 1600 KB). | Start with the biggest types in the resource table (usually images and JS). |
| 2 | medium | `lcp-late-discovery` | LCP image is a CSS background, so the preload scanner cannot find it in the HTML (load delay 3471 ms). | Put the LCP image in the server HTML as <img> (or add <link rel="preload" as="image" fetchpriority="high">). |
| 3 | medium | `render-blocking` | 3 render-blocking resource(s): localhost:8820/before.css (1.4 KB, done at 1175 ms); localhost:8820/analytics.js (0.4 KB, done at 1166 ms); localhost:8820/vendor.js (351 KB, done at 3175 ms). | Inline critical CSS, load the rest async; add defer/async/type="module" to head scripts; drop unused stylesheets. |
| 4 | medium | `js-heavy` | 352 KB of JavaScript transferred (351 KB to parse and compile) in 2 files; budget 350 KB. | Code-split by route, lazy-load below-the-fold widgets, replace heavy dependencies, remove polyfills for modern browsers. |
| 5 | medium | `uncompressed` | 2 text response(s) without gzip/brotli/zstd: localhost:8820/before.html (1.9 KB); localhost:8820/vendor.js (351 KB). | Enable brotli (or gzip) for text responses on the server/CDN. |
| 6 | medium | `image-oversized` | 4 image(s) much larger than displayed: localhost:8820/img/p1.jpg 1600px for 178px@1.75x (805 KB); localhost:8820/img/p2.jpg 1600px for 178px@1.75x (796 KB); localhost:8820/img/p3.jpg 1600px for 178px@1.75x (814 KB); localhost:8820/img/p4.jpg 1600px for 178px@1.75x (806 KB). | Serve responsive sizes (srcset + sizes, or the framework image component) close to rendered width × DPR. |
| 7 | medium | `image-no-dimensions` | 4 image(s) near the top without width/height or aspect-ratio while CLS is 0.154: img "Speckled mug"; img "Stoneware bowl"; img "Bud vase"; img "Serving plate". | Give every <img> width and height attributes (or CSS aspect-ratio). |
| 8 | medium | `long-tasks` | 2 long task(s); longest 264 ms at 3178 ms. Main thread blocked for 0 ms after FCP. | See "Top main-thread scripts": split work (yield with scheduler.yield / setTimeout), defer non-critical JS, move heavy work to a Web Worker. |
| 9 | medium | `cls-sources` | Biggest shifts: 0.056 at 4347 ms by main#grid.grid "Speckled mug$28Add to cartStoneware bowl$42Add to ", section#hero.hero "Handmade ceramics, fired in small batches", header "Kiln & Co.Cart (0)"; 0.054 at 4095 ms by article.card "Bud vase$35Add to cart", article.card "Serving plate$56Add to cart", div "Speckled mug$28"; 0.030 at 4109 ms by div "Stoneware bowl$42", div "Bud vase$35", button.add "Add to cart"; 0.014 at 4126 ms by div "Serving plate$56", button.add "Add to cart". | Reserve space (dimensions, min-height for ads/embeds/banners), avoid inserting content above existing content, use font metric overrides (size-adjust). |
| 10 | medium | `slow-interaction` | Click on .add took 448 ms until the next paint; mostly event handlers (delay 2 ms, handlers 321 ms, paint 126 ms). | Show visual feedback first and defer the rest (await scheduler.yield / requestAnimationFrame+setTimeout), avoid large re-renders and forced layout in the handler. |
| 11 | medium | `unused-js` | ~348 KB of JS (uncompressed) never ran during load. Biggest: localhost:8820/vendor.js 99% unused of 351 KB (351 KB transferred). | Not all of it is dead code (some runs on interaction). Split route- and interaction-only code with dynamic import(); check for whole-library imports. |
| 12 | low | `js-file-big` | localhost:8820/vendor.js: 351 KB transferred (351 KB decoded). | Inspect with a bundle analyzer (source-map-explorer, @next/bundle-analyzer, rollup-plugin-visualizer) and split or trim it. |
| 13 | low | `cache-short` | 8 same-site static asset(s) with no or short cache lifetime, e.g. localhost:8820/before.css (no cache-control); localhost:8820/analytics.js (no cache-control); localhost:8820/vendor.js (no cache-control); localhost:8820/img/p1.jpg (no cache-control). | Fingerprinted assets: Cache-Control: public, max-age=31536000, immutable. Others: a sensible max-age plus ETag. |
| 14 | low | `image-format` | 5 large JPEG/PNG/GIF image(s): localhost:8820/img/p1.jpg (805 KB); localhost:8820/img/p2.jpg (796 KB); localhost:8820/img/p3.jpg (814 KB); localhost:8820/img/p4.jpg (806 KB). | Use AVIF or WebP (and MP4/WebM instead of animated GIF). |

### Resources (median run)

| Type | Requests | Transferred | Decoded |
| --- | --- | --- | --- |
| Image | 5 | 4224 KB | 4223 KB |
| Script | 2 | 352 KB | 351 KB |
| Document | 1 | 1.9 KB | 1.7 KB |
| Stylesheet | 1 | 1.4 KB | 1.2 KB |
| **Total** | **9** | **4579 KB** | |

### Top main-thread scripts (long animation frames)

| Script | Time | Forced layout | Invoked by |
| --- | --- | --- | --- |
| localhost:8820/vendor.js | 262 ms | 0 ms | http://localhost:8820/vendor.js |
| localhost:8820/analytics.js | 181 ms | 0 ms | http://localhost:8820/analytics.js |

### Interactions

| Selector | Latency | Input delay | Handlers | Paint | Note |
| --- | --- | --- | --- | --- | --- |
| `.add` | 448 ms | 2 ms | 321 ms | 126 ms | button.add "Add to cart" |

DOM: 42 elements, depth 6 · JS heap after load: 2.4 MB · document http/1.0, 2.0 KB.

## Desktop (40 ms RTT, 10 Mbps, no CPU slowdown)

| Metric | Median of 3 | Range | Good / poor | Rating |
| --- | --- | --- | --- | --- |
| TTFB | **2 ms** | 1 ms – 2 ms | 800 ms / 1800 ms | good |
| FCP | **664 ms** | 660 ms – 668 ms | 1800 ms / 3000 ms | good |
| LCP | **4096 ms** | 4096 ms – 4096 ms | 2500 ms / 4000 ms | poor |
| CLS | **0.043** | 0.043 – 0.043 | 0.100 / 0.250 | good |
| TBT (lab) | **0 ms** | 0 ms – 0 ms | 200 ms / 600 ms | good |
| INP proxy (clicks) | **384 ms** | 360 ms – 384 ms | 200 ms / 500 ms | needs improvement |

**LCP element:** section#hero.hero "Handmade ceramics, fired in small batches" (localhost:8820/img/hero.jpg)  
Sub-parts (median run): TTFB 2 ms · resource load delay 658 ms · resource load time 3429 ms · render delay 8 ms. Fix the largest one first.

### Findings (leads - confirm in DevTools or code)

| # | Severity | Rule | What was measured | Suggested fix |
| --- | --- | --- | --- | --- |
| 1 | high | `page-heavy` | 4579 KB transferred in total (budget 1600 KB). | Start with the biggest types in the resource table (usually images and JS). |
| 2 | medium | `lcp-late-discovery` | LCP image is a CSS background, so the preload scanner cannot find it in the HTML (load delay 658 ms). | Put the LCP image in the server HTML as <img> (or add <link rel="preload" as="image" fetchpriority="high">). |
| 3 | medium | `render-blocking` | 3 render-blocking resource(s): localhost:8820/before.css (1.4 KB, done at 106 ms); localhost:8820/analytics.js (0.4 KB, done at 107 ms); localhost:8820/vendor.js (351 KB, done at 388 ms). | Inline critical CSS, load the rest async; add defer/async/type="module" to head scripts; drop unused stylesheets. |
| 4 | medium | `js-heavy` | 352 KB of JavaScript transferred (351 KB to parse and compile) in 2 files; budget 350 KB. | Code-split by route, lazy-load below-the-fold widgets, replace heavy dependencies, remove polyfills for modern browsers. |
| 5 | medium | `uncompressed` | 2 text response(s) without gzip/brotli/zstd: localhost:8820/before.html (1.9 KB); localhost:8820/vendor.js (351 KB). | Enable brotli (or gzip) for text responses on the server/CDN. |
| 6 | medium | `image-oversized` | 4 image(s) much larger than displayed: localhost:8820/img/p1.jpg 1600px for 173px@1x (805 KB); localhost:8820/img/p2.jpg 1600px for 173px@1x (796 KB); localhost:8820/img/p3.jpg 1600px for 173px@1x (814 KB); localhost:8820/img/p4.jpg 1600px for 173px@1x (806 KB). | Serve responsive sizes (srcset + sizes, or the framework image component) close to rendered width × DPR. |
| 7 | medium | `long-tasks` | 2 long task(s); longest 261 ms at 389 ms. Main thread blocked for 0 ms after FCP. | See "Top main-thread scripts": split work (yield with scheduler.yield / setTimeout), defer non-critical JS, move heavy work to a Web Worker. |
| 8 | medium | `slow-interaction` | Click on .add took 384 ms until the next paint; mostly event handlers (delay 0 ms, handlers 320 ms, paint 64 ms). | Show visual feedback first and defer the rest (await scheduler.yield / requestAnimationFrame+setTimeout), avoid large re-renders and forced layout in the handler. |
| 9 | medium | `unused-js` | ~348 KB of JS (uncompressed) never ran during load. Biggest: localhost:8820/vendor.js 99% unused of 351 KB (351 KB transferred). | Not all of it is dead code (some runs on interaction). Split route- and interaction-only code with dynamic import(); check for whole-library imports. |
| 10 | low | `js-file-big` | localhost:8820/vendor.js: 351 KB transferred (351 KB decoded). | Inspect with a bundle analyzer (source-map-explorer, @next/bundle-analyzer, rollup-plugin-visualizer) and split or trim it. |
| 11 | low | `cache-short` | 8 same-site static asset(s) with no or short cache lifetime, e.g. localhost:8820/before.css (no cache-control); localhost:8820/analytics.js (no cache-control); localhost:8820/vendor.js (no cache-control); localhost:8820/img/p1.jpg (no cache-control). | Fingerprinted assets: Cache-Control: public, max-age=31536000, immutable. Others: a sensible max-age plus ETag. |
| 12 | low | `image-format` | 5 large JPEG/PNG/GIF image(s): localhost:8820/img/p1.jpg (805 KB); localhost:8820/img/p2.jpg (796 KB); localhost:8820/img/p3.jpg (814 KB); localhost:8820/img/p4.jpg (806 KB). | Use AVIF or WebP (and MP4/WebM instead of animated GIF). |

### Resources (median run)

| Type | Requests | Transferred | Decoded |
| --- | --- | --- | --- |
| Image | 5 | 4224 KB | 4223 KB |
| Script | 2 | 352 KB | 351 KB |
| Document | 1 | 1.9 KB | 1.7 KB |
| Stylesheet | 1 | 1.4 KB | 1.2 KB |
| **Total** | **9** | **4579 KB** | |

### Top main-thread scripts (long animation frames)

| Script | Time | Forced layout | Invoked by |
| --- | --- | --- | --- |
| localhost:8820/vendor.js | 261 ms | 0 ms | http://localhost:8820/vendor.js |
| localhost:8820/analytics.js | 180 ms | 0 ms | http://localhost:8820/analytics.js |

### Interactions

| Selector | Latency | Input delay | Handlers | Paint | Note |
| --- | --- | --- | --- | --- | --- |
| `.add` | 384 ms | 0 ms | 320 ms | 64 ms | button.add "Add to cart" |

DOM: 42 elements, depth 6 · JS heap after load: 2.5 MB · document http/1.0, 2.0 KB.

---

Lab caveats: throttling is simulated on this machine; TBT is approximated from long tasks until the network settled; the INP proxy only covers the clicks you scripted. Compare runs made with the same arguments; confirm with field data (CrUX, RUM, Search Console) before claiming user impact.