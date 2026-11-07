#!/usr/bin/env node
/**
 * Lab performance audit for web pages: loads the page in real Chrome under throttling and
 * measures what happened. Leads, not verdicts: confirm each finding in DevTools or the code.
 *
 * Usage:
 *   node perf_audit.mjs <url | file.html> [options]
 *
 * Options:
 *   --out DIR             Output directory (default: ./perf-audit)
 *   --profiles LIST       mobile,desktop (default: both)
 *                           mobile : 412x823 @1.75x, touch, 4x CPU slowdown, "Slow 4G"
 *                                    (562 ms RTT, 1.44 Mbps down, 675 kbps up)
 *                           desktop: 1350x940 @1x, no CPU slowdown, 40 ms RTT, 10 Mbps
 *   --cpu N               Override CPU slowdown for mobile (e.g. 6 for a low-end phone)
 *   --runs N              Cold-load runs per profile; medians are reported (default: 3)
 *   --repeat              Add a repeat view per profile (same cache) to check caching
 *   --interact LIST       Comma list of CSS selectors to click after load, in order; each
 *                         click's latency is measured with the Event Timing API (INP proxy).
 *                         Pick safe controls (tabs, accordions, filters) - not submit/delete.
 *   --scroll              Scroll the page for ~3 s after load and measure frame drops (jank)
 *   --wait-for SELECTOR   Wait until this selector is visible before settling
 *   --settle MS           Max time to wait for the network to go quiet after load (default 8000)
 *   --storage-state FILE  Playwright storage state (cookies/localStorage) for logged-in pages
 *   --budget FILE         JSON budget, e.g. {"lcp":2500,"cls":0.1,"tbt":200,"inp":200,
 *                         "jsKB":350,"totalKB":1600,"requests":80}; overrides the defaults
 *   --fail-on-budget      Exit with code 1 when a median metric or budget is over (CI use)
 *   --no-coverage         Skip the extra diagnostic run that measures unused JS/CSS
 *   --trace               Save a Chrome trace of the diagnostic run (open in DevTools >
 *                         Performance > Load profile)
 *
 * Output: report.md (read this), report.json, <profile>-final.png
 *
 * What it measures:
 *   metrics    TTFB, FCP, LCP (+ element and its four sub-parts), CLS (+ shifting elements),
 *              TBT (lab approximation: long tasks from FCP until the network settles),
 *              INP proxy for --interact clicks, scroll frame drops, DOM size, JS heap
 *   loading    bytes and requests by type, render-blocking CSS/JS, uncompressed text,
 *              short cache lifetimes on static assets, HTTP/1.1, redirects, repeat-view bytes
 *   javascript total and per-file size, unused JS/CSS at load (coverage), long tasks and
 *              long animation frames with the script that caused them
 *   images     oversized for their rendered size, legacy formats for big files, missing
 *              dimensions, eager below-the-fold images, LCP image lazy or not prioritised
 *   fonts      font files and bytes, @font-face without font-display
 *   3rd party  bytes, requests and main-thread time per third-party site
 *
 * Lab numbers depend on this machine; compare runs made with the same arguments on the
 * same machine, and treat field data (CrUX / RUM) as the truth for real users.
 *
 * Setup (once): cd <this dir> && npm install
 * Uses the installed Google Chrome or Edge; no browser download. CHROME_PATH overrides.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ---------- args ----------
function parseArgs(argv) {
  const o = {
    target: null, out: 'perf-audit', profiles: ['mobile', 'desktop'], runs: 3, repeat: false,
    interact: [], scroll: false, waitFor: null, settle: 8000, storageState: null, budget: null,
    failOnBudget: false, coverage: true, trace: false, cpu: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); } return v; };
    switch (a) {
      case '--out': o.out = next(); break;
      case '--profiles': o.profiles = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--runs': o.runs = Number(next()); break;
      case '--cpu': o.cpu = Number(next()); break;
      case '--repeat': o.repeat = true; break;
      case '--interact': o.interact = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--scroll': o.scroll = true; break;
      case '--wait-for': o.waitFor = next(); break;
      case '--settle': o.settle = Number(next()); break;
      case '--storage-state': o.storageState = next(); break;
      case '--budget': o.budget = next(); break;
      case '--fail-on-budget': o.failOnBudget = true; break;
      case '--no-coverage': o.coverage = false; break;
      case '--trace': o.trace = true; break;
      case '-h': case '--help': printHelp(); process.exit(0);
      default:
        if (a.startsWith('--')) { console.error(`Unknown option ${a}`); process.exit(2); }
        rest.push(a);
    }
  }
  o.target = rest[0];
  if (!o.target) { printHelp(); process.exit(2); }
  for (const p of o.profiles) if (!PROFILES[p]) { console.error(`Unknown profile "${p}" (mobile, desktop)`); process.exit(2); }
  if (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 15) { console.error('--runs must be 1..15'); process.exit(2); }
  if (!Number.isFinite(o.settle) || o.settle < 0) { console.error('--settle must be >= 0'); process.exit(2); }
  if (o.cpu !== null && (!Number.isFinite(o.cpu) || o.cpu < 1)) { console.error('--cpu must be >= 1'); process.exit(2); }
  return o;
}

function printHelp() {
  const src = new URL(import.meta.url).pathname;
  console.log(`Usage: node ${path.basename(src)} <url | file.html> [--profiles mobile,desktop] [--runs 3] [--repeat]\n` +
    `       [--interact "sel1,sel2"] [--scroll] [--wait-for SEL] [--storage-state FILE] [--budget FILE]\n` +
    `       [--fail-on-budget] [--no-coverage] [--trace] [--cpu N] [--out DIR]\nSee the header of this file for details.`);
}

const PROFILES = {
  mobile: {
    label: 'Mobile (Slow 4G, 4x CPU)',
    viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    cpu: 4, net: { latency: 562.5, downloadThroughput: (1.44e6) / 8, uploadThroughput: (675e3) / 8 },
  },
  desktop: {
    label: 'Desktop (40 ms RTT, 10 Mbps, no CPU slowdown)',
    viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false,
    userAgent: null, cpu: 1, net: { latency: 40, downloadThroughput: (10.24e6) / 8, uploadThroughput: (10.24e6) / 8 },
  },
};

// Lab thresholds: [good, poor]. Core Web Vitals (web.dev) + Lighthouse mobile TBT.
const THRESHOLDS = {
  ttfb: [800, 1800], fcp: [1800, 3000], lcp: [2500, 4000], cls: [0.1, 0.25], tbt: [200, 600], inp: [200, 500],
};
const DEFAULT_BUDGET = { jsKB: 350, totalKB: 1600, requests: 100 };

function loadPlaywright() {
  const bases = [import.meta.url, pathToFileURL(path.join(process.cwd(), 'noop.js')).href];
  for (const b of bases) for (const n of ['playwright-core', 'playwright', '@playwright/test']) {
    try { const m = createRequire(b)(n); if (m.chromium) return m; } catch { /* try next */ }
  }
  const dir = path.dirname(new URL(import.meta.url).pathname);
  console.error(`Playwright not found. One-time setup:\n  cd "${dir}" && npm install\n(uses the installed Chrome; no browser download)`);
  process.exit(2);
}

