# Quick wins and generated-code tells

Use this as the checklist for Build mode, pre-launch audits and broad reviews. Each item says how to detect it, so an audit can confirm or rule it out instead of just asserting it. `S:` = `static_perf_audit.py` rule, `P:` = `perf_audit.mjs` finding.

## The checklist

| # | Win | Layer | Detect | Fix (details in the platform reference) |
| --- | --- | --- | --- | --- |
| 1 | **Skeleton loading screens** | UI | Blank screen or full-page spinner while data loads (interface-craft `render_audit.mjs --slow`, app on throttled network) | Skeleton with the real layout's dimensions in the first frame/HTML; keep stale content visible while refreshing |
| 2 | **Modern image formats (WebP/AVIF)** | Web/app assets | P:`image-format`, S:`big-asset` | AVIF/WebP via the framework image component or CDN transform; HEIC/WebP in apps; MP4 instead of GIF |
| 3 | **Prevent duplicate API calls** | Client/API | Network panel: same request twice on load (React StrictMode dev double-mount is not a prod bug), double submit, every component fetching the same resource | Query cache with request dedupe (TanStack Query, SWR, RTK Query, Apollo), disable button while pending, idempotency keys for writes, `AbortController` to cancel stale requests |
| 4 | **Debounce search / autocomplete** | Client | S:`search-no-debounce`; one request per keystroke in the network panel | Debounce 200-300 ms + cancel previous request; `useDeferredValue`; min length; cache recent queries |
| 5 | **Paginate API results** | API/DB | S:`unbounded-query`; responses > 100 KB or growing with data | Cursor/keyset pagination (`WHERE id > ? ORDER BY id LIMIT ?`), page-size cap on the server, infinite scroll with virtualization |
| 6 | **Static files through a CDN** | Infra | Assets served from the app server; high TTFB for static files from far regions | CDN in front of static assets (and cacheable HTML); hashed filenames + long cache |
| 7 | **Slow tasks to a background job queue** | Backend | Requests that send email, resize images, call slow third parties, generate PDFs/reports synchronously; p95 dominated by one external call | Queue (Laravel queues/Horizon, BullMQ, Celery, Sidekiq, Cloud Tasks); return 202 + status endpoint or push/webhook |
| 8 | **Fix N+1 queries** | DB | S:`query-in-loop`; query count per request in logs/debugbar/APM grows with rows | Eager loading (`with()`, `include`, `select_related`/`prefetch_related`, `JOIN`), batch by ids (`WHERE id IN`), DataLoader for GraphQL |
| 9 | **Brotli / Gzip compression** | Infra | P:`uncompressed`; `content-encoding` missing on text responses | Enable brotli (fallback gzip) at CDN/reverse proxy for HTML, JS, CSS, JSON, SVG |
| 10 | **Cache frequently accessed data** | Backend/client | Same expensive query/compute on every request; read-heavy endpoints | Redis/memory cache with TTL and explicit invalidation, HTTP caching (`Cache-Control`, `ETag`, `stale-while-revalidate`), memoized selectors; never share per-user data across users |
| 11 | **Remove unused dependencies** | Bundle/app size | S:`heavy-dependency`, S:`heavy-import`, P:`unused-js`; `npx depcheck` / `knip` | Remove or replace (moment → Intl/dayjs, lodash → native/lodash-es); per-function imports |
| 12 | **Timeouts for external APIs** | Backend/client | S:`no-timeout`; hung requests in APM; worker pool exhaustion | Connect + read timeouts on every outgoing call, retries with backoff + jitter only for idempotent calls, circuit breaker for flaky dependencies |
| 13 | **Stream AI responses token by token** | AI features | S:`ai-not-streamed`; users stare at a spinner for the full generation | Streaming API (SSE/`stream: true`), render tokens as they arrive, show first token fast; cache repeated prompts; smaller/faster model for simple steps |
| 14 | **Optimistic UI** | Client | Every like/toggle/reorder waits for the round trip | Update locally first, send in background, roll back + message on failure; only for actions that almost always succeed and are reversible |
| 15 | **Lazy-load images below the fold** | Web/app | P:`image-offscreen-eager`; S:`img-no-dimensions` | `loading="lazy"` + `decoding="async"` below the fold (never on the LCP image); lazy lists in apps load images per visible row |
| 16 | **Run independent requests in parallel** | Client/backend | S:`serial-awaits`; waterfalls in the network panel or trace | `Promise.all` / `Promise.allSettled`, `async let` / `TaskGroup` (Swift), `coroutineScope { async {} }` (Kotlin), parallel server components / loaders; keep ordering where it matters |
| 17 | **Database indexes for common queries** | DB | Slow-query log, `EXPLAIN` shows sequential/full scans, `Using filesort` | Index columns in `WHERE`, `JOIN`, `ORDER BY` of hot queries (composite in the right order), check with `EXPLAIN ANALYZE`; drop unused indexes on write-heavy tables |
| 18 | **Trace slow backend requests** | Observability | No per-request timing, "it's slow sometimes" | APM / OpenTelemetry traces, `Server-Timing` header, slow-request logging with query counts and durations |
| 19 | **Servers close to users** | Infra | High TTFB from user regions vs. near the server | Region near users, edge caching/rendering for public pages, read replicas near users; keep DB and app in the same region |
| 20 | **Render on the server or at build time** | Web | P:`lcp-render-delay`; blank HTML (view-source shows an empty root div) | SSR/SSG/ISR or server components for content pages; ship less client JS; stream HTML |
| 21 | **Load third-party scripts late** | Web | P:`third-party`; tag manager/chat/analytics in "Top main-thread scripts" | Remove unused tags; `async`/`defer`; load after interaction or idle; facades for chat/video/maps; Partytown-style workers where safe |
| 22 | **Split JavaScript by page** | Web | P:`js-heavy`, P:`unused-js`; one big bundle for every route | Route-level code splitting (default in Next/Nuxt/SvelteKit), `import()` for heavy widgets/modals/charts/editors |
| 23 | **Virtualize long lists** | Web/app | S:`list-not-virtualized`; DOM > 1500 nodes (P:`dom-large`), scroll jank | `@tanstack/react-virtual`, `react-window`; `LazyVStack`/`List` (SwiftUI), `LazyColumn` (Compose), `FlashList`/`FlatList` (RN), `ListView.builder` (Flutter) |
| 24 | **Database connection pooling** | Backend | S:`connection-per-call`; "too many connections", connection setup in traces, serverless cold connections | One pool per process (Prisma singleton, `pg.Pool`, PgBouncer/RDS Proxy/Supabase pooler for serverless), sized to DB limits |
| 25 | **Prevent unnecessary re-renders** | Client | React Profiler / why-did-you-render, SwiftUI `Self._printChanges()`, Compose recomposition counts | Stable props, memoization where profiled (React Compiler), split state/context, derived state, stable list keys |
| 26 | **Browser caching** | Web | P:`cache-short`, `--repeat` re-downloads > 30% | Hashed assets `Cache-Control: public, max-age=31536000, immutable`; HTML `no-cache` + ETag or short `s-maxage` + `stale-while-revalidate` |
| 27 | **Load-balance traffic across servers** | Infra | One instance pinned at 100% CPU, others idle; no horizontal scaling | Load balancer + stateless app instances (sessions in Redis/DB), health checks, autoscaling on CPU/latency |
| 28 | **Self-host fonts** | Web | S:`google-fonts-link`, P:`font-display`, P:`fonts-heavy` | Self-host WOFF2 subsets (`next/font`, Fontsource), `font-display: swap/optional`, preload 1-2 critical files, fewer weights or one variable font |
| 29 | **Track real-user performance (RUM)** | Observability | No field data | `web-vitals` → analytics/RUM; Sentry/Datadog RUM; MetricKit (iOS); Firebase Performance / Play vitals (Android) |
| 30 | **Test with a performance tool before shipping** | Process | No baseline, no CI gate | `perf_audit.mjs --budget --fail-on-budget` or Lighthouse CI on key routes; Macrobenchmark / XCTest metrics for apps; load test (k6, autocannon, hey) for APIs |

