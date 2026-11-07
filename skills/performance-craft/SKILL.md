---
name: performance-craft
description: Measure, diagnose and fix performance across web, mobile apps and their backends - load time, Core Web Vitals (LCP/INP/CLS), bundle size, jank, slow lists, app launch, hangs, memory, battery, slow APIs, N+1 queries, caching, database and network. Use for broad requests like "this is slow", "performance audit", "speed up the site/app", "Lighthouse score is low", "Core Web Vitals failing", "app launch is slow", "scrolling stutters", "screen freezes", "API is slow", "too many requests", "bundle is too big", "optimize before launch", "vibe-coded app is slow", "site yavaş", "uygulama yavaş açılıyor", "kaydırma takılıyor", "performans denetimi yap", "sayfa geç yükleniyor", "API yavaş", "donma var", "pil çok yiyor". For visual loading states only (skeleton looks, blank-while-loading UX) prefer interface-craft; for a single SQL query prefer direct EXPLAIN work. Not for security or pure code-style reviews.
---

# Performance Craft

Infer the mode from the request; do not present a menu:
- **Review**: measure and report actionable findings; do not edit.
- **Improve**: measure a baseline, implement scoped fixes, re-measure under the same conditions.
- **Build**: write new code with these defaults from the start (see [quick wins](references/quick-wins.md)); add a budget and a measurement hook so regressions show up.

**Scope the work to the complaint.** Broad requests ("audit performance", "make it faster"): cover every layer the product has (client load, client runtime, network/API, backend/DB) and both form factors. Narrow requests ("scrolling stutters on the feed", "LCP is red"): measure and fix that path only, plus anything your change can regress. Change only what a measurement or a clear code lead points at.

**No number, no claim.** Every finding names the measurement or code location it came from. Never promise a speed-up you did not measure; say "expected to reduce X" for unmeasured fixes and mark them "Not verified".

## Workflow
1. **Frame**: what is slow, for whom, where (page/screen/endpoint), on which device and network, and which user action. Pick the metric that matches the complaint: load → LCP/FCP/TTFB (web), cold/warm start (apps); responsiveness → INP / hangs / main-thread time; smoothness → dropped frames / hitches; visual stability → CLS; API → p50/p95/p99 latency and throughput; resources → memory, battery, data. Find the stack (framework, versions, build tool, hosting, DB) from the repo before suggesting APIs.
2. **Baseline (measure before touching code)**, on realistic conditions ([measurement](references/measurement.md)):
   - **Public URL with traffic**: `node scripts/field_data.mjs <url>` first (CrUX p75 per form factor; `CRUX_API_KEY` preferred, PageSpeed Insights fallback). Field data decides *what* users suffer from; lab data decides *why*. Read it with the rules in [measurement](references/measurement.md): URL scope over origin, phone and desktop separately, "no data" is not a pass. Also ask for RUM/Search Console when they exist.
   - **Web page reachable by URL/dev server/production build**: `node scripts/perf_audit.mjs <url> --out perf-audit` (mobile + desktop, 3 cold runs, medians). Add `--interact "<safe selectors>"` for INP complaints, `--scroll` for jank, `--repeat` for caching, `--storage-state` for logged-in pages. Audit a production build (`next build && next start`, `vite build && vite preview`), never a dev server, unless the user only has dev. Read `report.md` fully. If the harness exposes Chrome DevTools MCP, a trace there (`performance_start_trace`, then `performance_analyze_insight` for `LCPBreakdown`, `LCPDiscovery`, `RenderBlocking`, `DocumentLatency`, `ThirdParties`) is a good second opinion on attribution, but it is one run: medians still come from `perf_audit.mjs`. Lighthouse CLI (`npx lighthouse <url> --preset=perf --output json`) is the fallback when neither runs.
   - **Any codebase**: `python3 scripts/static_perf_audit.py <repo>` for leads (N+1, unbounded queries, missing timeouts, connection per call, sync I/O, heavy deps/imports, unvirtualized lists, formatters in render, big assets, AI calls not streamed…). Confirm every hit in code; most matter only on hot paths.
   - **iOS / Android / React Native / Flutter**: release build on a real mid-range device where possible; use the platform tools and commands in [iOS](references/ios.md), [Android](references/android.md), [cross-platform](references/cross-platform.md). Simulator/emulator numbers are only for relative comparison.
   - **Backend/API**: time the endpoint (p50/p95 over ≥20 requests), read server timing / APM traces, slow-query log and `EXPLAIN` ([backend](references/backend.md)).
   Record the exact command, build, device, network and run count so the after-measurement can repeat it.
