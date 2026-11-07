/* Demo third-party tag: 180 ms of main-thread work. Blocks the parser when loaded synchronously. */
(function () { const start = performance.now(); while (performance.now() - start < 180) {} window.__tag = 1; })();
