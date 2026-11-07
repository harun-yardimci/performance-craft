# Web performance

Start from `perf_audit.mjs` output (or field data), pick the failing metric, and work through its causes in order. Confirm framework APIs against the project's versions in current docs.

## LCP (Largest Contentful Paint) - "the page loads slowly"
Fix the largest of the four sub-parts first (reported by `perf_audit.mjs`):

| Sub-part | Typical share when healthy | Causes | Fixes |
| --- | --- | --- | --- |
| TTFB | ~40% | Slow server render, uncached HTML, DB calls before first byte, redirects, far region, cold serverless | Cache HTML at CDN/edge (`s-maxage` + `stale-while-revalidate`), SSG/ISR for public pages, stream HTML, fix slow queries, remove redirect chains, region near users, warm functions |
| Resource load delay | < 10% | LCP image is a CSS background, inserted by JS, behind client rendering, `loading="lazy"`, low priority | Real `<img>` in server HTML; `fetchpriority="high"`; `<link rel="preload" as="image" imagesrcset=…>` when it must stay a background; never lazy-load it |
| Resource load time | ~40% | Oversized image, legacy format, slow origin, bandwidth stolen by other requests | Responsive `srcset`/`sizes`, AVIF/WebP, CDN image transforms, fewer competing early requests |
| Render delay | < 10% | Render-blocking CSS/JS, web fonts hiding text, hydration/client rendering, long tasks | Inline critical CSS, `defer`/`type="module"` scripts, `font-display: swap/optional`, server-render the LCP element, break up long tasks |

Text LCP has no resource parts: TTFB + render delay only. If LCP is a hero video poster or slider, make the first slide static HTML.

## INP (Interaction to Next Paint) - "clicks feel laggy"
INP = input delay + processing (handlers) + presentation delay (render/paint after the handler). `perf_audit.mjs --interact` measures scripted clicks; field INP needs RUM (`web-vitals` `onINP` with attribution, which carries the Long Animation Frames script attribution: send `attribution.longAnimationFrameEntries` or the summarised script URL/function with the beacon so production INP points at a file, not just an element). For SPAs, soft-navigation reporting is still experimental: route changes do not reset LCP/CLS in most RUM setups, so segment by route yourself.

| Part | Causes | Fixes |
| --- | --- | --- |
| Input delay | Main thread busy with other work: hydration, third-party scripts, timers, long tasks during load | Defer non-critical JS, reduce/postpone third parties, split long tasks (yield with `scheduler.yield()` where supported, else `setTimeout(0)`), hydrate less (server components, islands) |
| Processing | Expensive handlers: big state updates, synchronous filtering/sorting of large arrays, JSON parsing, analytics in the handler | Do the visible update first and defer the rest (`await scheduler.yield()` / `requestAnimationFrame` + `setTimeout`), `startTransition` / `useDeferredValue`, move heavy work to a Web Worker, debounce input handlers |
| Presentation | Large re-render, huge DOM, layout thrashing (read-write-read of layout), expensive CSS (big blur/shadows), forced synchronous layout | Smaller render scope (memoization, split components/state), virtualization, `content-visibility: auto`, batch DOM reads before writes, avoid animating layout properties |

## CLS (Cumulative Layout Shift) - "things jump around"
- Images/video/iframes without dimensions → `width`/`height` attributes or `aspect-ratio`.
- Ads, embeds, banners, cookie bars, "app install" bars injected above content → reserve space (`min-height`) or overlay them; insert new content below the viewport or on user action.
- Web fonts swapping with different metrics → `size-adjust`/`ascent-override` fallbacks (`next/font` does this), `font-display: optional`.
- Late-loading content above existing content (e.g. a fetched notice at the top) → skeleton with the final height.
- Animations of `top/left/height/width` → animate `transform`/`opacity`.
- Back/forward: ensure the page is eligible for the back/forward cache (bfcache): no `unload` handlers (`pagehide` instead), no `Cache-Control: no-store` on HTML unless required, no open `BroadcastChannel`/IndexedDB transactions at navigation; check DevTools → Application → Back/forward cache. A bfcache hit is an instant navigation with zero CLS.
- SPA route changes and reorders: the View Transitions API (`document.startViewTransition`, framework wrappers) animates between states instead of letting content jump; it does not reduce a measured CLS by itself, but it removes the perceived jump.