3. **Diagnose**: each issue = measured symptom → cause (file:line, request, query, script) → concrete fix → expected effect. Use the metric breakdowns, not intuition: LCP sub-parts (TTFB / load delay / load time / render delay), INP parts (input delay / handlers / presentation), trace self-time, query plans. Mark hypotheses as hypotheses.
4. **Prioritize** by user impact × confidence ÷ effort:
   (1) failures and blockers: timeouts, crashes/OOM, ANRs, hangs > 1 s, endpoints that fall over under normal load, data loss risk from optimizations;
   (2) the metric the user complained about, and Core Web Vitals / launch time in the "poor" range;
   (3) systemic waste: N+1, unbounded queries, missing indexes, duplicate requests, no caching/compression, heavy JS/third parties;
   (4) micro-optimizations. Skip (4) unless a profile shows it is hot.
   **High on sight**, whatever else is going on: N+1 or a query per list row on a hot endpoint; an unbounded query or list that grows with user data; outgoing calls without timeouts on a request path; a DB connection per request; blocking I/O or heavy work on the UI/main thread; the LCP image lazy-loaded or injected by JS; an unvirtualized list of hundreds of rows; a memory leak (listeners, timers, subscriptions, retained closures); a release build without minification/optimization; polling that never stops; secrets-free but identical requests fired repeatedly.
5. **Fix** the cheapest way that solves the measured problem, in this order: delete work (unused code, duplicate requests, extra renders) → do it less often (cache, debounce, memoize, paginate, batch) → do it later or elsewhere (lazy-load, defer, queue, worker/isolate/background thread, edge) → do it faster (index, better algorithm, smaller payload, better format) → add hardware. Reuse what the stack already has (framework image component, query cache, ORM eager loading) before adding libraries. Check the project's versions and confirm APIs in current docs (Context7 or official docs) before using them. Keep behavior identical: caching must respect auth and freshness, optimistic UI needs rollback, parallelizing must not break ordering or rate limits.
6. **Verify**: re-run the same measurement with the same arguments and compare medians and spread (`node scripts/perf_audit.mjs --compare before/report.json after/report.json` prints the table and the noise verdict). A fix counts only if the target metric improved beyond run-to-run noise and nothing else regressed (check the other profile, the repeat view, memory, and correctness: tests, same responses, same UI). Change one thing per measurement when you can; a combined gain is reported as combined. **Neutral is a revert**: a change inside the noise band adds complexity and bought nothing, so take it out. For backend changes, re-check p95 and error rate, not only the average. For apps, verify on release builds. Say plainly what you could not measure.
7. **Guard**: leave something behind that catches the next regression of the metric you just fixed. Web: commit `budget.json` and run `perf_audit.mjs --budget budget.json --fail-on-budget` in CI against a preview URL; add RUM (`web-vitals` `onLCP/onINP/onCLS` with attribution) to the analytics pipeline. API: a k6/autocannon threshold on p95 for the endpoint; alerts on p95 and error rate. Apps: Macrobenchmark / XCTest metrics in CI, Play vitals / Xcode Organizer watched. Keep an **attempt ledger** (a table in the PR description or `PERF.md`: idea, baseline → result, kept/reverted, why) so a reverted idea is not tried again next quarter.

## Platform routing
- **Web (any framework)**: [web](references/web.md) for Core Web Vitals causes and fixes, loading, JS cost, images/fonts, caching, rendering and framework notes (Next.js, React, Vue/Nuxt, Svelte, Vite, Laravel/Blade).
- **iOS (SwiftUI/UIKit)**: [iOS](references/ios.md). **Android (Compose/Views)**: [Android](references/android.md). **React Native / Expo / Flutter**: [cross-platform](references/cross-platform.md).
- **APIs, databases, queues, infra, AI calls**: [backend](references/backend.md).
- Perceived performance (skeletons, optimistic UI, streaming, instant feedback) is in [quick wins](references/quick-wins.md); for the visual design of loading states also use `interface-craft` if installed (its `render_audit.mjs --slow` filmstrip shows blank-while-loading).

