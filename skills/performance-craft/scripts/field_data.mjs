#!/usr/bin/env node
/**
 * Field data (real users) for a public URL: Core Web Vitals at the 75th percentile from the
 * Chrome UX Report, per form factor, with URL-level data first and origin-level as a labelled fallback.
 *
 * Usage:
 *   node field_data.mjs <url> [--form-factors phone,desktop] [--json] [--out DIR] [--history]
 *
 * Sources (first that works):
 *   1. CrUX API         needs CRUX_API_KEY (or GOOGLE_API_KEY): free, 150 queries/min, URL + origin,
 *                       phone/desktop/tablet, 28-day window. --history adds 25 weekly points per metric.
 *   2. PageSpeed Insights API   no key for occasional use (quota is low; set PSI_API_KEY for more). Returns the
 *                       CrUX record Google still exposes there plus one Lighthouse lab run as context.
 *
 * Output: a table per form factor (p75, % good, rating, scope) and the decision it supports.
 *
 * Rules the agent must follow when reading this (also in references/measurement.md):
 *   - Field data says WHAT users suffer from; lab data (perf_audit.mjs) says WHY and proves a fix.
 *   - URL scope beats origin scope. Origin data is context for the whole site, not proof for one page.
 *   - Phone and desktop are separate verdicts. Never average them.
 *   - "No data" means not enough eligible traffic (localhost, staging, new or low-traffic pages). It is
 *     not a pass. Say "unavailable" and rely on lab data.
 *   - CrUX is a rolling 28-day window: a fix deployed today will not show for weeks. Verify with lab now.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const METRICS = {
  largest_contentful_paint: { label: 'LCP', good: 2500, poor: 4000, unit: 'ms' },
  interaction_to_next_paint: { label: 'INP', good: 200, poor: 500, unit: 'ms' },
  cumulative_layout_shift: { label: 'CLS', good: 0.1, poor: 0.25, unit: '' },
  first_contentful_paint: { label: 'FCP', good: 1800, poor: 3000, unit: 'ms' },
  experimental_time_to_first_byte: { label: 'TTFB', good: 800, poor: 1800, unit: 'ms' },
};
const CORE = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'];
// PageSpeed Insights uses upper-case keys for the same metrics.
const PSI_KEYS = { LARGEST_CONTENTFUL_PAINT_MS: 'largest_contentful_paint', INTERACTION_TO_NEXT_PAINT: 'interaction_to_next_paint',
  CUMULATIVE_LAYOUT_SHIFT_SCORE: 'cumulative_layout_shift', FIRST_CONTENTFUL_PAINT_MS: 'first_contentful_paint', EXPERIMENTAL_TIME_TO_FIRST_BYTE: 'experimental_time_to_first_byte' };

function parseArgs(argv) {
  const o = { url: null, formFactors: ['PHONE', 'DESKTOP'], json: false, out: null, history: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); } return v; };
    switch (a) {
      case '--form-factors': o.formFactors = next().split(',').map(s => s.trim().toUpperCase()).filter(Boolean); break;
      case '--json': o.json = true; break;
      case '--out': o.out = next(); break;
      case '--history': o.history = true; break;
      case '-h': case '--help': help(); process.exit(0);
      default: if (a.startsWith('--')) { console.error(`Unknown option ${a}`); process.exit(2); } o.url = a;
    }
  }
  if (!o.url) { help(); process.exit(2); }
  if (!/^https?:\/\//i.test(o.url)) o.url = `https://${o.url}`;
  for (const f of o.formFactors) if (!['PHONE', 'DESKTOP', 'TABLET'].includes(f)) { console.error(`Unknown form factor ${f} (phone, desktop, tablet)`); process.exit(2); }
  return o;
}
function help() {
  console.log('Usage: node field_data.mjs <url> [--form-factors phone,desktop] [--json] [--out DIR] [--history]\nCRUX_API_KEY (preferred) or PSI_API_KEY in the environment. See the header of this file.');
}

const fmt = (key, v) => v === null || v === undefined ? '-' : METRICS[key].unit === 'ms' ? `${Math.round(v)} ms` : Number(v).toFixed(3);
const rate = (key, v) => v === null || v === undefined ? '-' : v <= METRICS[key].good ? 'good' : v <= METRICS[key].poor ? 'needs improvement' : 'poor';
const pct = (d) => d === null || d === undefined ? '-' : `${Math.round(d * 100)}%`;

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

// ---------- CrUX API ----------
async function crux(url, formFactor, key, history) {
  const endpoint = history ? 'queryHistoryRecord' : 'queryRecord';
  const api = `https://chromeuxreport.googleapis.com/v1/records:${endpoint}?key=${encodeURIComponent(key)}`;
  const ask = async (scope) => getJson(api, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [scope]: scope === 'url' ? url : new URL(url).origin, formFactor, metrics: Object.keys(METRICS) }) });
  for (const scope of ['url', 'origin']) {
    const { status, body } = await ask(scope);
    if (status === 200 && body.record) return { scope, record: body.record, source: 'CrUX API' };
    if (status === 404) continue; // no data at this scope
    if (status === 400 && /not.*found|no.*data/i.test(JSON.stringify(body))) continue;
    throw new Error(`CrUX API ${status}: ${body.error?.message || body.raw || JSON.stringify(body).slice(0, 200)}`);
  }
  return null;
}

function fromCrux(rec, history) {
  const out = { metrics: {}, period: null, trend: {} };
  const p = rec.collectionPeriod || rec.collectionPeriods?.at(-1);
  if (p) out.period = `${p.firstDate.year}-${String(p.firstDate.month).padStart(2, '0')}-${String(p.firstDate.day).padStart(2, '0')} → ${p.lastDate.year}-${String(p.lastDate.month).padStart(2, '0')}-${String(p.lastDate.day).padStart(2, '0')}`;
  for (const [k, m] of Object.entries(rec.metrics || {})) {
    if (!METRICS[k]) continue;
    if (history) {
      const series = (m.percentilesTimeseries?.p75s || []).map(v => v === null ? null : Number(v));
      const last = series.filter(v => v !== null).at(-1); const first = series.filter(v => v !== null)[0];
      const goods = (m.histogramTimeseries?.[0]?.densities || []);
      out.metrics[k] = { p75: last ?? null, good: goods.filter(v => v !== null).at(-1) ?? null };
      out.trend[k] = { first: first ?? null, last: last ?? null, points: series.filter(v => v !== null).length };
    } else {
      out.metrics[k] = { p75: m.percentiles?.p75 === undefined ? null : Number(m.percentiles.p75), good: m.histogram?.[0]?.density ?? null };
    }
  }
  return out;
}

// ---------- PageSpeed Insights ----------
async function psi(url, formFactor, key) {
  const strategy = formFactor === 'DESKTOP' ? 'desktop' : 'mobile';
  const q = new URLSearchParams({ url, strategy, category: 'performance' }); if (key) q.set('key', key);
  const { status, body } = await getJson(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`);
  if (status !== 200) throw new Error(`PageSpeed Insights ${status}: ${body.error?.message || body.raw || ''}`.trim());
  const pick = (exp) => {
    if (!exp || !exp.metrics || !Object.keys(exp.metrics).length) return null;
    const metrics = {};
    for (const [k, v] of Object.entries(exp.metrics)) { const key2 = PSI_KEYS[k]; if (!key2) continue;
      metrics[key2] = { p75: key2 === 'cumulative_layout_shift' ? v.percentile / 100 : v.percentile, good: v.distributions?.[0]?.proportion ?? null }; }
    return { metrics, period: null, trend: {} };
  };
  const lab = body.lighthouseResult?.audits || {};
  const labRun = { lcp: lab['largest-contentful-paint']?.numericValue ?? null, cls: lab['cumulative-layout-shift']?.numericValue ?? null,
    tbt: lab['total-blocking-time']?.numericValue ?? null, score: body.lighthouseResult?.categories?.performance?.score ?? null };
  const urlLevel = pick(body.loadingExperience); const originLevel = pick(body.originLoadingExperience);
  if (urlLevel && body.loadingExperience?.id && !body.loadingExperience.origin_fallback) return { scope: 'url', data: urlLevel, labRun, source: 'PageSpeed Insights (CrUX field)' };
  if (originLevel || urlLevel) return { scope: 'origin', data: originLevel || urlLevel, labRun, source: 'PageSpeed Insights (CrUX field)' };
  return { scope: null, data: null, labRun, source: 'PageSpeed Insights' };
}

// ---------- main ----------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cruxKey = process.env.CRUX_API_KEY || process.env.GOOGLE_API_KEY; const psiKey = process.env.PSI_API_KEY || process.env.GOOGLE_API_KEY;
  const result = { url: o.url, date: new Date().toISOString(), formFactors: {}, notes: [] };
  const L = [`# Field data: ${o.url}`, '', `${result.date.slice(0, 16).replace('T', ' ')} UTC · Core Web Vitals at p75 for real Chrome users (28-day window). Field = what users feel; lab = why.`, ''];
  if (!cruxKey) {
    result.notes.push('No CRUX_API_KEY: used PageSpeed Insights, which runs a full Lighthouse audit per form factor (~20-40 s each), has a small shared anonymous quota and may drop CrUX data in future; get a free key at https://developer.chrome.com/docs/crux/api.');
    if (o.history) result.notes.push('--history needs the CrUX API; PageSpeed Insights returns the current 28-day window only.');
    if (o.formFactors.includes('TABLET')) result.notes.push('PageSpeed Insights has no tablet strategy; "tablet" was queried as mobile.');
  }

  for (const ff of o.formFactors) {
    let scope = null, data = null, source = '', labRun = null, error = null;
    try {
      if (cruxKey) { const r = await crux(o.url, ff, cruxKey, o.history); if (r) { scope = r.scope; data = fromCrux(r.record, o.history); source = r.source; } else source = 'CrUX API'; }
      else { const r = await psi(o.url, ff, psiKey); scope = r.scope; data = r.data; source = r.source; labRun = r.labRun; }
    } catch (e) { error = e.message + (/quota|429/i.test(e.message) && !cruxKey ? ' The anonymous PageSpeed quota is shared and often exhausted: set CRUX_API_KEY (free) and re-run.' : ''); }
    const name = ff.toLowerCase();
    result.formFactors[name] = { scope, source, period: data?.period || null, metrics: data?.metrics || {}, trend: data?.trend || {}, labRun, error };

    L.push(`## ${name}`, '');
    if (error) { L.push(`Could not fetch: ${error}`, ''); continue; }
    if (!data) { L.push(`**Unavailable**: not enough eligible Chrome traffic for ${ff.toLowerCase()} at URL or origin scope (${source}). This is not a pass. Use lab data (perf_audit.mjs) for diagnosis and add RUM (web-vitals library) if production impact matters.`, ''); continue; }
    L.push(`Scope: **${scope}**${scope === 'origin' ? ' (no URL-level data: this describes the whole site, not this page)' : ''} · source: ${source}${data.period ? ` · period ${data.period}` : ''}`, '');
    L.push('| Metric | p75 | % good | Rating | Good / poor |', '| --- | --- | --- | --- | --- |');
    for (const k of Object.keys(METRICS)) { const m = data.metrics[k]; if (!m) continue;
      const trend = o.history && data.trend[k]?.points > 1 ? ` (${fmt(k, data.trend[k].first)} → ${fmt(k, data.trend[k].last)} over ${data.trend[k].points} weeks)` : '';
      L.push(`| ${METRICS[k].label} | **${fmt(k, m.p75)}**${trend} | ${pct(m.good)} | ${rate(k, m.p75)} | ${fmt(k, METRICS[k].good)} / ${fmt(k, METRICS[k].poor)} |`); }
    const failing = CORE.filter(k => data.metrics[k] && rate(k, data.metrics[k].p75) !== 'good').map(k => METRICS[k].label);
    L.push('', failing.length ? `Core Web Vitals assessment: **fails** (${failing.join(', ')} not good at p75). Fix these first; the lab run shows which sub-part.` : 'Core Web Vitals assessment: **passes** at p75. Lab findings here are hygiene unless a specific page or segment is worse.');
    if (labRun && labRun.lcp !== null) {
      const msOr = (v) => v === null || v === undefined ? '-' : `${Math.round(v)} ms`;
      L.push('', `One PageSpeed lab run for context (single run, not a baseline): LCP ${msOr(labRun.lcp)}, CLS ${labRun.cls === null || labRun.cls === undefined ? '-' : labRun.cls.toFixed(3)}, TBT ${msOr(labRun.tbt)}, Lighthouse performance ${labRun.score === null || labRun.score === undefined ? '-' : Math.round(labRun.score * 100)}.`);
    }
    L.push('');
  }
  if (result.notes.length) L.push('Notes: ' + result.notes.join(' '), '');
  L.push('Read with: URL scope beats origin scope; phone and desktop are separate verdicts; unavailable ≠ passing; a fix shows in CrUX only after weeks, so prove it in the lab now (`perf_audit.mjs --compare`).');
  const md = L.join('\n');
  if (o.out) { await mkdir(o.out, { recursive: true }); await writeFile(path.join(o.out, 'field.md'), md); await writeFile(path.join(o.out, 'field.json'), JSON.stringify(result, null, 2)); }
  console.log(o.json ? JSON.stringify(result, null, 2) : md);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
