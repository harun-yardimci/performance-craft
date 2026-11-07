// Generates vendor.js for the "before" demo: a large bundle that is mostly unused on the page,
// plus 260 ms of "hydration" work at load. Run: node make-vendor.mjs
import { writeFileSync } from "node:fs";

let source = "/* demo: a bundled UI kit + date library + charts, mostly unused on this page */\n";
for (let i = 0; i < 2600; i++) {
  source += `function util${i}(a,b){const r=[];for(let k=0;k<(a||3);k++){r.push((b||"x")+k*${i});}return r.join("-")+"${"lorem".repeat(6)}";}\n`;
}
source += "window.__hydrate=function(){const t=performance.now();while(performance.now()-t<260){}return util1(2,'a');};\nwindow.__hydrate();\n";
writeFileSync(new URL("./vendor.js", import.meta.url), source);
console.log(`vendor.js: ${(source.length / 1024).toFixed(0)} KB`);
