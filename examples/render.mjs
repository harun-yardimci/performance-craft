// Renders every mockup in examples/ to assets/<name>.png at 2x.
// Needs the skill's playwright-core: (cd skills/performance-craft/scripts && npm install)
//   node examples/render.mjs
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(path.join(here, "../skills/performance-craft/scripts/node_modules/playwright-core/index.mjs")).href);
const pages = readdirSync(here).filter(f => f.endsWith(".html"));
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
for (const file of pages) {
  await page.goto(pathToFileURL(path.join(here, file)).href);
  await page.waitForLoadState("networkidle");
  let body = await page.locator("body").boundingBox();
  await page.setViewportSize({ width: 1280, height: Math.ceil(body.height) });
  body = await page.locator("body").boundingBox();
  const out = path.join(here, "..", "assets", file.replace(".html", ".png"));
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: Math.ceil(body.width), height: Math.ceil(body.height) } });
  console.log("assets/" + path.basename(out));
}
await browser.close();
