# Credits

Performance Craft is © 2026 Harun Yardimci. It follows the structure of the author's Interface Craft skill. No third-party files were copied.

- Metric thresholds and the LCP/INP sub-part breakdowns follow the public guidance on web.dev (Core Web Vitals) and Chrome DevTools throttling presets.
- Android vitals thresholds follow the Play Console documentation; iOS hang/launch guidance follows Apple's developer documentation.
- The 30-item checklist in `references/quick-wins.md` was prompted by a short-form video by BreakingBreach (Instagram, November 2026); its items are paraphrased topic names, expanded with original detection and fix guidance.
- Several web rules (the INP work-placement heuristic, `fetchpriority` and resource-hint roles, speculation rules, service worker strategies, bfcache and beacon guidance, support targets by Baseline status) were prompted by Google Chrome's [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance); they are paraphrased and rewritten, not copied.
- `scripts/perf_audit.mjs` uses `playwright-core` (Apache-2.0) to drive the locally installed Chrome.
