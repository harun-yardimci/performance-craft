# Measurement

Performance work without a baseline is guessing. Measure the user-facing symptom first, then the cause, then re-measure the symptom the same way.

## Lab vs field
| | Lab (synthetic) | Field (real users) |
| --- | --- | --- |
| What | One device/network you control: `perf_audit.mjs`, Lighthouse, DevTools, Instruments, Macrobenchmark, load tests | RUM (`web-vitals` library, Sentry, Datadog, New Relic), CrUX / PageSpeed Insights, Search Console, Xcode Organizer + MetricKit, Play Console Android vitals, APM traces |
| Good for | Diagnosis, before/after comparison, CI regression gates | "Is it slow for users?", p75/p95 by device/country/page, prioritising pages |
| Trap | Fast laptop ≠ mid-range phone; one run is noise | Needs traffic and time (CrUX is a 28-day window); changes show up slowly |

Rule: decide **what** to fix from field data when it exists, decide **how** with lab data, prove the fix with lab data, confirm in the field later.

Core Web Vitals are judged at the **75th percentile** of page loads: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 good; LCP > 4 s, INP > 500 ms, CLS > 0.25 poor. Supporting: TTFB ≤ 0.8 s, FCP ≤ 1.8 s. TBT (lab only) correlates with INP; ≤ 200 ms on the mobile profile is good.

## Conditions
- **Build**: production/release only. Dev servers ship unminified code, HMR, dev-only checks; Debug iOS/Android builds skip optimizations (Swift `-Onone`, no R8). React dev mode is several times slower.
- **Device**: a mid-range phone (Android ~4 years old, iPhone 2-3 generations old) or the `mobile` profile (4× CPU slowdown, Slow 4G). Say which.
- **Network**: name it (Slow 4G, Fast 4G, cable). Backend tests: from a machine near the server and from the user's region if latency matters.
- **State**: cold (empty cache, first launch, cold DB cache) and warm (repeat view, warm start). Logged-in vs anonymous pages differ; use `--storage-state` for logged-in pages.
- **Data**: realistic sizes. Many bugs (N+1, unvirtualized lists, unbounded queries) only appear with production-sized data; seed or point at a staging copy.
- **Noise**: close other heavy apps; keep the machine plugged in; do not compare runs from different machines, browsers or Chrome versions.

## Runs and statistics
- At least 3 runs for page loads (5+ when differences are small), 10+ iterations for app startup (Macrobenchmark default is 5-10), 20-100+ requests for an endpoint. Report the **median** for lab page loads, **p50/p95/p99** for endpoints, and the spread (min-max or IQR).
- A change is real only when it beats the run-to-run spread. `perf_audit.mjs` warns when LCP varies > 30% between runs: add `--runs 5` or reduce noise.
- Compare one change at a time when possible; if several changes land together, say the gain is combined.
- Averages hide tails: a p95 of 3 s with a 200 ms average means some users wait 3 s.

## Budgets
Set a budget before optimizing so "done" is defined and regressions are caught:
- Web (mobile, per route): LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, TBT ≤ 200 ms; JS ≤ ~170-350 KB compressed on first load; total ≤ ~1.6 MB; requests ≤ ~80.
- Apps: cold start to first useful frame ≤ ~1-2 s on mid-range (Apple recommends the first frame within ~400 ms); hitch/jank: < 5% slow frames while scrolling; no hangs > 250 ms on common actions; Android vitals bad-behavior thresholds: user-perceived ANR rate < 0.47%, crash rate < 1.09%.
- API: p95 ≤ 200-500 ms for interactive reads, ≤ 1 s for writes; error rate < 0.1%; no endpoint returning > ~1 MB JSON to mobile.

`perf_audit.mjs --budget budget.json --fail-on-budget` turns the web budget into a CI gate (exit code 1). Example `budget.json`:

```json
{ "lcp": 2500, "cls": 0.1, "tbt": 200, "inp": 200, "jsKB": 300, "totalKB": 1500, "requests": 80 }
```

## Reading `perf_audit.mjs`
`node scripts/perf_audit.mjs <url> [--profiles mobile,desktop] [--runs 3] [--repeat] [--interact "sel1,sel2"] [--scroll] [--storage-state state.json] [--budget b.json] [--trace]`

Setup once: `cd scripts && npm install` (uses installed Chrome/Edge; no browser download).

- **Metric table**: medians across cold runs with range and rating. Desktop and mobile are separate; mobile usually fails first.
- **LCP element + sub-parts**: fix the largest part first.
  - TTFB large → server/CDN/redirects ([backend](backend.md), [web](web.md) "TTFB").
  - Resource load delay large → LCP image discovered late (CSS background, JS-inserted, lazy, no `fetchpriority`).
  - Resource load time large → image too big / wrong format / slow origin → resize, AVIF/WebP, CDN.
  - Render delay large → render-blocking CSS/JS/fonts, client-side rendering, hydration, long tasks.
- **Findings**: leads with a rule id, sorted by severity; confirm each in DevTools or code.
- **Resources / third parties / top main-thread scripts**: where the bytes and the CPU go. "Top main-thread scripts" comes from Long Animation Frames attribution and is the fastest way to find who blocks the main thread.
- **Interactions** (`--interact`): click latency split into input delay (main thread busy), handlers (your code) and paint (rendering after the handler). Only click safe controls (tabs, filters, accordions, menus), never submit/delete/pay.
- **Scroll** (`--scroll`): % dropped frames and worst frame while scrolling.
- **Repeat view** (`--repeat`): bytes re-downloaded with a warm cache; > 30% means cache headers are wrong.
- **Coverage** (diagnostic run, excluded from metrics): JS/CSS that did not run during load. Not all of it is dead: some runs on interaction. Use it to find route- or interaction-only code to split.
- `--trace` saves `<profile>-trace.json`; open in Chrome DevTools → Performance → Load profile for a full flame chart.

Limits: TBT is approximated from long tasks until the network settles; INP proxy only covers scripted clicks; throttling is simulated; numbers are machine-specific. For Lighthouse parity you can also run `npx lighthouse <url> --preset=perf` (downloads a package) or PageSpeed Insights for public URLs.

## Reading `static_perf_audit.py`
`python3 scripts/static_perf_audit.py <repo> [--max 15] [--only rule,rule] [--json]`

It finds code patterns that are often slow; it cannot know whether the code is hot. For each hit ask: does this run per request, per list row, per frame, at app start, or once? Only the first four matter. Typical false positives: batch/pagination loops (`query-in-loop` on a paged `while` loop), in-memory collection lookups in PHP (`$collection->where()->first()` is O(n) per call, so it is a lead for `keyBy()` but not a DB query), small static `ScrollView { VStack { ForEach } }` lists, `->get()` on tables that are tiny by design. Record dropped leads under "Considered and rejected".

## Reporting numbers
- Always say: build, device/profile, network, cold/warm, number of runs, statistic (median/p95).
- Before → after in the same row, same conditions. "LCP 4.1 s → 2.4 s (mobile profile, median of 3)".
- Separate measured from expected. "Expected −70 KB gz" is fine when labelled.
- Never claim conversion, ranking or retention gains from a lab change; at most cite that the metric moved from "poor" to "good".
