# Cross-platform apps (React Native / Expo, Flutter)

Same rules as native: release builds on real mid-range devices; Android usually shows problems first. Check framework versions (new architecture, Hermes, Impeller defaults changed across releases) and confirm APIs in current docs.

## React Native / Expo

### Measure
- Release build: `npx expo run:android --variant release` / `npx expo run:ios --configuration Release`, or `npx react-native run-android --mode release`; EAS builds for real-device testing.
- Startup: native tools (see [Android](android.md) `am start -W`, [iOS](ios.md) App Launch) plus JS bundle load/execute time; `react-native-performance` marks for JS-side timings.
- JS thread vs UI thread: the Perf Monitor (Dev Menu) shows both FPS values - dropped JS FPS means JavaScript work (renders, logic); dropped UI FPS means native rendering/layout.
- React Native DevTools (Profiler, Performance panel in newer versions) and React DevTools Profiler for re-renders; Flipper is deprecated.
- Bundle: `npx react-native-bundle-visualizer` or `npx expo export --dump-sourcemap` + `source-map-explorer`; Expo Atlas (`EXPO_UNSTABLE_ATLAS=true npx expo start`).
- Native traces: Perfetto/systrace (Android) and Instruments (iOS) still apply.

### Fix
- **Hermes** engine (default in modern RN/Expo): faster startup via bytecode precompilation; make sure it is not disabled.
- **New Architecture** (Fabric + TurboModules/JSI, default since RN 0.76): synchronous native calls without bridge serialization; keep libraries compatible.
- **Lists**: `FlashList` (Shopify) or `FlatList`, never `ScrollView` + `.map()` for long data (S:`list-not-virtualized`); stable `keyExtractor`; for FlatList set `getItemLayout` for fixed heights, tune `windowSize`/`initialNumToRender`/`maxToRenderPerBatch`; memoize `renderItem` and row components; no inline heavy objects in row props.
- **Re-renders**: React Compiler or `React.memo`/`useCallback` where the profiler shows waste; split global state (Zustand/Jotai selectors, Redux selectors with shallow equality); avoid context for fast-changing values.
- **Animations**: Reanimated worklets (UI thread) and `react-native-gesture-handler`; for `Animated`, `useNativeDriver: true` (transform/opacity only).
- **Images**: `expo-image` (memory + disk cache, downsampling, blurhash placeholders) or `react-native-fast-image`; serve correctly sized images from the CDN; avoid huge local PNGs (S:`big-asset`).
- **Startup**: lazy-load screens (React Navigation lazy, `React.lazy` for heavy screens), inline requires / `experimentalImportSupport` with `inlineRequires: true` in Metro, defer SDK initialization, avoid large synchronous `AsyncStorage`/MMKV reads at launch (MMKV is synchronous and fast; still keep startup reads small).
- **JS thread work**: move heavy computation off the JS thread (native module, worklets, `react-native-worklets-core`), defer non-urgent work with `InteractionManager.runAfterInteractions` or `requestIdleCallback`.
- **Production**: strip `console.log` (babel `transform-remove-console`), disable dev-only tooling, enable ProGuard/R8 and resource shrinking on Android.
- **Network/data**: TanStack Query for dedupe and caching, pagination with infinite queries, debounce search, `AbortController` on unmount.

## Flutter

### Measure
- `flutter run --profile` on a device (debug mode is JIT and much slower - never judge performance in debug).
- Flutter DevTools → Performance (frame chart: UI thread vs raster thread), CPU profiler, Memory, "Track widget rebuilds", Performance overlay (`showPerformanceOverlay: true`).
- Startup: `flutter run --trace-startup --profile` writes `start_up_info.json` (time to first frame); native tools for the engine part.
- Size: `flutter build apk --analyze-size` / `flutter build ios --analyze-size`, then open in DevTools App Size tool.
- Integration benchmarks: `integration_test` with `traceAction` / `watchPerformance` to record frame timings in CI.

### Fix
- **UI thread jank** (build/layout too slow): `const` constructors for static subtrees; split large widgets so `setState` rebuilds a small subtree; use `ValueListenableBuilder`/`Selector`/Riverpod `select` to rebuild only what changed; avoid heavy work in `build`.
- **Raster thread jank** (GPU): avoid `Opacity` animations (use `FadeTransition`/`AnimatedOpacity`), `saveLayer` triggers (`ShaderMask`, `ColorFilter`, clip with antialias on many widgets, `BackdropFilter` over large areas); add `RepaintBoundary` around frequently repainting parts; Impeller (default on iOS and modern Android) removes most shader compilation jank - check the engine in use.
- **Lists**: `ListView.builder`/`GridView.builder`/`SliverList` for long data, not `ListView(children: …map)` (S:`list-not-virtualized`); `itemExtent`/`prototypeItem` for fixed heights.
- **Images**: `cacheWidth`/`cacheHeight` (or `ResizeImage`) to decode at display size; `cached_network_image`; precache critical images.
- **Isolates**: `compute()` / `Isolate.run()` for JSON parsing of large payloads, image processing, crypto.
- **Startup**: defer plugin initialization, avoid awaiting network before `runApp`, show a skeleton first frame, keep `main()` minimal; deferred components (Android) for rarely used features.
- **Network/data**: reuse a `http.Client`/Dio instance with timeouts, paginate, cache responses, debounce search.