async function launch(chromium) {
  const tries = [{ channel: 'chrome' }, { channel: 'msedge' }, {}];
  if (process.env.CHROME_PATH) tries.unshift({ executablePath: process.env.CHROME_PATH });
  let last;
  for (const t of tries) {
    try { return await chromium.launch({ headless: true, ...t }); } catch (e) { last = e; }
  }
  throw last;
}

// ---------- in-page instrumentation (runs before any page script) ----------
const INIT_SCRIPT = `(() => {
  const P = window.__perf = { lcp: null, lcpSize: 0, lcpDesc: null, lcpUrl: '', lcpNode: null, cls: 0, shifts: [],
    longTasks: [], loafs: [], events: [], frames: [] };
  const d = (el) => {
    if (!el || !el.tagName) return null;
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (c.length) s += '.' + c.join('.');
    let t = '';
    try { t = (el.getAttribute('alt') || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50); } catch {}
    if (t) s += ' "' + t + '"';
    return s;
  };
  P.describe = d;
  const obs = (type, cb, extra) => { try { new PerformanceObserver(l => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...(extra || {}) }); } catch {} };
  obs('largest-contentful-paint', e => { P.lcp = e.startTime; P.lcpSize = e.size; P.lcpNode = e.element || null; P.lcpDesc = d(e.element); P.lcpUrl = e.url || ''; });
  let cur = 0, first = 0, last = 0;
  obs('layout-shift', e => {
    // isMobile emulation marks every shift hadRecentInput; trust the flag only once we start clicking
    if (e.hadRecentInput && window.__perfInput) return;
    if (cur && e.startTime - last < 1000 && e.startTime - first < 5000) { cur += e.value; last = e.startTime; }
    else { cur = e.value; first = last = e.startTime; }
    if (cur > P.cls) P.cls = cur;
    P.shifts.push({ t: Math.round(e.startTime), value: e.value, sources: (e.sources || []).map(s => d(s.node)).filter(Boolean).slice(0, 3) });
  });
  obs('longtask', e => P.longTasks.push({ start: e.startTime, duration: e.duration }));
  obs('long-animation-frame', e => {
    if (e.duration < 50) return;
    P.loafs.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration || 0,
      scripts: (e.scripts || []).map(s => ({ url: s.sourceURL || '', fn: s.sourceFunctionName || '', invoker: s.invoker || '',
        duration: s.duration, layout: s.forcedStyleAndLayoutDuration || 0 })) });
  });
  obs('event', e => { if (e.interactionId) P.events.push({ id: e.interactionId, name: e.name, start: e.startTime, duration: e.duration,
    inputDelay: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart,
    presentation: e.startTime + e.duration - e.processingEnd, target: d(e.target) }); }, { durationThreshold: 16 });
})();`;

