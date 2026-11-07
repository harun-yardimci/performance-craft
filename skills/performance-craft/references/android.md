# Android performance (Jetpack Compose / Views)

Measure **release** builds (R8 on, debuggable off) on a **real mid-range device**. Debug builds run Compose and Kotlin without optimizations and with extra checks - they can be several times slower and are not representative. Check AGP/Kotlin/Compose versions before using newer APIs and confirm them in Android docs.

## What to measure
| Symptom | Metric | Tool |
| --- | --- | --- |
| Slow startup | Time to initial display (TTID), time to full display (TTFD, needs `reportFullyDrawn()`), cold/warm/hot | `adb shell am start -W -S -n <pkg>/<activity>` (TotalTime), Macrobenchmark `StartupTimingMetric`, Logcat `Displayed`; Play Console → Android vitals (field) |
| Jank | Slow frames (> 16 ms at 60 Hz), frozen frames (> 700 ms), P50/P90/P99 frame time | Macrobenchmark `FrameTimingMetric`; `adb shell dumpsys gfxinfo <pkg> framestats` (reset with `dumpsys gfxinfo <pkg> reset`); Perfetto; JankStats in production |
| ANR / freezes | Main thread blocked ≥ 5 s for input → ANR; shorter blocks → jank | StrictMode, Perfetto/System Trace, Play vitals ANR clusters |
| Compose recomposition | Recomposition and skip counts | Android Studio Layout Inspector (recomposition counts), Compose compiler reports/metrics, composition tracing in Perfetto |
| Memory | Heap growth, leaks, GC churn | Android Studio Memory Profiler, LeakCanary (debug), `adb shell dumpsys meminfo <pkg>` |
| Battery | Wakelocks, jobs, location, network | Battery Historian, Android Studio Energy/Power profiler, Play vitals (excessive wakeups, stuck wake locks) |
| App size | Download size | Play Console app size, APK Analyzer, `bundletool get-size total` |

Useful commands:
- Cold start: `adb shell am force-stop <pkg> && adb shell am start -W -n <pkg>/<.MainActivity>` (repeat 10×, take median of TotalTime).
- Compile like a user after install with a profile: `adb shell cmd package compile -m speed-profile -f <pkg>`; reset to no compilation for worst case: `adb shell cmd package compile --reset <pkg>`.
- Frame stats: `adb shell dumpsys gfxinfo <pkg> reset`, perform the scroll, then `adb shell dumpsys gfxinfo <pkg>` ("Janky frames", percentiles).
- System trace: `adb shell perfetto -o /data/misc/perfetto-traces/trace.perfetto-trace -t 10s sched freq idle am wm gfx view binder_driver hal dalvik input res` then `adb pull` and open in ui.perfetto.dev.
- Play vitals bad-behavior thresholds: user-perceived ANR rate 0.47%, user-perceived crash rate 1.09% (overall); slow cold start ≥ 5 s, warm ≥ 2 s, hot ≥ 1.5 s.

## Startup
- **Baseline Profiles** (S:`no-baseline-profile`): AOT-compile startup and critical user journeys - typically ~20-30% faster startup and smoother first scrolls. Add the `androidx.baselineprofile` Gradle plugin + a `:baselineprofile` module with a Macrobenchmark generator, and `androidx.profileinstaller`. Startup Profiles (DEX layout) on top for cold start.
- **R8** full mode for release (`isMinifyEnabled = true`, `isShrinkResources = true`) (S:`release-not-minified`).
- Do less in `Application.onCreate` and the first Activity: lazy SDK initialization (App Startup library with lazy initializers, or initialize on first use), no disk/network on the main thread, no large DI graphs eagerly created.
- Show the first frame fast with the SplashScreen API; keep the splash only while truly needed (`setKeepOnScreenCondition` briefly), call `reportFullyDrawn()` when real content is shown.
- Avoid content providers from libraries that auto-initialize (check merged manifest).

