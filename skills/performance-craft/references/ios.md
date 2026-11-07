# iOS performance (SwiftUI / UIKit)

Measure on a **real device** with a **Release** build (Profile scheme in Xcode builds Release by default). The Simulator runs on Mac hardware and hides launch, memory and GPU problems; use it only for relative comparisons. Check the deployment target before using newer APIs and confirm them in Apple's docs.

## What to measure
| Symptom | Metric | Tool |
| --- | --- | --- |
| Slow launch | Time to first frame / first useful content, cold vs warm | Instruments **App Launch** template; `XCTApplicationLaunchMetric` in a UI test; Xcode Organizer → Launch Time (field) |
| UI freezes | Hangs (main thread blocked ≥ 250 ms; > 500 ms severe) | Instruments **Time Profiler** + **Hangs**; Xcode Organizer → Hangs; MetricKit `MXHangDiagnostic`; on-device Developer → Hang Detection |
| Scroll/animation stutter | Hitch rate (ms of hitches per second), dropped frames | Instruments **Animation Hitches**; `XCTOSSignpostMetric.scrollDecelerationMetric` in UI tests |
| SwiftUI too many updates | Body evaluations per change, long view updates | Instruments **SwiftUI** template (View Body / update groups; the newer SwiftUI instrument shows long updates and cause-and-effect); `let _ = Self._printChanges()` inside `body` (debug only) |
| Memory growth / jetsam | Footprint, leaks, abandoned memory | Instruments **Allocations** (mark generations while repeating an action), **Leaks**; Xcode Memory Graph; Organizer → Memory / terminations |
| Battery / heat | CPU wakeups, location/network/GPU use | Instruments **Energy Log** / **Power Profiler**; Organizer → Energy; MetricKit |
| Network | Request count, waterfalls, payload size | Instruments **Network** (HTTP Traffic); Proxyman/Charles |
| App size | Download/install size | App Store Connect size report; `xcodebuild -exportArchive` App Thinning Size Report |

Command line (useful from an agent):
- List devices: `xcrun xctrace list devices`
- Launch trace: `xcrun xctrace record --template 'App Launch' --device <UDID> --launch -- /path/App.app` (or `--attach <pid>` / `--all-processes`), then open the `.trace` in Instruments or `xcrun xctrace export --input file.trace --toc`.
- Time profile a running app: `xcrun xctrace record --template 'Time Profiler' --device <UDID> --attach <AppName> --time-limit 20s`.
- Simulator UI tests with metrics: `xcodebuild test -scheme <Scheme> -destination 'platform=iOS,id=<UDID>' -only-testing:<UITests>/<PerfTests>` (device for real numbers).
- Signposts: wrap work in `OSSignposter` intervals so it shows up in Instruments and `XCTOSSignpostMetric`.

## Launch
- Do less before the first frame: no network, DB migrations, big JSON decoding, analytics SDK setup or image decoding in `App.init`, `application(_:didFinishLaunchingWithOptions:)` or the root view's `init`. Defer to after first frame (`Task { }` with lower priority, `.task` on a later view).
- Lazy-initialize singletons and SDKs; initialize third-party SDKs after launch unless they must capture launch (crash reporting).
- Fewer dynamic frameworks (each adds dyld work); prefer static linking / merged libraries (Xcode mergeable libraries) where available.
- Avoid heavy `+load` / static initializers (Objective-C `+load`, C++ static constructors).
- Show cached content immediately (last known state from disk) and refresh in the background.
- Storyboard launch screens should be simple; the first SwiftUI screen should not wait on async data to render its skeleton.

## Main thread and hangs
- Never block the main thread with I/O: `Data(contentsOf:)`, `String(contentsOf:)`, synchronous `FileManager` scans, Core Data/SwiftData fetches of large sets, `JSONDecoder` on big payloads, image decoding of large photos, `UserDefaults` with huge values.
- Swift concurrency: work in `@MainActor` types runs on the main thread. Move heavy work to a non-main actor or `Task.detached`/a `nonisolated` async function; hop back only to assign results. With Swift 6.2 approachable concurrency defaults (main-actor-by-default projects), mark CPU-heavy helpers `@concurrent`/`nonisolated` as appropriate - check the project's settings.
- Avoid `DispatchQueue.main.sync`, semaphores waiting on async work, and `Task { }` loops that hop to the main actor per item.
- Locks/actors contended by the main thread show as hangs in Time Profiler ("waiting").

