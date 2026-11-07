# Performance audit: http://localhost:8820/after.html

2026-11-07 10:54 UTC · Chrome 156.0.8078.80 · 3 cold run(s) per profile · lab data from this machine (not field data).

## Mobile (Slow 4G, 4x CPU)

| Metric | Median of 3 | Range | Good / poor | Rating |
| --- | --- | --- | --- | --- |
| TTFB | **1 ms** | 1 ms – 3 ms | 800 ms / 1800 ms | good |
| FCP | **652 ms** | 640 ms – 664 ms | 1800 ms / 3000 ms | good |
| LCP | **2772 ms** | 2768 ms – 2780 ms | 2500 ms / 4000 ms | needs improvement |
| CLS | **0.000** | 0.000 – 0.000 | 0.100 / 0.250 | good |
| TBT (lab) | **130 ms** | 130 ms – 130 ms | 200 ms / 600 ms | good |
| INP proxy (clicks) | **72 ms** | 56 ms – 104 ms | 200 ms / 500 ms | good |

**LCP element:** img (localhost:8820/img/hero-800.webp)  
Sub-parts (median run): TTFB 1 ms · resource load delay 603 ms · resource load time 2163 ms · render delay 5 ms. Fix the largest one first.

### Findings (leads - confirm in DevTools or code)

| # | Severity | Rule | What was measured | Suggested fix |
| --- | --- | --- | --- | --- |
| 1 | low | `uncompressed` | 1 text response(s) without gzip/brotli/zstd: localhost:8820/after.html (3.3 KB). | Enable brotli (or gzip) for text responses on the server/CDN. |
| 2 | low | `cache-short` | 7 same-site static asset(s) with no or short cache lifetime, e.g. localhost:8820/img/hero-800.webp (no cache-control); localhost:8820/app.js (no cache-control); localhost:8820/img/p1-480.webp (no cache-control); localhost:8820/img/p2-480.webp (no cache-control). | Fingerprinted assets: Cache-Control: public, max-age=31536000, immutable. Others: a sensible max-age plus ETag. |
| 3 | low | `image-oversized` | 4 image(s) much larger than displayed: localhost:8820/img/p1-480.webp 480px for 178px@1.75x (50 KB); localhost:8820/img/p2-480.webp 480px for 178px@1.75x (50 KB); localhost:8820/img/p3-480.webp 480px for 178px@1.75x (51 KB); localhost:8820/img/p4-480.webp 480px for 178px@1.75x (51 KB). | Serve responsive sizes (srcset + sizes, or the framework image component) close to rendered width × DPR. |

### Resources (median run)

| Type | Requests | Transferred | Decoded |
| --- | --- | --- | --- |
| Image | 5 | 272 KB | 271 KB |
| Document | 1 | 3.3 KB | 3.1 KB |
| Script | 2 | 1.5 KB | 1.1 KB |
| **Total** | **8** | **276 KB** | |

### Top main-thread scripts (long animation frames)

| Script | Time | Forced layout | Invoked by |
| --- | --- | --- | --- |
| localhost:8820/analytics.js | 181 ms | 0 ms | http://localhost:8820/analytics.js |

### Interactions

| Selector | Latency | Input delay | Handlers | Paint | Note |
| --- | --- | --- | --- | --- | --- |
| `.add` | 56 ms | 1 ms | 1 ms | 54 ms | button.add "Add to cart" |

DOM: 42 elements, depth 6 · JS heap after load: 1.4 MB · document http/1.0, 3.4 KB.

## Desktop (40 ms RTT, 10 Mbps, no CPU slowdown)

| Metric | Median of 3 | Range | Good / poor | Rating |
| --- | --- | --- | --- | --- |
| TTFB | **1 ms** | 1 ms – 1 ms | 800 ms / 1800 ms | good |
| FCP | **84 ms** | 72 ms – 88 ms | 1800 ms / 3000 ms | good |
| LCP | **408 ms** | 404 ms – 416 ms | 2500 ms / 4000 ms | good |
| CLS | **0.000** | 0.000 – 0.000 | 0.100 / 0.250 | good |
| TBT (lab) | **130 ms** | 130 ms – 130 ms | 200 ms / 600 ms | good |
| INP proxy (clicks) | **48 ms** | 48 ms – 56 ms | 200 ms / 500 ms | good |

**LCP element:** img (localhost:8820/img/hero-1200.webp)  
Sub-parts (median run): TTFB 1 ms · resource load delay 56 ms · resource load time 337 ms · render delay 14 ms. Fix the largest one first.

### Findings (leads - confirm in DevTools or code)

| # | Severity | Rule | What was measured | Suggested fix |
| --- | --- | --- | --- | --- |
| 1 | low | `uncompressed` | 1 text response(s) without gzip/brotli/zstd: localhost:8820/after.html (3.3 KB). | Enable brotli (or gzip) for text responses on the server/CDN. |
| 2 | low | `cache-short` | 7 same-site static asset(s) with no or short cache lifetime, e.g. localhost:8820/img/hero-1200.webp (no cache-control); localhost:8820/app.js (no cache-control); localhost:8820/img/p1-480.webp (no cache-control); localhost:8820/img/p2-480.webp (no cache-control). | Fingerprinted assets: Cache-Control: public, max-age=31536000, immutable. Others: a sensible max-age plus ETag. |
| 3 | low | `image-oversized` | 4 image(s) much larger than displayed: localhost:8820/img/p1-480.webp 480px for 173px@1x (50 KB); localhost:8820/img/p2-480.webp 480px for 173px@1x (50 KB); localhost:8820/img/p3-480.webp 480px for 173px@1x (51 KB); localhost:8820/img/p4-480.webp 480px for 173px@1x (51 KB). | Serve responsive sizes (srcset + sizes, or the framework image component) close to rendered width × DPR. |

### Resources (median run)

| Type | Requests | Transferred | Decoded |
| --- | --- | --- | --- |
| Image | 5 | 350 KB | 350 KB |
| Document | 1 | 3.3 KB | 3.1 KB |
| Script | 2 | 1.5 KB | 1.1 KB |
| **Total** | **8** | **355 KB** | |

### Top main-thread scripts (long animation frames)

| Script | Time | Forced layout | Invoked by |
| --- | --- | --- | --- |
| localhost:8820/analytics.js | 180 ms | 0 ms | http://localhost:8820/analytics.js |

### Interactions

| Selector | Latency | Input delay | Handlers | Paint | Note |
| --- | --- | --- | --- | --- | --- |
| `.add` | 56 ms | 0 ms | 0 ms | 56 ms | button.add "Add to cart" |

DOM: 42 elements, depth 6 · JS heap after load: 1.5 MB · document http/1.0, 3.4 KB.

---

Lab caveats: throttling is simulated on this machine; TBT is approximated from long tasks until the network settled; the INP proxy only covers the clicks you scripted. Compare runs made with the same arguments; confirm with field data (CrUX, RUM, Search Console) before claiming user impact.