Additional wins often missed: HTTP/2-3 (P:`http1`), removing redirect chains (P:`redirects`), `fetchpriority="high"` / preload for the LCP image (P:`lcp-priority`), reserving space for images/ads/embeds (P:`cls-sources`), prefetching the next likely route/screen, reducing JSON payloads (select only needed fields, gzip, avoid N× nested includes), `content-visibility: auto` for long pages, Web Workers / isolates / background threads for heavy parsing.

## Perceived performance
Speed people feel is not only milliseconds:
- **Respond within 100 ms** to every tap/click (pressed state, spinner on the button, optimistic change), even if the work takes longer.
- **Show structure immediately**: skeletons shaped like the content, cached previous data, progressive images (blur placeholder).
- **Stream**: HTML streaming / Suspense boundaries, AI tokens, paginated first page first.
- **Prefetch**: next route on hover/viewport, next screen's data after the current one settles, images for the next carousel item.
- **Don't block**: never a full-screen spinner over content the user could already read; long tasks get progress, not an indeterminate spinner.
- Do not fake it: skeletons must resolve, progress must reflect real work (see interface-craft hard rules).

## Performance tells of AI-generated ("vibe-coded") code
Generated code usually works on sample data and fails at real scale. Check for these first in such codebases:
- **Fetch-everything**: `findMany()` / `SELECT *` / `Model::all()` without limit, then filtering/sorting/paginating in JavaScript or in the client.
- **Loops of awaits**: `for (const x of items) await db.find(...)` or `await fetch(...)` per item (N+1 and serial latency).
- **Client-side joins**: fetching list A, then one request per item for B.
- **Duplicate fetching**: the same `useEffect(fetch)` in several components; refetch on every focus/mount with no cache; effects with missing or unstable dependencies that refetch in a loop.
- **No limits anywhere**: no timeouts, no pagination, no max upload size, no rate limiting, unbounded retries.
- **New client per call**: `new PrismaClient()`, `createConnection()`, `new OpenAI()` / HTTP clients created inside handlers.
- **Everything client-rendered**: a `"use client"` at the top of every Next.js file; huge client bundles; data fetched in the browser that could be server-rendered.
- **Heavy libraries for small jobs**: moment for one date format, lodash for `map`, a chart library on a page that shows one number, full icon packs.
- **Images straight from uploads**: original 4000 px photos rendered at 300 px; no responsive sizes; no CDN.
- **Polling instead of events**: `setInterval(fetch, 1000)` that never stops (also when the tab is hidden).
- **Synchronous work in hot paths**: JSON parsing of large payloads, crypto, image processing, `readFileSync` in request handlers, formatters created inside render.
- **Missing indexes**: schema files with foreign keys and filter columns that have no index.
- **Unbounded state**: arrays/caches that only grow (chat history, logs, listeners), never cleaned up on unmount.
- **AI calls without streaming or caching**: full generation awaited before showing anything; the same prompt sent repeatedly; the largest model used for trivial classification.

For each confirmed tell, measure its effect (query count, request waterfall, bundle size, p95) before and after the fix.