## SwiftUI rendering
- Keep `body` cheap and pure: no formatter/decoder/regex creation (S:`formatter-in-body` → `static let` or cached), no sorting/filtering large arrays (precompute in the model), no image decoding (`UIImage(data:)`) per evaluation.
- Narrow observation: with `@Observable` (Observation framework), views only update for properties they read - read fewer properties in large parent views, pass smaller values down. With `ObservableObject`, any `@Published` change invalidates every observing view: split objects or migrate to `@Observable`.
- `@StateObject`/`@State` own models; `@ObservedObject var x = Model()` recreates the model on parent updates (S:`observedobject-init`).
- Lists: `List` or `LazyVStack`/`LazyVGrid` inside `ScrollView` for long/unbounded content (S:`list-not-virtualized`); stable `Identifiable` ids (not `indices`, not `id: \.self` on mutable values, S:`list-key`); avoid `AnyView` in rows (S:`anyview`) and `GeometryReader` per row (S:`geometry-in-list`).
- Prefer conditional modifiers that keep identity (`.opacity`, ternaries in modifier arguments) over `if/else` branches that rebuild view trees, when toggling frequently.
- Equatable views (`.equatable()` / `EquatableView`) for expensive rows that receive unchanged data.
- Expensive effects (`.blur`, `.shadow` on many views, `.mask`, `.drawingGroup()` misuse) on scrolling content cause offscreen rendering: profile with Animation Hitches before adding them; `.drawingGroup()` helps only for complex vector drawing.
- `.task(id:)` for async loading tied to view lifetime (cancels automatically) instead of `.onAppear { Task { } }` without cancellation.

## UIKit
- Cell reuse (`dequeueReusableCell`), diffable data sources with stable identifiers, `UICollectionView` prefetching (`prefetchDataSource`) for images/data.
- Avoid `layoutIfNeeded` loops and Auto Layout constraint churn in `cellForItemAt`; precompute sizes or use self-sizing cells correctly.
- `shouldRasterize`, shadows without `shadowPath`, and masks/corner radius with `masksToBounds` on many layers cause offscreen passes.

## Images
- Downsample to display size with ImageIO (`CGImageSourceCreateThumbnailAtIndex` with `kCGImageSourceThumbnailMaxPixelSize`) or `UIImage.preparingThumbnail(of:)` / `byPreparingForDisplay()` off the main thread.
- Cache decoded thumbnails (`NSCache`) and use an image pipeline (Nuke, Kingfisher, SDWebImage) or `AsyncImage` only for simple cases (it does not cache beyond URLCache).
- Asset catalogs: provide sizes close to display; HEIC/compressed JPEG for photos; PDF/SVG vectors for icons with "Preserve Vector Data" only when scaling is needed.
- Large bundled images also inflate app size and launch memory (S:`big-asset`).

## Data and network
- URLSession: reuse a session; set `timeoutIntervalForRequest`; HTTP/2/3 is automatic; enable `URLCache` with proper server headers; use `waitsForConnectivity` for background-friendly requests.
- Parallelize independent requests with `async let` / `withTaskGroup` (S:`serial-awaits`); cancel when views disappear.
- Paginate long lists; decode on a background executor; avoid decoding huge payloads you don't display.
- SwiftData/Core Data: fetch limits and batch sizes, predicates in the store (not filtering in memory), `@Query` with sort/predicate and fetch limit, background contexts for imports, indexes (`#Index` in SwiftData on iOS 18+) for frequently filtered properties.

## Memory and energy
- Retain cycles: closures capturing `self` in long-lived objects (timers, NotificationCenter, Combine sinks) - use `[weak self]`, store and cancel `AnyCancellable`, invalidate timers.
- Repeat an action 5-10× in Allocations with generations; steady growth = leak or unbounded cache.
- Respond to memory warnings by clearing caches; cap `NSCache` costs.
- Energy: stop location updates when not needed (lowest accuracy that works), coalesce network calls, avoid short repeating timers (use `Timer` tolerance), pause animations/video offscreen, use background tasks (`BGTaskScheduler`) instead of keeping the app awake.

## Field data
- Xcode Organizer: launch time, hang rate, hitches, memory, disk writes, energy, terminations - per app version, real devices.
- MetricKit (`MXMetricManager`): daily metrics and diagnostics payloads (hangs, CPU exceptions, crashes) to your backend.
- Compare versions after each release; regressions in Organizer are the strongest signal for prioritization.