## TTFB and server rendering
- View source: if the HTML has an empty root div, everything waits for JS. Prefer SSR/SSG/ISR or server components for content.
- Cache what can be cached: full HTML for anonymous pages at the CDN; data caches per request scope; avoid per-request work that can be done at build time.
- Stream: send the shell and above-the-fold content first (React Suspense/streaming, `<Suspense>` boundaries around slow data).
- Avoid sequential data waterfalls in loaders/server components: start independent fetches together.
- `Server-Timing` header exposes backend phases in DevTools; add it for diagnosis.
- Early Hints (HTTP 103): when the trace shows slow HTML generation and a stable set of critical subresources, send `103` with `Link: </hero.webp>; rel=preload; as=image` / `rel=preconnect` before the final response (needs HTTP/2+, origin or CDN support). Only proven critical resources; wrong hints waste bandwidth. Measure; vendor case studies are not your result.

## JavaScript cost
- Every KB of JS costs download + parse + compile + execute; on a mid-range phone ~1 MB of JS can cost seconds of main-thread time.
- Measure: `perf_audit.mjs` (`js-heavy`, `unused-js`, top scripts), bundle analyzers (`@next/bundle-analyzer`, `rollup-plugin-visualizer`, `source-map-explorer`, `vite-bundle-visualizer`), `npx knip`/`depcheck` for unused deps.
- Reduce: route splitting, `import()` for modals/charts/editors/maps, tree-shakable imports, drop polyfills for modern targets (check `browserslist`), replace heavy libs, remove dead feature flags, ship ES modules.
- Hydration: hydrate less (server components, partial/islands hydration, `client:visible`-style directives), avoid making whole layouts client components.
- Long tasks: break work > 50 ms into chunks; move parsing/crypto/image work to Web Workers.

## Images and media
- Right size: rendered width × DPR (`srcset` + accurate `sizes`), framework components (`next/image`, `@nuxt/image`, `astro:assets`, `@unpic`), or CDN transforms (Cloudinary, imgix, Vercel/Netlify image CDNs).
- Right format: AVIF > WebP > JPEG; SVG for icons/illustrations (minified, or a sprite); MP4/WebM instead of GIF (`<video autoplay muted loop playsinline>`).
- Priority: LCP image eager + `fetchpriority="high"`; everything below the fold `loading="lazy"` + `decoding="async"`.
- Dimensions on every image; blur/LQIP placeholders for large photos.
- Video: `preload="none"` or `metadata` below the fold, poster image, facades for YouTube/Vimeo embeds.

## Fonts
- Self-host WOFF2 (Google Fonts adds two extra origins): `next/font`, Fontsource, or downloaded files.
- Subset: latin + latin-ext covers Turkish (ç ğ ı İ ö ş ü); do not ship unused scripts.
- Fewer files: 2-3 weights or one variable font.
- `font-display: swap` (or `optional` for body text to avoid CLS); preload only the 1-2 fonts used above the fold, with `crossorigin`.
- Metric-matched fallbacks (`size-adjust`) to avoid layout shift.

## Network and caching
- Compression: brotli for text (HTML, JS, CSS, JSON, SVG); never compress already-compressed images/video.
- Cache headers: hashed assets `public, max-age=31536000, immutable`; HTML `no-cache` (revalidate) or short `s-maxage` with `stale-while-revalidate`; API responses with `ETag`/`Last-Modified` where safe; `private` for per-user data.
- HTTP/2 or HTTP/3; fewer origins; `preconnect` only to 1-3 critical third-party origins used early.
- Service worker caching for repeat visits/offline (Workbox), with a clear update strategy.
- Prefetch likely next navigations (framework `<Link prefetch>`, Speculation Rules API where supported) without prefetching everything.
- Request hygiene: dedupe identical requests (query cache), cancel stale ones (`AbortController`), debounce typing, batch small calls, avoid chatty APIs (one request per row).

## Third parties
- Inventory with the "Third parties" table; ask what each tag is for. Remove unused ones first.
- Load late: after `load`, on idle, on interaction (chat widgets, video, maps behind a facade/click).
- Tag managers: audit triggers; consolidate duplicate analytics; consider server-side tagging.
- A/B testing scripts that hide the page (anti-flicker snippets) directly hurt LCP: limit to tested pages and short timeouts.

