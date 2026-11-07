// Only what this page uses. The third-party tag loads once the page is idle.
const yieldToMain = () => new Promise(resolve =>
  globalThis.scheduler?.yield ? scheduler.yield().then(resolve) : setTimeout(resolve, 0));

document.querySelectorAll(".add").forEach(button => button.addEventListener("click", async () => {
  document.getElementById("status").textContent = "Added to cart"; // visible update first
  await yieldToMain();
  // Recommendations are recalculated afterwards, in small chunks.
  for (let i = 0; i < 8; i++) {
    const start = performance.now(); while (performance.now() - start < 40) {}
    await yieldToMain();
  }
}));

setTimeout(() => { document.getElementById("promo").textContent = "Free shipping over $60 this week"; }, 900);

(window.requestIdleCallback || setTimeout)(() => {
  const tag = document.createElement("script"); tag.src = "analytics.js"; document.head.append(tag);
});