// Collected after the page settles.
function collectPage() {
  const P = window.__perf || {};
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, p.startTime]));
  const res = performance.getEntriesByType('resource').map(r => ({
    name: r.name, type: r.initiatorType, start: r.startTime, requestStart: r.requestStart, responseEnd: r.responseEnd,
    transfer: r.transferSize, decoded: r.decodedBodySize, blocking: r.renderBlockingStatus || '', protocol: r.nextHopProtocol,
  }));
  const vh = innerHeight;
  const imgs = [...document.images].map(img => {
    const r = img.getBoundingClientRect(); const cs = getComputedStyle(img);
    return { src: img.currentSrc || img.src, natW: img.naturalWidth, natH: img.naturalHeight, w: r.width, h: r.height,
      top: r.top + scrollY, loading: img.getAttribute('loading') || '', fetchpriority: img.getAttribute('fetchpriority') || '',
      hasDims: (img.hasAttribute('width') && img.hasAttribute('height')) || (cs.aspectRatio && cs.aspectRatio !== 'auto'),
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', srcset: !!img.srcset, desc: P.describe ? P.describe(img) : 'img' };
  });
  let lcpInfo = null;
  const n = P.lcpNode;
  if (n && n.tagName) {
    const cs = getComputedStyle(n);
    lcpInfo = { tag: n.tagName.toLowerCase(), loading: n.getAttribute('loading') || '', fetchpriority: n.getAttribute('fetchpriority') || '',
      bg: cs.backgroundImage && cs.backgroundImage !== 'none', inViewport: n.getBoundingClientRect().top < vh };
  }
  const fontsNoDisplay = new Set(); let fontFaces = 0;
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch { continue; }
    const walk = (list) => { for (const r of list) {
      if (r.type === 5) { fontFaces++; const disp = r.style.getPropertyValue('font-display'); if (!disp || disp === 'auto' || disp === 'block') fontsNoDisplay.add((r.style.getPropertyValue('font-family') || '?').replace(/["']/g, '')); }
      else if (r.cssRules) walk(r.cssRules);
    } };
    walk(rules);
  }
  const hints = [...document.querySelectorAll('link[rel~=preload],link[rel~=preconnect],link[rel~=dns-prefetch],link[rel~=modulepreload]')]
    .map(l => ({ rel: l.rel, href: l.href, as: l.getAttribute('as') || '', fp: l.getAttribute('fetchpriority') || '' }));
  let depth = 0; { const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node; let count = 0; while ((node = w.nextNode()) && count < 20000) { count++; let dd = 0, p = node; while (p && dd < 200) { p = p.parentElement; dd++; } if (dd > depth) depth = dd; } }
  return {
    url: location.href,
    nav: { ttfb: nav.responseStart || null, domContentLoaded: nav.domContentLoadedEventEnd || null, load: nav.loadEventEnd || null,
      redirectCount: nav.redirectCount || 0, redirectTime: (nav.redirectEnd || 0) - (nav.redirectStart || 0),
      dns: (nav.domainLookupEnd || 0) - (nav.domainLookupStart || 0), connect: (nav.connectEnd || 0) - (nav.connectStart || 0),
      docTransfer: nav.transferSize || 0, protocol: nav.nextHopProtocol || '' },
    fcp: paint['first-contentful-paint'] ?? null,
    lcp: P.lcp, lcpDesc: P.lcpDesc, lcpUrl: P.lcpUrl, lcpSize: P.lcpSize, lcpInfo,
    cls: P.cls || 0, shifts: (P.shifts || []).sort((a, b) => b.value - a.value).slice(0, 8),
    longTasks: P.longTasks || [], loafs: P.loafs || [], events: P.events || [],
    resources: res, images: imgs, viewportH: vh, dpr: devicePixelRatio,
    fontFaces, fontsNoDisplay: [...fontsNoDisplay], hints,
    dom: { nodes: document.getElementsByTagName('*').length, depth },
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
  };
}

// ---------- helpers ----------
const median = (a) => { const v = a.filter(x => x !== null && x !== undefined && Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const kb = (b) => (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
const ms = (v) => v === null || v === undefined ? '-' : Math.round(v) + ' ms';
const short = (u, n = 80) => { try { const x = new URL(u); const s = x.host + x.pathname; return s.length > n ? '…' + s.slice(-n) : s; } catch { return String(u).slice(0, n); } };
function site(u) {
  try { const h = new URL(u).hostname; if (/^[\d.]+$/.test(h) || !h.includes('.')) return h; const p = h.split('.');
    if (p.length > 2 && ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'gen', 'web'].includes(p[p.length - 2]) && p[p.length - 1].length === 2) return p.slice(-3).join('.');
    return p.slice(-2).join('.'); } catch { return ''; }
}
const header = (h, k) => { if (!h) return ''; for (const key of Object.keys(h)) if (key.toLowerCase() === k) return String(h[key]); return ''; };
const rate = (key, v) => { const t = THRESHOLDS[key]; if (v === null || v === undefined || !t) return '-'; return v <= t[0] ? 'good' : v <= t[1] ? 'needs improvement' : 'poor'; };
const fmtMetric = (key, v) => v === null || v === undefined ? '-' : key === 'cls' ? v.toFixed(3) : Math.round(v) + ' ms';

// ---------- one page load ----------
async function measure(browser, prof, opts, { coverage = false, tracePath = null, context: reuseCtx = null } = {}) {
  const ctx = reuseCtx || await browser.newContext({
    viewport: prof.viewport, deviceScaleFactor: prof.deviceScaleFactor, isMobile: prof.isMobile, hasTouch: prof.hasTouch,
    ...(prof.userAgent ? { userAgent: prof.userAgent } : {}), ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });
  if (!reuseCtx) await ctx.addInitScript(INIT_SCRIPT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...prof.net });
  if (prof.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });

  const reqs = new Map(); let inflight = 0; let lastActivity = Date.now();
  cdp.on('Network.requestWillBeSent', e => {
    inflight++; lastActivity = Date.now();
    const prev = reqs.get(e.requestId);
    reqs.set(e.requestId, { url: e.request.url, type: e.type || prev?.type || 'Other', initiator: e.initiator?.type || '', priority: e.request.initialPriority,
      redirects: (prev?.redirects || 0) + (e.redirectResponse ? 1 : 0), bytes: 0, decoded: 0, status: 0, headers: null, protocol: '', fromCache: false, failed: false });
  });
  cdp.on('Network.responseReceived', e => {
    const r = reqs.get(e.requestId); if (!r) return;
    r.status = e.response.status; r.headers = e.response.headers; r.mime = e.response.mimeType; r.protocol = e.response.protocol || '';
    r.fromCache = !!(e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache); r.type = e.type || r.type;
  });
  cdp.on('Network.dataReceived', e => { const r = reqs.get(e.requestId); if (r) r.decoded += e.dataLength; lastActivity = Date.now(); });
  cdp.on('Network.loadingFinished', e => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); const r = reqs.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
  cdp.on('Network.loadingFailed', e => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); const r = reqs.get(e.requestId); if (r) r.failed = true; });

  if (coverage) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); await page.coverage.startCSSCoverage({ resetOnNavigation: false }); }
  if (tracePath) await browser.startTracing(page, { path: tracePath, screenshots: true });

  const notes = [];
  const t0 = Date.now();
  let navFailed = false;
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  } catch (e) { navFailed = true; notes.push(`Navigation failed: ${e.message.split('\n')[0]}`); }
  await page.waitForLoadState('load', { timeout: 60000 }).catch(() => notes.push('load event did not fire within 60 s'));
  if (opts.waitFor) await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: 30000 }).catch(() => notes.push(`--wait-for "${opts.waitFor}" not visible within 30 s`));
  // settle: network quiet (<= 2 in flight for 1.5 s) or --settle reached
  const settleStart = Date.now();
  while (Date.now() - settleStart < opts.settle) {
    if (inflight <= 2 && Date.now() - lastActivity > 1500) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
  const wall = Date.now() - t0;

  // a failed navigation leaves about:blank or an error page: no metrics, so the run must count as failed
  let data = null;
  if (!navFailed) try { data = await page.evaluate(collectPage); } catch (e) { notes.push(`Could not read page metrics: ${e.message.split('\n')[0]}`); }

  // interactions (INP proxy)
  const interactions = [];
  if (data && opts.interact.length) {
    const startUrl = page.url();
    await page.evaluate(() => { window.__perfInput = true; }).catch(() => {});
    for (const sel of opts.interact) {
      const before = await page.evaluate(() => (window.__perf?.events || []).length).catch(() => 0);
      try {
        await page.click(sel, { timeout: 5000 });
      } catch (e) { interactions.push({ selector: sel, error: e.message.split('\n')[0] }); continue; }
      // Event Timing entries arrive after the interaction's next paint, so a slow click (1 s+) reports late:
      // wait for the first entry (up to 5 s), then a little longer for the rest of the group.
      await page.waitForFunction(b => (window.__perf?.events || []).length > b, before, { timeout: 5000, polling: 100 }).catch(() => {});
      await page.waitForTimeout(500);
      if (page.url() !== startUrl) { interactions.push({ selector: sel, error: 'click navigated away; later selectors skipped' }); break; }
      const evs = await page.evaluate((b) => (window.__perf?.events || []).slice(b), before).catch(() => []);
      if (!evs.length) { interactions.push({ selector: sel, duration: null, note: 'no event entry ≥16 ms (fast, or click did nothing)' }); continue; }
      // group entries by interaction; one click = pointerdown + pointerup + click entries
      const groups = new Map(); for (const e of evs) { if (!groups.has(e.id)) groups.set(e.id, []); groups.get(e.id).push(e); }
      let best = null;
      for (const g of groups.values()) {
        const duration = Math.max(...g.map(e => e.duration));
        const first = g.reduce((a, b) => (b.start < a.start ? b : a));
        const processing = g.reduce((s, e) => s + e.processing, 0);
        const inputDelay = first.inputDelay;
        const cand = { selector: sel, duration, inputDelay, processing, presentation: Math.max(0, duration - inputDelay - processing), event: g.map(e => e.name).join('+'), target: first.target };
        if (!best || cand.duration > best.duration) best = cand;
      }
      interactions.push(best);
    }
  }

  // scroll jank
  let scroll = null;
  if (data && opts.scroll) {
    await page.evaluate(() => { window.__perfInput = true; }).catch(() => {});
    scroll = await page.evaluate(async () => {
      const total = document.documentElement.scrollHeight - innerHeight;
      if (total < 200) return { skipped: 'page is not scrollable' };
      const frames = []; let last = performance.now(); let run = true;
      const loafStart = (window.__perf?.loafs || []).length;
      const tick = (t) => { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const start = performance.now(); const dur = 3000; const dist = Math.min(total, innerHeight * 8);
      await new Promise(res => { const step = () => { const p = Math.min(1, (performance.now() - start) / dur); scrollTo(0, dist * p); if (p < 1) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
      run = false; await new Promise(r => setTimeout(r, 100));
      const f = frames.slice(1); const budget = 1000 / 60;
      const dropped = f.filter(x => x > budget * 1.5).length;
      return { frames: f.length, dropped, droppedPct: f.length ? (dropped / f.length) * 100 : 0, worst: Math.max(0, ...f),
        longFrames: (window.__perf?.loafs || []).slice(loafStart).length };
    }).catch(e => ({ skipped: e.message.split('\n')[0] }));
  }

  let cov = null;
  if (coverage) {
    try {
      const js = await page.coverage.stopJSCoverage(); const css = await page.coverage.stopCSSCoverage();
      cov = { js: js.filter(e => e.url && /^https?:|^file:/.test(e.url)).map(e => ({ url: e.url, ...jsUsage(e) })),
        css: css.filter(e => e.url).map(e => { const total = (e.text || '').length; const used = e.ranges.reduce((s, r) => s + (r.end - r.start), 0); return { url: e.url, total, used }; }) };
    } catch (e) { notes.push(`Coverage failed: ${e.message.split('\n')[0]}`); }
  }
  if (tracePath) await browser.stopTracing().catch(() => notes.push('Trace could not be saved'));

  return { data, requests: [...reqs.values()], interactions, scroll, cov, notes, wall, page, ctx };
}

function jsUsage(entry) {
  const total = (entry.source || '').length;
  if (!total) return { total: 0, used: 0 };
  const used = new Uint8Array(total);
  const ranges = [];
  for (const f of entry.functions) for (const r of f.ranges) ranges.push(r);
  ranges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  for (const r of ranges) used.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(total, r.endOffset));
  let u = 0; for (let i = 0; i < total; i++) u += used[i];
  return { total, used: u };
}

// ---------- analysis ----------
function analyse(run, prof, opts, budget) {
  const d = run.data; const findings = [];
  const add = (severity, rule, detail, fix) => findings.push({ severity, rule, detail, fix });
  const pageSite = site(opts.url);
  const reqs = run.requests.filter(r => /^https?:|^file:/.test(r.url));

  // bytes by type
  const byType = {};
  for (const r of reqs) { const t = r.type || 'Other'; byType[t] ||= { count: 0, bytes: 0, decoded: 0 }; byType[t].count++; byType[t].bytes += r.bytes; byType[t].decoded += r.decoded; }
  const totalBytes = reqs.reduce((s, r) => s + r.bytes, 0);
  const js = reqs.filter(r => r.type === 'Script');
  const jsBytes = js.reduce((s, r) => s + r.bytes, 0);
  const jsDecoded = js.reduce((s, r) => s + r.decoded, 0);

  // third parties
  const third = {};
  for (const r of reqs) { const s = site(r.url); if (!s || s === pageSite || r.url.startsWith('file:')) continue; third[s] ||= { requests: 0, bytes: 0, mainThread: 0 }; third[s].requests++; third[s].bytes += r.bytes; }
  // main-thread time by script (LoAF attribution)
  const scriptTime = {};
  for (const f of d.loafs) for (const s of f.scripts) { if (!s.url) continue; scriptTime[s.url] ||= { duration: 0, layout: 0, count: 0, invokers: new Set() }; scriptTime[s.url].duration += s.duration; scriptTime[s.url].layout += s.layout; scriptTime[s.url].count++; if (s.invoker) scriptTime[s.url].invokers.add(s.invoker.slice(0, 60)); }
  for (const [u, v] of Object.entries(scriptTime)) { const s = site(u); if (third[s]) third[s].mainThread += v.duration; }

  // TBT (lab approx)
  const fcp = d.fcp ?? 0;
  const tbt = d.longTasks.filter(t => t.start + t.duration > fcp).reduce((s, t) => s + Math.max(0, t.duration - 50 - Math.max(0, fcp - t.start)), 0);

  // LCP sub-parts
  let lcpParts = null;
  if (d.lcp !== null) {
    const ttfb = d.nav.ttfb ?? 0;
    const r = d.lcpUrl ? d.resources.find(x => x.name === d.lcpUrl) : null;
    if (r) {
      const start = r.requestStart || r.start;
      const loadDelay = Math.max(0, start - ttfb); const loadTime = Math.max(0, r.responseEnd - start);
      lcpParts = { ttfb, loadDelay, loadTime, renderDelay: Math.max(0, d.lcp - Math.max(ttfb, r.responseEnd)) };
    } else lcpParts = { ttfb, loadDelay: 0, loadTime: 0, renderDelay: Math.max(0, d.lcp - ttfb) };
  }

  // metric findings
  const metric = { ttfb: d.nav.ttfb, fcp: d.fcp, lcp: d.lcp, cls: d.cls, tbt };
  const inpVals = run.interactions.filter(i => i.duration).map(i => i.duration);
  if (inpVals.length) metric.inp = Math.max(...inpVals);

  // LCP-specific leads
  const li = d.lcpInfo;
  if (li && d.lcpUrl) {
    if (li.loading === 'lazy') add('high', 'lcp-lazy', `LCP image ${d.lcpDesc} has loading="lazy", so the browser waits for layout before fetching it.`, 'Remove loading="lazy" from the LCP image (and above-the-fold images in general).');
    if (li.tag === 'img' && li.fetchpriority !== 'high' && lcpParts && lcpParts.loadDelay > 300) add('medium', 'lcp-priority', `LCP image starts loading ${ms(lcpParts.loadDelay)} after TTFB without fetchpriority="high".`, 'Add fetchpriority="high" to the LCP <img> (Next.js: priority / preload on next/image).');
    const lr = reqs.find(r => r.url === d.lcpUrl);
    if ((li.bg || (lr && lr.initiator === 'script')) && lcpParts && lcpParts.loadDelay > 300) add('medium', 'lcp-late-discovery', `LCP image is ${li.bg ? 'a CSS background' : 'inserted by JavaScript'}, so the preload scanner cannot find it in the HTML (load delay ${ms(lcpParts.loadDelay)}).`, 'Put the LCP image in the server HTML as <img> (or add <link rel="preload" as="image" fetchpriority="high">).');
  }
  if (lcpParts && d.lcp > THRESHOLDS.lcp[0] && lcpParts.renderDelay > d.lcp * 0.4) add('medium', 'lcp-render-delay', `${d.lcpUrl ? `LCP image finished downloading ${ms(lcpParts.renderDelay)} before it was painted` : `LCP text was painted ${ms(lcpParts.renderDelay)} after the first byte`} (render delay = ${Math.round(lcpParts.renderDelay / d.lcp * 100)}% of LCP): render-blocking CSS/JS/fonts, client-side rendering or hydration hold it back.`, 'Server-render the LCP element, cut render-blocking resources, and defer non-critical JS.');
  if (lcpParts && d.lcp > THRESHOLDS.lcp[0] && lcpParts.ttfb > d.lcp * 0.4) add('medium', 'lcp-ttfb', `TTFB is ${Math.round(lcpParts.ttfb / d.lcp * 100)}% of LCP: the server/edge is the bottleneck.`, 'Cache HTML at the edge/CDN, remove redirects, speed up server rendering and data fetching (see network-and-backend reference).');

  // render-blocking
  const blocking = d.resources.filter(r => r.blocking === 'blocking');
  if (blocking.length) {
    const sizeOf = (u) => reqs.find(r => r.url === u)?.bytes || 0;
    const list = blocking.map(b => `${short(b.name, 60)} (${kb(sizeOf(b.name))}, done at ${ms(b.responseEnd)})`).slice(0, 6).join('; ');
    const late = blocking.some(b => b.responseEnd > (d.fcp ?? 0) * 0.5);
    add(late && blocking.length > 2 ? 'medium' : 'low', 'render-blocking', `${blocking.length} render-blocking resource(s): ${list}.`, 'Inline critical CSS, load the rest async; add defer/async/type="module" to head scripts; drop unused stylesheets.');
  }

  // JS weight
  const jsBudget = (budget.jsKB ?? DEFAULT_BUDGET.jsKB) * 1024;
  if (jsBytes > jsBudget) add(jsBytes > jsBudget * 2 ? 'high' : 'medium', 'js-heavy', `${kb(jsBytes)} of JavaScript transferred (${kb(jsDecoded)} to parse and compile) in ${js.length} files; budget ${kb(jsBudget)}.`, 'Code-split by route, lazy-load below-the-fold widgets, replace heavy dependencies, remove polyfills for modern browsers.');
  for (const r of js.filter(r => r.bytes > 150 * 1024).sort((a, b) => b.bytes - a.bytes).slice(0, 5)) add('low', 'js-file-big', `${short(r.url)}: ${kb(r.bytes)} transferred (${kb(r.decoded)} decoded).`, 'Inspect with a bundle analyzer (source-map-explorer, @next/bundle-analyzer, rollup-plugin-visualizer) and split or trim it.');

  // compression & cache
  const textTypes = new Set(['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch']);
  const uncompressed = reqs.filter(r => r.url.startsWith('http') && !r.fromCache && r.status === 200 && r.bytes > 1500 && (textTypes.has(r.type) || /json|javascript|css|svg|xml|text\//.test(r.mime || '')) && !header(r.headers, 'content-encoding'));
  if (uncompressed.length) add(uncompressed.reduce((s, r) => s + r.bytes, 0) > 100 * 1024 ? 'medium' : 'low', 'uncompressed', `${uncompressed.length} text response(s) without gzip/brotli/zstd: ${uncompressed.slice(0, 5).map(r => `${short(r.url, 50)} (${kb(r.bytes)})`).join('; ')}.`, 'Enable brotli (or gzip) for text responses on the server/CDN.');
  const staticTypes = new Set(['Script', 'Stylesheet', 'Font', 'Image']);
  const shortCache = reqs.filter(r => r.url.startsWith('http') && staticTypes.has(r.type) && site(r.url) === pageSite && r.status === 200).filter(r => {
    const cc = header(r.headers, 'cache-control'); const m = /max-age=(\d+)/.exec(cc); const age = m ? Number(m[1]) : null;
    const hashed = /[.\-_][a-f0-9]{8,}[.\-_]|[.\-_][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(new URL(r.url).pathname) && /\d/.test(r.url);
    if (/no-store/.test(cc)) return true;
    if (age === null && !header(r.headers, 'expires')) return true;
    return hashed ? (age !== null && age < 30 * 86400) : (age !== null && age < 3600);
  });
  if (shortCache.length) add('low', 'cache-short', `${shortCache.length} same-site static asset(s) with no or short cache lifetime, e.g. ${shortCache.slice(0, 4).map(r => `${short(r.url, 50)} (${header(r.headers, 'cache-control') || 'no cache-control'})`).join('; ')}.`, 'Fingerprinted assets: Cache-Control: public, max-age=31536000, immutable. Others: a sensible max-age plus ETag.');
  const h1 = reqs.filter(r => site(r.url) === pageSite && /http\/1/.test(r.protocol));
  if (h1.length > 10) add('low', 'http1', `${h1.length} same-site requests over HTTP/1.1.`, 'Serve over HTTP/2 or HTTP/3 (most CDNs do by default).');
  if (d.nav.redirectCount) add(d.nav.redirectTime > 300 ? 'medium' : 'low', 'redirects', `${d.nav.redirectCount} redirect(s) before the document (${ms(d.nav.redirectTime)}).`, 'Link to the final URL; avoid http→https→www chains.');
  const reqBudget = budget.requests ?? DEFAULT_BUDGET.requests;
  if (reqs.length > reqBudget) add('low', 'requests-many', `${reqs.length} requests (budget ${reqBudget}).`, 'Bundle tiny files, remove unused third parties, lazy-load below-the-fold content.');
  const totalBudget = (budget.totalKB ?? DEFAULT_BUDGET.totalKB) * 1024;
  if (totalBytes > totalBudget) add(totalBytes > totalBudget * 2 ? 'high' : 'medium', 'page-heavy', `${kb(totalBytes)} transferred in total (budget ${kb(totalBudget)}).`, 'Start with the biggest types in the resource table (usually images and JS).');

  // images
  const imgBytes = (src) => reqs.find(r => r.url === src)?.bytes || 0;
  const visibleImgs = d.images.filter(i => i.visible && i.natW > 0 && i.src && !i.src.startsWith('data:'));
  const oversized = visibleImgs.filter(i => i.w > 0 && i.natW > i.w * d.dpr * 1.5 && imgBytes(i.src) > 30 * 1024);
  if (oversized.length) add(oversized.reduce((s, i) => s + imgBytes(i.src), 0) > 300 * 1024 ? 'medium' : 'low', 'image-oversized', `${oversized.length} image(s) much larger than displayed: ${oversized.slice(0, 5).map(i => `${short(i.src, 40)} ${i.natW}px for ${Math.round(i.w)}px@${d.dpr}x (${kb(imgBytes(i.src))})`).join('; ')}.`, 'Serve responsive sizes (srcset + sizes, or the framework image component) close to rendered width × DPR.');
  const legacy = reqs.filter(r => r.type === 'Image' && r.bytes > 100 * 1024 && /jpeg|png|gif|bmp/.test(r.mime || ''));
  if (legacy.length) add('low', 'image-format', `${legacy.length} large JPEG/PNG/GIF image(s): ${legacy.slice(0, 4).map(r => `${short(r.url, 40)} (${kb(r.bytes)})`).join('; ')}.`, 'Use AVIF or WebP (and MP4/WebM instead of animated GIF).');
  const noDims = visibleImgs.filter(i => !i.hasDims && i.top < d.viewportH * 2);
  if (noDims.length && d.cls > 0.05) add('medium', 'image-no-dimensions', `${noDims.length} image(s) near the top without width/height or aspect-ratio while CLS is ${d.cls.toFixed(3)}: ${noDims.slice(0, 4).map(i => i.desc).join('; ')}.`, 'Give every <img> width and height attributes (or CSS aspect-ratio).');
  const eagerBelow = visibleImgs.filter(i => i.top > d.viewportH * 1.5 && i.loading !== 'lazy' && imgBytes(i.src) > 0);
  if (eagerBelow.length > 2) add('low', 'image-offscreen-eager', `${eagerBelow.length} image(s) far below the fold load eagerly (${kb(eagerBelow.reduce((s, i) => s + imgBytes(i.src), 0))}).`, 'Add loading="lazy" (and decoding="async") to below-the-fold images.');

  // fonts
  const fonts = reqs.filter(r => r.type === 'Font');
  if (fonts.length > 4 || fonts.reduce((s, r) => s + r.bytes, 0) > 200 * 1024) add('low', 'fonts-heavy', `${fonts.length} font files, ${kb(fonts.reduce((s, r) => s + r.bytes, 0))}.`, 'Use WOFF2, subset (latin + latin-ext for Turkish), fewer weights or one variable font.');
  if (d.fontsNoDisplay.length) add('low', 'font-display', `@font-face without font-display (or block): ${d.fontsNoDisplay.slice(0, 5).join(', ')}. Text stays invisible until the font loads.`, 'font-display: swap (or optional for body text), and preload the one or two critical fonts.');

  // third parties
  const thirdList = Object.entries(third).sort((a, b) => (b[1].mainThread + b[1].bytes / 1024) - (a[1].mainThread + a[1].bytes / 1024));
  const thirdMain = thirdList.reduce((s, [, v]) => s + v.mainThread, 0);
  const thirdBytes = thirdList.reduce((s, [, v]) => s + v.bytes, 0);
  if (thirdMain > 250 || thirdBytes > totalBytes * 0.3) add(thirdMain > 1000 ? 'high' : 'medium', 'third-party', `Third parties: ${kb(thirdBytes)} (${Math.round(thirdBytes / Math.max(1, totalBytes) * 100)}% of bytes), ~${ms(thirdMain)} main-thread script time. Top: ${thirdList.slice(0, 4).map(([s, v]) => `${s} ${kb(v.bytes)}/${ms(v.mainThread)}`).join(', ')}.`, 'Remove unused tags, load the rest after interaction or idle (facades for chat/video/maps), self-host critical ones.');

  // long tasks
  const lt = [...d.longTasks].sort((a, b) => b.duration - a.duration);
  if (lt.length && lt[0].duration > 200) add(lt[0].duration > 500 ? 'high' : 'medium', 'long-tasks', `${lt.length} long task(s); longest ${ms(lt[0].duration)} at ${ms(lt[0].start)}. Main thread blocked for ${ms(tbt)} after FCP.`, 'See "Top main-thread scripts": split work (yield with scheduler.yield / setTimeout), defer non-critical JS, move heavy work to a Web Worker.');

  // CLS
  if (d.cls > THRESHOLDS.cls[0] && d.shifts.length) add(d.cls > THRESHOLDS.cls[1] ? 'high' : 'medium', 'cls-sources', `Biggest shifts: ${d.shifts.slice(0, 4).map(s => `${s.value.toFixed(3)} at ${s.t} ms by ${s.sources.join(', ') || '?'}`).join('; ')}.`, 'Reserve space (dimensions, min-height for ads/embeds/banners), avoid inserting content above existing content, use font metric overrides (size-adjust).');

  // DOM
  if (d.dom.nodes > 1500) add(d.dom.nodes > 3000 ? 'medium' : 'low', 'dom-large', `${d.dom.nodes} DOM elements (depth ${d.dom.depth}).`, 'Virtualize long lists, render hidden tabs/menus lazily, flatten wrapper divs; content-visibility: auto for long below-the-fold sections.');

  // interactions
  for (const i of run.interactions) if (i.duration > THRESHOLDS.inp[0]) {
    const part = i.inputDelay > i.processing && i.inputDelay > i.presentation ? 'input delay (main thread busy)' : i.processing > i.presentation ? 'event handlers' : 'rendering after the handler';
    add(i.duration > THRESHOLDS.inp[1] ? 'high' : 'medium', 'slow-interaction', `Click on ${i.selector} took ${ms(i.duration)} until the next paint; mostly ${part} (delay ${ms(i.inputDelay)}, handlers ${ms(i.processing)}, paint ${ms(i.presentation)}).`, 'Show visual feedback first and defer the rest (await scheduler.yield / requestAnimationFrame+setTimeout), avoid large re-renders and forced layout in the handler.');
  }
  if (run.scroll && !run.scroll.skipped && run.scroll.droppedPct > 10) add(run.scroll.droppedPct > 25 ? 'high' : 'medium', 'scroll-jank', `${run.scroll.droppedPct.toFixed(0)}% of frames dropped while scrolling (worst ${ms(run.scroll.worst)}, ${run.scroll.longFrames} long animation frames).`, 'Look for scroll listeners without passive, layout reads in scroll handlers, huge paint areas (box-shadow/blur/fixed backgrounds), unvirtualized lists.');

  return { metric, lcpParts, byType, totalBytes, jsBytes, requests: reqs.length, third: thirdList, scriptTime, findings, tbt };
}

function coverageFindings(cov, reqs) {
  const out = [];
  if (!cov) return out;
  const sizeOf = (u) => reqs.find(r => r.url === u)?.bytes || 0;
  const jsUn = cov.js.filter(e => e.total > 20000).map(e => ({ ...e, unused: e.total - e.used })).filter(e => e.unused > 20000 && e.unused / e.total > 0.5).sort((a, b) => b.unused - a.unused);
  const jsUnusedTotal = cov.js.reduce((s, e) => s + (e.total - e.used), 0);
  if (jsUn.length) out.push({ severity: jsUnusedTotal > 300000 ? 'medium' : 'low', rule: 'unused-js', detail: `~${kb(jsUnusedTotal)} of JS (uncompressed) never ran during load. Biggest: ${jsUn.slice(0, 5).map(e => `${short(e.url, 50)} ${Math.round(e.unused / e.total * 100)}% unused of ${kb(e.total)} (${kb(sizeOf(e.url))} transferred)`).join('; ')}.`, fix: 'Not all of it is dead code (some runs on interaction). Split route- and interaction-only code with dynamic import(); check for whole-library imports.' });
  const cssUn = cov.css.filter(e => e.total > 10000 && (e.total - e.used) / e.total > 0.6).sort((a, b) => (b.total - b.used) - (a.total - a.used));
  if (cssUn.length) out.push({ severity: 'low', rule: 'unused-css', detail: `Mostly unused CSS at load: ${cssUn.slice(0, 4).map(e => `${short(e.url || 'inline', 50)} ${Math.round((e.total - e.used) / e.total * 100)}% of ${kb(e.total)}`).join('; ')}.`, fix: 'Purge unused selectors (Tailwind content config, PurgeCSS), split route CSS, inline only critical CSS.' });
  return out;
}

// ---------- report ----------
const SEV = { high: 0, medium: 1, low: 2 };
function renderProfile(name, prof, runs, a, diag, repeat, opts, budget) {
  const L = [];
  L.push(`## ${prof.label}`);
  L.push('');
  const keys = ['ttfb', 'fcp', 'lcp', 'cls', 'tbt'];
  if (runs.some(r => r.a.metric.inp !== undefined)) keys.push('inp');
  const names = { ttfb: 'TTFB', fcp: 'FCP', lcp: 'LCP', cls: 'CLS', tbt: 'TBT (lab)', inp: 'INP proxy (clicks)' };
  L.push(`| Metric | Median of ${runs.length} | Range | Good / poor | Rating |`, '| --- | --- | --- | --- | --- |');
  const med = {};
  for (const k of keys) {
    const vals = runs.map(r => r.a.metric[k]).filter(v => v !== null && v !== undefined);
    med[k] = median(vals);
    const lim = budget[k] ?? THRESHOLDS[k][0];
    const range = vals.length > 1 ? `${fmtMetric(k, Math.min(...vals))} – ${fmtMetric(k, Math.max(...vals))}` : '-';
    L.push(`| ${names[k]} | **${fmtMetric(k, med[k])}** | ${range} | ${fmtMetric(k, lim)} / ${fmtMetric(k, THRESHOLDS[k][1])} | ${rate(k, med[k])} |`);
  }
  const spread = runs.length > 2 ? (() => { const v = runs.map(r => r.a.metric.lcp).filter(Number.isFinite); const m = median(v); return m ? (Math.max(...v) - Math.min(...v)) / m : 0; })() : 0;
  L.push('');
  if (spread > 0.3) L.push(`> LCP varies ${Math.round(spread * 100)}% between runs: treat single differences under that as noise; use more --runs before comparing.`, '');

  const d = a.run.data;
  if (d.lcp !== null) {
    const p = a.lcpParts;
    L.push(`**LCP element:** ${d.lcpDesc || '?'}${d.lcpUrl ? ` (${short(d.lcpUrl, 70)})` : ' (text)'}  `);
    if (p) L.push(`Sub-parts (median run): TTFB ${ms(p.ttfb)} · resource load delay ${ms(p.loadDelay)} · resource load time ${ms(p.loadTime)} · render delay ${ms(p.renderDelay)}. Fix the largest one first.`);
    L.push('');
  }

  const all = [...a.findings, ...(diag || [])];
  const merged = []; const seen = new Set();
  for (const f of all.sort((x, y) => SEV[x.severity] - SEV[y.severity])) { if (seen.has(f.rule)) continue; seen.add(f.rule); merged.push(f); }
  L.push('### Findings (leads - confirm in DevTools or code)');
  L.push('');
  if (!merged.length) L.push('No findings above thresholds.');
  else { L.push('| # | Severity | Rule | What was measured | Suggested fix |', '| --- | --- | --- | --- | --- |'); merged.forEach((f, i) => L.push(`| ${i + 1} | ${f.severity} | \`${f.rule}\` | ${f.detail.replace(/\|/g, '\\|')} | ${f.fix.replace(/\|/g, '\\|')} |`)); }
  L.push('');

  L.push('### Resources (median run)', '', '| Type | Requests | Transferred | Decoded |', '| --- | --- | --- | --- |');
  for (const [t, v] of Object.entries(a.byType).sort((x, y) => y[1].bytes - x[1].bytes)) L.push(`| ${t} | ${v.count} | ${kb(v.bytes)} | ${kb(v.decoded)} |`);
  L.push(`| **Total** | **${a.requests}** | **${kb(a.totalBytes)}** | |`, '');
  if (repeat) L.push(`Repeat view (warm cache): ${kb(repeat.bytes)} transferred in ${repeat.requests} requests (${Math.round(repeat.bytes / Math.max(1, a.totalBytes) * 100)}% of cold), LCP ${ms(repeat.lcp)}.${repeat.bytes > a.totalBytes * 0.3 ? ' **More than 30% re-downloaded: check Cache-Control.**' : ''}`, '');

  if (a.third.length) { L.push('### Third parties', '', '| Site | Requests | Transferred | Main-thread script time |', '| --- | --- | --- | --- |'); for (const [s, v] of a.third.slice(0, 10)) L.push(`| ${s} | ${v.requests} | ${kb(v.bytes)} | ${ms(v.mainThread)} |`); L.push(''); }

  const st = Object.entries(a.scriptTime).sort((x, y) => y[1].duration - x[1].duration).slice(0, 8);
  if (st.length) { L.push('### Top main-thread scripts (long animation frames)', '', '| Script | Time | Forced layout | Invoked by |', '| --- | --- | --- | --- |'); for (const [u, v] of st) L.push(`| ${short(u, 70)} | ${ms(v.duration)} | ${ms(v.layout)} | ${[...v.invokers].slice(0, 2).join(', ').replace(/\|/g, '/') || '-'} |`); L.push(''); }
  else if (d.longTasks.length) L.push(`Long tasks: ${d.longTasks.length} (no script attribution: this Chrome lacks long-animation-frame).`, '');

  if (a.run.interactions.length) { L.push('### Interactions', '', '| Selector | Latency | Input delay | Handlers | Paint | Note |', '| --- | --- | --- | --- | --- | --- |'); for (const i of a.run.interactions) L.push(`| \`${i.selector}\` | ${ms(i.duration)} | ${ms(i.inputDelay)} | ${ms(i.processing)} | ${ms(i.presentation)} | ${(i.error || i.note || i.target || '').replace(/\|/g, '/')} |`); L.push(''); }
  if (a.run.scroll) L.push(a.run.scroll.skipped ? `Scroll test skipped: ${a.run.scroll.skipped}.` : `Scroll test: ${a.run.scroll.frames} frames, ${a.run.scroll.droppedPct.toFixed(1)}% dropped, worst frame ${ms(a.run.scroll.worst)}.`, '');
  L.push(`DOM: ${d.dom.nodes} elements, depth ${d.dom.depth}${d.heap ? ` · JS heap after load: ${(d.heap / 1048576).toFixed(1)} MB` : ''} · document ${d.nav.protocol || '?'}, ${kb(d.nav.docTransfer)}.`, '');
  const notes = [...new Set(runs.flatMap(r => r.notes))];
  if (notes.length) L.push('Notes: ' + notes.join(' · '), '');
  return { md: L.join('\n'), med, findings: merged };
}

// ---------- main ----------
// Dev servers have no TLS: a bare "localhost:3000" / "127.0.0.1:8080" / "app.test" target gets http://, everything else https://.
function localHost(target) {
  const host = target.split(/[/?#]/)[0].replace(/:\d+$/, '').toLowerCase();
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$|\.(localhost|test)$/.test(host);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.url = /^[a-z]+:\/\//i.test(opts.target) ? opts.target : existsSync(opts.target) ? pathToFileURL(path.resolve(opts.target)).href : `${localHost(opts.target) ? 'http' : 'https'}://${opts.target}`;
  const budget = opts.budget ? JSON.parse(await readFile(opts.budget, 'utf8')) : {};
  await mkdir(opts.out, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await launch(chromium);
  const version = browser.version();
  const out = { url: opts.url, date: new Date().toISOString(), chrome: version, profiles: {} };
  const md = [`# Performance audit: ${opts.url}`, '', `${out.date.slice(0, 16).replace('T', ' ')} UTC · Chrome ${version} · ${opts.runs} cold run(s) per profile · lab data from this machine (not field data).`, ''];
  let overBudget = false; let failedProfiles = 0;

  for (const name of opts.profiles) {
    const prof = { ...PROFILES[name] }; if (name === 'mobile' && opts.cpu) { prof.cpu = opts.cpu; prof.label = `Mobile (Slow 4G, ${opts.cpu}x CPU)`; }
    const runs = []; let lastNotes = [];
    for (let i = 0; i < opts.runs; i++) {
      process.stderr.write(`${name}: run ${i + 1}/${opts.runs}…\n`);
      const run = await measure(browser, prof, opts);
      lastNotes = run.notes;
      if (run.data) runs.push({ run, a: analyse(run, prof, opts, budget), notes: run.notes });
      else console.error(`  run failed: ${run.notes.join('; ')}`);
      if (i === opts.runs - 1 && run.data) await run.page.screenshot({ path: path.join(opts.out, `${name}-final.png`) }).catch(() => {});
      let repeatData = null;
      if (opts.repeat && i === 0 && run.data) {
        process.stderr.write(`${name}: repeat view…\n`);
        const rep = await measure(browser, prof, { ...opts, interact: [], scroll: false }, { context: run.ctx });
        if (rep.data) repeatData = { bytes: rep.requests.reduce((s, r) => s + r.bytes, 0), requests: rep.requests.length, lcp: rep.data.lcp };
        runs[runs.length - 1].repeat = repeatData;
      }
      await run.ctx.close();
    }
    if (!runs.length) { failedProfiles++; md.push(`## ${prof.label}`, '', `All ${opts.runs} run(s) failed; nothing measured. Last notes: ${lastNotes.join(' · ') || '-'}`, ''); continue; }
    // median run by LCP for detail tables
    const sorted = [...runs].sort((x, y) => (x.a.metric.lcp ?? 0) - (y.a.metric.lcp ?? 0));
    const medRun = sorted[Math.floor((sorted.length - 1) / 2)];
    const a = { ...medRun.a, run: medRun.run };
    let diag = null;
    if (opts.coverage || opts.trace) {
      process.stderr.write(`${name}: diagnostic run (coverage${opts.trace ? ' + trace' : ''})…\n`);
      const dr = await measure(browser, prof, { ...opts, interact: [], scroll: false }, { coverage: opts.coverage, tracePath: opts.trace ? path.join(opts.out, `${name}-trace.json`) : null });
      diag = coverageFindings(dr.cov, dr.requests);
      await dr.ctx.close();
    }
    const repeat = runs.find(r => r.repeat)?.repeat || null;
    const r = renderProfile(name, prof, runs, a, diag, repeat, opts, budget);
    md.push(r.md);
    for (const k of Object.keys(r.med)) if (r.med[k] !== null && r.med[k] > (budget[k] ?? THRESHOLDS[k][1])) overBudget = true;
    // size budgets fail the run only when the user set that budget explicitly
    const budgetRules = { 'js-heavy': 'jsKB', 'page-heavy': 'totalKB', 'requests-many': 'requests' };
    if (r.findings.some(f => budgetRules[f.rule] && budget[budgetRules[f.rule]] !== undefined)) overBudget = true;
    out.profiles[name] = { label: prof.label, medians: r.med, lcpParts: a.lcpParts, findings: r.findings, byType: a.byType, totalBytes: a.totalBytes,
      requests: a.requests, thirdParties: a.third.map(([s, v]) => ({ site: s, ...v })), interactions: a.run.interactions, scroll: a.run.scroll, repeat,
      runs: runs.map(x => x.a.metric) };
  }
  await browser.close();
  md.push('---', '', 'Lab caveats: throttling is simulated on this machine; TBT is approximated from long tasks until the network settled; the INP proxy only covers the clicks you scripted. Compare runs made with the same arguments; confirm with field data (CrUX, RUM, Search Console) before claiming user impact.');
  await writeFile(path.join(opts.out, 'report.md'), md.join('\n'));
  await writeFile(path.join(opts.out, 'report.json'), JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.join(opts.out, 'report.md')}`);
  for (const [n, p] of Object.entries(out.profiles)) console.log(`  ${n}: ` + Object.entries(p.medians).map(([k, v]) => `${k.toUpperCase()} ${fmtMetric(k, v)}`).join(' · ') + ` · ${p.findings.length} finding(s)`);
  if (failedProfiles) { console.error(`${failedProfiles} profile(s) could not be measured (see report notes).`); process.exit(1); }
  if (opts.failOnBudget && overBudget) process.exit(1);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