## Rendering and runtime
- DOM size: keep under ~1500 elements on initial render; virtualize lists and tables; render hidden tabs/menus lazily.
- CSS: avoid huge selectors on large DOMs, `transition: all`, animating layout properties, large `backdrop-filter`/blur areas, fixed backgrounds with big images.
- Scroll: passive listeners (`{ passive: true }`), no layout reads in scroll handlers (use `IntersectionObserver`, `ResizeObserver`), `position: sticky` instead of scroll-driven JS where possible.
- Memory leaks: listeners, intervals, observers, subscriptions not cleaned up on unmount; detached DOM nodes. DevTools → Memory → heap snapshots before/after repeating an action 5-10 times; growth that never drops is a leak.
- Tab hidden: pause polling/animations (`document.visibilityState`).

## React
- Profile first: React DevTools Profiler ("Highlight updates", record an interaction), `why-did-you-render` in dev.
- React Compiler (stable since React Compiler 1.0) auto-memoizes; otherwise `memo`, `useMemo`, `useCallback` only where the profiler shows waste.
- Keep state close to where it is used; split big contexts (or use selectors - Zustand, Jotai, `use-context-selector`); avoid putting fast-changing values (mouse position, input text) in a top-level context.
- Stable `key`s (not array index for reorderable lists).
- `useTransition`/`startTransition` for non-urgent updates; `useDeferredValue` for filtering large lists while typing.
- Data: a query cache (TanStack Query/SWR/RTK Query) for dedupe, caching and background refresh; fetch on the server where possible (server components, loaders).
- Effects: no data fetching in effects with unstable dependencies; no `setState` in an effect that triggers itself.
- StrictMode double-invokes effects in development only; do not "fix" that in production code.

## Next.js
- Server components by default; `"use client"` only on interactive leaves, not layouts/pages.
- `next/image` with correct `sizes`; mark the LCP image as priority (the prop name changed across versions - check the installed version's docs); `next/font` for fonts; `next/script` with `strategy="lazyOnload"`/`"afterInteractive"` for third parties.
- Caching and rendering mode per route (static, ISR/revalidate, dynamic): check the version's caching semantics in docs - they changed between Next 13, 14, 15 and 16.
- Avoid request waterfalls in server components (start fetches in parallel, use `Promise.all`, preload pattern); use `<Suspense>` to stream slow parts.
- Analyze bundles with `@next/bundle-analyzer`; check `optimizePackageImports` for icon/UI libraries.
- Middleware runs on every matched request: keep it tiny and narrow its `matcher`.

## Vue / Nuxt, Svelte / SvelteKit, Astro, Angular
- Nuxt: `useFetch`/`useAsyncData` with keys (dedupe), `lazy` for non-critical data, `@nuxt/image`, route rules for caching/ISR, `<ClientOnly>` sparingly.
- Vue: `v-memo`, `shallowRef` for big immutable data, `v-once` for static parts, computed over watchers, virtual lists for long data.
- SvelteKit: `load` in parallel, streaming promises, prerender static routes, `data-sveltekit-preload-data`.
- Astro: keep islands minimal, `client:visible`/`client:idle` over `client:load`.
- Angular: `OnPush`/signals, `@defer` blocks, `trackBy`/`track` in loops, `NgOptimizedImage`, SSR with hydration.

## Laravel / Blade / classic server-rendered sites
- Turn on production caches (`config:cache`, `route:cache`, `view:cache`, `event:cache`), OPcache (+ JIT where useful), `composer install --optimize-autoloader --no-dev`.
- Vite build for assets with hashing; serve `public/build` with long cache via the web server/CDN.
- Eager loading everywhere lists render relations (`with()`); `Model::preventLazyLoading()` in non-production to catch N+1.
- Queue mail/notifications/exports; cache expensive view fragments.
- Old admin templates (AdminLTE/jQuery plugins) load dozens of scripts on every page: load per page, defer, drop unused plugins.

## Vite / build tooling
- `build.rollupOptions.output.manualChunks` only when the default splitting is poor; avoid one giant vendor chunk that changes every deploy.
- `build.target` matching your browser support; modern targets avoid transpiling to ES5.
- Check `import.meta.glob` and barrel files (`index.ts` re-exporting everything) that pull whole folders into a chunk.
- Preview the production build (`vite build && vite preview`) for audits.