## Main thread
- StrictMode in debug (`detectDiskReads/Writes`, `detectNetwork`, `detectCustomSlowCalls`, `penaltyLog`) to catch I/O on the main thread.
- Coroutines: `Dispatchers.IO` for blocking I/O, `Dispatchers.Default` for CPU work; never `runBlocking` in app code (S:`sync-io`). Room/Retrofit suspend functions already move off the main thread.
- Large JSON parsing (Gson/Moshi/kotlinx.serialization) off the main thread; prefer kotlinx.serialization or Moshi codegen over reflection.
- SharedPreferences `commit()` on main and large preference files cause jank: migrate to DataStore.

## Jetpack Compose
- Measure in release with Baseline Profiles; Compose in debug is not representative.
- **Stability and skipping**: since Kotlin 2.0.20 strong skipping is on by default, so unstable parameters no longer block skipping as much; still prefer immutable data, `kotlinx.collections.immutable` for list parameters, `@Immutable/@Stable` only when true, and a stability configuration file for external types. Check compiler reports (`composeCompiler { reportsDestination = …; metricsDestination = … }`).
- **Defer state reads** to the latest phase: lambda modifiers for frequently changing values (`Modifier.offset { IntOffset(x, 0) }`, `graphicsLayer { alpha = a }`, `drawBehind { }`) instead of `Modifier.offset(x.dp)`/`alpha(a)` which recompose every frame.
- `derivedStateOf` for values computed from frequently changing state (e.g. "show FAB when firstVisibleItemIndex > 0"); `remember(key)` for expensive calculations; no object creation of formatters/regex/Gson in composition (S:`formatter-in-body`).
- **Lazy lists**: `LazyColumn`/`LazyRow`/`LazyVerticalGrid` for long content, never `Column(Modifier.verticalScroll)` + `forEach` for large/unbounded data (S:`list-not-virtualized`); stable `key = { it.id }` and `contentType` in `items()` (S:`list-key`); avoid nested scrollables in the same direction; keep item composables light.
- Avoid backwards writes (writing state that was just read in the same composition) - causes infinite recomposition.
- Collect flows with `collectAsStateWithLifecycle()` (S:`collect-lifecycle`) so work stops in the background.
- Images: Coil with size constraints (`size(…)`/the composable's measured size), crossfade sparingly, placeholders with fixed size.
- Animations: `animate*AsState`, `updateTransition`; avoid animating layout-affecting values when a `graphicsLayer` transform works.

## Views (XML)
- RecyclerView with `DiffUtil`/`ListAdapter`, stable ids, `setHasFixedSize(true)` when applicable, shared `RecycledViewPool` for nested lists, prefetch.
- Flatten layouts (ConstraintLayout), avoid nested weights and deep hierarchies; `ViewStub` for rarely shown views.
- Overdraw: Developer options → Debug GPU overdraw; remove redundant backgrounds.

## Network and data
- OkHttp: one shared client (connection pool), timeouts set, response cache with server headers, HTTP/2; Retrofit suspend APIs.
- Parallelize independent calls with `coroutineScope { async { } }`; cancel with the lifecycle (`viewModelScope`, `lifecycleScope`).
- Paging 3 for long lists from network/DB; Room queries with indexes (`@Index`), `LIMIT`, only needed columns; observe with Flow instead of polling.
- WorkManager for deferrable background work (sync, uploads) with constraints; avoid long-running foreground services unless needed.

## Memory
- LeakCanary in debug builds; fix leaks from static references to Context/Activity, unregistered listeners/callbacks, long-lived coroutines capturing views.
- Bitmaps: decode at target size (Coil/Glide do this), avoid holding full-resolution bitmaps; `onTrimMemory` to drop caches.

## Field data
- Play Console → Android vitals: ANR rate, crash rate, slow start, slow/frozen frames, excessive wakeups, per device and version. These thresholds affect store visibility.
- Firebase Performance Monitoring (traces, network) or JankStats/Macrobenchmark in CI for regressions.