## Reference routing (load only what the task needs)
- [Measurement](references/measurement.md): lab vs field, reading CrUX / `field_data.mjs`, conditions, runs and medians, budgets, reading `perf_audit.mjs` (including `--compare`) and `static_perf_audit.py` output, how to report numbers honestly.
- [Quick wins](references/quick-wins.md): the 30-item checklist (skeletons, image formats, duplicate calls, debounce, pagination, CDN, queues, N+1, compression, caching, deps, timeouts, AI streaming, optimistic UI, lazy-load, parallel requests, indexes, tracing, regions, SSR, third parties, code splitting, virtualization, pooling, re-renders, browser cache, load balancing, fonts, RUM, monitoring) with how to detect each, plus performance tells of AI-generated code. Use for Build mode, "optimize before launch" and broad audits.
- [Web](references/web.md), [iOS](references/ios.md), [Android](references/android.md), [Cross-platform](references/cross-platform.md), [Backend](references/backend.md): per-platform causes, tools, commands and fixes.

## Hard rules
- Measure before and after with the same conditions; report medians of several runs, never a single best run.
- Production/release builds only for conclusions (no dev server, no Debug build, no simulator numbers presented as user experience).
- Field data beats lab data for "what users feel"; lab data is for diagnosis and before/after comparison.
- Never trade correctness, security or accessibility for speed: no caching of per-user data in shared caches, no disabling TLS/validation, no removing error handling, no hiding content to "improve" LCP, no `loading=lazy` on above-the-fold images.
- Do not game metrics (deferring the real content past the measurement, fake skeletons that never resolve, splitting work only so a tool stops seeing it).
- Do not add a dependency to speed something up unless its own cost is measured and smaller than the gain.
- Do not micro-optimize code that a profile does not show as hot; do not rewrite architecture when a config, index or cache fixes the measured problem.
- For library/framework API details, use the environment's documentation workflow (e.g. Context7); do not rely on remembered syntax.

## Output
Lead with the outcome in one or two sentences (the key numbers and the biggest lever). Respond in the user's language; keep code, metric names and identifiers in English.

For substantial reviews or changes, give the conditions once (build, device/profile, network, runs), then one table sorted by priority:

| # | Priority | Layer | Location | Measured | Cause | Fix | Expected / measured effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Blocker | API | `OrderController.php:88` | `GET /orders` p95 2.8 s, 1 + 50 queries per page | Customer loaded per row (N+1) | `Order::with('customer')`, select needed columns | p95 2.8 s → 0.31 s (measured, 30 requests) |
| 2 | High | Web load | `app/page.tsx:12` | Mobile LCP 4.1 s; hero image load delay 1.9 s | Hero is a CSS background, found late | `<Image priority>` in server HTML | LCP 4.1 → 2.4 s (median of 3, mobile profile) |
| 3 | High | iOS | `FeedView.swift:40` | 31% hitches while scrolling (Instruments, iPhone 12, Release) | `DateFormatter()` built in row body | Static cached formatter | Not verified on device - expected fewer hitches |
| 4 | Medium | Web JS | `package.json` | 412 KB JS transferred; moment = 72 KB | Whole moment + locales | Replace with `Intl.DateTimeFormat` | −70 KB gz (bundle analyzer) |

Then:
- **Before → after**: the key metrics side by side with run counts; or "baseline only" for reviews.
- **Verification performed**: commands, builds, devices, runs. Mark anything not measured as "Not verified". Label every number with its source: field (CrUX/RUM), lab (`perf_audit.mjs`, Instruments…) or code lead; never present a lab median as what users experience.
- **Considered and rejected**: leads dropped, one line each with the reason (not hot, noise, already handled).
- **Attempts** (Improve mode): what was tried, baseline → result, kept or reverted, why.
- **Guard**: the budget, test or monitor left in place, or "none" with the reason.
- **Next measurements**: what to measure in the field (RUM, Xcode Organizer, Android vitals, APM) to confirm.
- **Verdict** for reviews: Block / Needs work / Ship. Do not say Ship with an open "high on sight" finding.

For a single small question ("is this query N+1?"), answer directly with the evidence and the fix.
