#!/usr/bin/env python3
"""Static scan for performance leads in source code (web, mobile, backend).

Usage: python3 static_perf_audit.py [path] [--max N] [--json] [--only RULE,RULE]

Hits are leads, not verdicts: open each one, confirm it is on a hot path (a list row,
a request handler, a render function, app start) and measure before and after a fix.

Rules (language in brackets):
  query-in-loop        A DB/HTTP call inside a loop body: N+1 queries or serial requests
                       [JS/TS await in for/forEach, PHP, Python, Swift, Kotlin, Dart]
  serial-awaits        Three or more independent `await` calls in a row that could run in
                       parallel (Promise.all / async let / coroutineScope) [JS/TS, Swift]
  unbounded-query      Query without a limit: Prisma findMany without take, SQL SELECT
                       without LIMIT, Eloquent ::all() / ->get(), Django .objects.all()
  no-timeout           Outgoing HTTP without a timeout: Python requests, Laravel Http::,
                       axios.create / fetch in server code without a timeout or AbortSignal
  connection-per-call  A DB client or connection created per call instead of a pool
                       (new PrismaClient() inside a function, mysql createConnection, new Pool
                       in a handler)
  sync-io              Blocking I/O on a request or UI path: readFileSync/execSync in server
                       routes, Data(contentsOf:) / String(contentsOf:) in Swift, runBlocking in
                       Android code
  ai-not-streamed      LLM call (Anthropic messages.create, OpenAI chat.completions.create)
                       in a file that never streams: users wait for the whole answer
  polling              setInterval / Timer that fetches on a short period (consider push,
                       SSE/WebSocket or a longer back-off)
  search-no-debounce   A text-change handler that fetches, in a file with no debounce /
                       throttle / useDeferredValue
  heavy-dependency     Known heavy packages in package.json (moment, full lodash, aws-sdk v2,
                       …) and duplicated libraries doing the same job
  heavy-import         Whole-library imports that defeat tree shaking (import _ from 'lodash',
                       import * as Icons, require('moment'))
  img-no-dimensions    <img> without width+height (layout shift) or below-the-fold images
                       without loading="lazy" [HTML/JSX]
  raw-img-in-next      <img> in a Next.js project instead of next/image
  google-fonts-link    Fonts loaded from fonts.googleapis.com (extra connection; self-host)
  big-asset            Images > 300 KB, PNG photos > 150 KB, TTF/OTF web fonts, GIFs > 200 KB
                       in the repository's asset folders
  list-not-virtualized ScrollView + .map (RN), ScrollView { VStack { ForEach (SwiftUI),
                       Column(verticalScroll) + forEach (Compose), ListView(children: …map)
                       (Flutter), very long .map lists rendered without a virtualizer (web)
  list-key             Lazy list items without stable keys: Compose items() without key,
                       React key={index}, SwiftUI ForEach over indices
  formatter-in-body    DateFormatter/NumberFormatter/JSONDecoder/SimpleDateFormat created
                       inside a SwiftUI body or @Composable (created on every render)
  observedobject-init  @ObservedObject var x = Model(): recreated on every parent update
                       (use @StateObject / @State)
  anyview              AnyView type erasure (defeats SwiftUI diffing); counted per file
  geometry-in-list     GeometryReader inside a List / ForEach row
  collect-lifecycle    collectAsState() instead of collectAsStateWithLifecycle()
  release-not-minified Android release build with minify disabled
  no-baseline-profile  Android app module without a baseline profile plugin

Skipped dirs: node_modules, build, dist, .next, Pods, DerivedData, vendor, …
"""
import argparse
import json
import os
import re
import sys

SKIP_DIRS = {".git", "node_modules", "build", "dist", ".next", "DerivedData", "Pods", ".build", "out",
             "coverage", ".gradle", "vendor", ".turbo", ".svelte-kit", ".nuxt", ".output", "__pycache__",
             ".venv", "venv", "env", ".dart_tool", "site-packages", "dist-packages", "bower_components", "third_party", "third-party", "vendors", "Carthage", "SourcePackages", ".swiftpm", "target", "storage", "bootstrap", ".expo", "ios/Pods", "public/build"}
CODE_EXT = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte", ".php", ".py", ".swift", ".kt",
            ".kts", ".dart", ".html", ".gradle", ".java"}
ASSET_DIRS = ("public", "static", "assets", "src", "app", "res", "Assets.xcassets", "resources", "images", "img")
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff"}
FONT_EXT = {".ttf", ".otf"}

LOOP = re.compile(r"^\s*(?:for\s*\(|for\s+(?:await\s+)?[\w\[\]{}, ]+\s+(?:of|in)\b|foreach\s*\(|while\s*\(|for\s+\w+\s+in\s+|[\w.)\]]+\.forEach\s*[({]|\w+\.forEach\s*\{|repeat\s*\{)")
JS_CALL = re.compile(r"\bawait\s+(?!Promise\.all|Promise\.allSettled|new Promise|sleep|delay|setTimeout)[\w.$\[\]()'\"]*?(?:fetch|axios|\.find\w*|\.query|\.execute|prisma|db\.|\.get|\.post|\.put|\.select|\.insert|\.update|\.request|supabase|knex|sql)\b")
PHP_CALL = re.compile(r"(?:::find\(|->find\(|::where\(|->where\(.*->(?:first|get)\(|DB::(?:table|select)|Http::|->load\(|curl_exec|file_get_contents\(\s*['\"]https?)")
PY_CALL = re.compile(r"(?:\.objects\.(?:get|filter)\(|requests\.(?:get|post|put|delete)\(|session\.(?:query|execute)\(|cursor\.execute\(|httpx\.(?:get|post|put|delete)\()")
SWIFT_CALL = re.compile(r"(?:try\s+)?await\s+[\w.]*(?:fetch|load|request|data\(for|get|query)\w*\(")
KT_CALL = re.compile(r"(?:\.execute\(\)|\.await\(\)|dao\.\w+\(|api\.\w+\(|repository\.\w+\()")
DART_CALL = re.compile(r"await\s+[\w.]*(?:get|post|fetch|query|load)\w*\(")


# folders that hold docs, screenshots, reports or scratch work rather than shipped code/assets
VENDORED = re.compile(r"/(public|static|assets?|wwwroot)/(.*/)?(plugins?|libs?|vendors?|dist)/")
NON_APP = re.compile(r"/(docs?|design|screenshots?|outputs?|work|quality|evidence|marketing|fastlane|reports?|tmp|temp|archive|backup|samples?|demo|examples?|fixtures?)/")


def walk(root):
    for dp, dns, fns in os.walk(root):
        if "pyvenv.cfg" in fns:
            dns[:] = []; continue
        dns[:] = [d for d in dns if d not in SKIP_DIRS and not d.startswith(".") or d == "Assets.xcassets"]
        # TypeScript projects: lib/ next to src/ + tsconfig.json is compiled output - scan the source once
        if "lib" in dns and "src" in dns and "tsconfig.json" in fns:
            dns.remove("lib")
        for fn in fns:
            yield os.path.join(dp, fn)


class Scan:
    def __init__(self, root, cap):
        self.root, self.cap, self.hits, self.counts, self.seen = root, cap, {}, {}, set()

    def add(self, rule, path, line, text):
        key = (rule, path, line)
        if key in self.seen:
            return
        self.seen.add(key)
        self.counts[rule] = self.counts.get(rule, 0) + 1
        lst = self.hits.setdefault(rule, [])
        if len(lst) < self.cap:
            lst.append({"file": os.path.relpath(path, self.root), "line": line, "text": text.strip()[:160]})


def indent(s):
    return len(s) - len(s.lstrip())


def loop_bodies(lines, i, n=8):
    """Lines that belong to the loop starting at i (by indentation, capped at n)."""
    base = indent(lines[i]); out = []
    for j in range(i + 1, min(len(lines), i + 1 + n)):
        l = lines[j]
        if l.strip() == "":
            continue
        if indent(l) <= base and not l.strip().startswith(("}", ")", "]")):
            break
        if indent(l) <= base:
            break
        out.append((j, l))
    # same-line bodies: for (...) { await x() }
    if "{" in lines[i] or lines[i].rstrip().endswith(":"):
        out.insert(0, (i, lines[i].split("{", 1)[-1] if "{" in lines[i] else ""))
    return out


def scan_code(s, path, text, ext, ctx):
    lines = text.split("\n")
    is_js = ext in {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"}
    # Path filters apply to the path INSIDE the scanned project, never to where the project lives
    # (a repo under ~/work/ or /tmp/ must still be scanned).
    low = "/" + os.path.relpath(path, s.root).replace("\\", "/").lower()
    is_server = is_js and any(k in low for k in ("/api/", "/server/", "/routes/", "/controllers/", "/services/",
                                                 "/lib/server", "route.ts", "route.js", "+server.", ".server.", "/functions/", "/backend/")) and "/public/" not in low
    is_test = bool(re.search(r"(^|/)[^/]*tests?(/|$)|uitests/", low)) or any(k in low for k in ("/test", "spec.", ".test.", "/__tests__/", "/fixtures/", "/mocks/", "/scripts/", "/seed", "/eval/", "/docs/", "/examples/"))
    if is_test or NON_APP.search(low) or VENDORED.search(low):
        return
    if ext == ".html" and not re.search(r"/(public|static|src|app|templates|views|pages|www)/|/index\.html$", low):
        return

    # ---- loops: N+1 / serial requests
    call = {".php": PHP_CALL, ".py": PY_CALL, ".swift": SWIFT_CALL, ".kt": KT_CALL, ".java": KT_CALL, ".dart": DART_CALL}.get(ext, JS_CALL if is_js else None)
    if call:
        for i, l in enumerate(lines):
            if not LOOP.search(l):
                continue
            for j, b in loop_bodies(lines, i):
                if call.search(b):
                    s.add("query-in-loop", path, j + 1, b)
                    break

    # ---- serial awaits (3+ consecutive independent awaits)
    if is_js or ext == ".swift":
        run = []
        for i, l in enumerate(lines):
            m = re.match(r"\s*(?:const|let|var)\s+(\w+|\{[^}]*\})\s*(?::[^=]+)?=\s*(?:try\s+)?await\s+(.+)", l)
            if m:
                prev_names = [r[1] for r in run]
                uses_prev = any(re.search(r"\b%s\b" % re.escape(n), m.group(2)) for n in prev_names if n.isidentifier())
                if uses_prev:
                    run = []
                run.append((i, m.group(1)))
                if len(run) == 3:
                    s.add("serial-awaits", path, run[0][0] + 1, lines[run[0][0]] + " (+2 more awaits in a row)")
            elif l.strip() and not l.strip().startswith("//"):
                run = []

    for i, l in enumerate(lines):
        st = l.strip()
        if st.startswith(("//", "#", "*", "/*")) and ext not in {".py"}:
            continue
        n = i + 1
        # unbounded queries
        if is_js and re.search(r"\.findMany\(\s*(\{|\))", l):
            window = " ".join(lines[i:i + 8])
            if not re.search(r"\b(take|limit|first|cursor)\s*:", window):
                s.add("unbounded-query", path, n, l)
        if re.search(r"\bSELECT\s.+?\sFROM\s+[`\"]?\w|['\"`]\s*select\s+[\w.*`]+(\s*,\s*[\w.*`]+)*\s+from\s+\w", l) and not re.search(r"\b(LIMIT|TOP|COUNT\(|WHERE|FETCH FIRST|EXISTS)\b", " ".join(lines[i:i + 4]), re.I) and ext not in {".html", ".py"} or (ext == ".py" and re.search(r"execute\(\s*[fr]?['\"]\s*SELECT\b(?!.*\b(LIMIT|WHERE)\b)", l, re.I)):
            s.add("unbounded-query", path, n, l)
        if ext == ".php" and (re.search(r"::all\(\)", l) or (re.search(r"->get\(\)\s*;", l) and not re.search(r"where|limit\(|take\(|paginate|find|->(pluck|chunk)", " ".join(lines[max(0, i - 6):i + 1]), re.I))):
            s.add("unbounded-query", path, n, l)
        if ext == ".py" and re.search(r"\.objects\.all\(\)", l) and not re.search(r"\[\s*:\s*\d+|paginat", l):
            s.add("unbounded-query", path, n, l)

        # timeouts
        if ext == ".py" and re.search(r"\brequests\.(get|post|put|patch|delete|request)\(", l):
            if "timeout" not in " ".join(lines[i:i + 4]):
                s.add("no-timeout", path, n, l)
        if ext == ".php" and re.search(r"Http::(?!timeout|withOptions|fake)\w+\(", l) and "timeout(" not in l:
            s.add("no-timeout", path, n, l)
        if is_server and re.search(r"\bawait\s+fetch\(", l) and not re.search(r"signal|timeout", " ".join(lines[i:i + 6]), re.I):
            s.add("no-timeout", path, n, l)
        if is_js and re.search(r"axios\.create\(\s*\{?", l) and "timeout" not in " ".join(lines[i:i + 8]):
            s.add("no-timeout", path, n, l)

        # connection per call
        if is_js and re.search(r"new PrismaClient\(", l) and indent(l) > 0 and "globalThis" not in " ".join(lines[max(0, i - 3):i + 1]):
            s.add("connection-per-call", path, n, l)
        if re.search(r"\b(mysql2?|mysql)\.createConnection\(|\bcreateConnection\(", l) and is_js:
            s.add("connection-per-call", path, n, l)
        if is_js and re.search(r"new (pg\.)?(Pool|Client)\(", l) and indent(l) >= 4:
            s.add("connection-per-call", path, n, l)
        if ext == ".py" and re.search(r"psycopg2?\.connect\(|pymysql\.connect\(|create_engine\(", l) and indent(l) >= 8:
            s.add("connection-per-call", path, n, l)

        # sync io
        if is_server and indent(l) >= 4 and re.search(r"\b(readFileSync|writeFileSync|execSync|spawnSync)\(", l):
            s.add("sync-io", path, n, l)
        if ext == ".swift" and re.search(r"\b(Data|String)\(contentsOf:\s*(URL\(string:|\w*(remote|http|image|photo|avatar|download)\w*\b)", l, re.I) and not re.search(r"Bundle|appending|fileURL|documents", l):
            s.add("sync-io", path, n, l)
        if ext in {".kt", ".java"} and re.search(r"\brunBlocking\b", l):
            s.add("sync-io", path, n, l)

        # polling
        m = re.search(r"setInterval\([^,]+,\s*(\d+)\s*\)", l)
        if is_js and m and int(m.group(1)) < 10000:
            body = " ".join(lines[max(0, i - 8):i + 1])
            if re.search(r"fetch|axios|refetch|query|load", body):
                s.add("polling", path, n, l)
        if is_js and re.search(r"refetchInterval\s*:\s*(\d+)", l) and int(re.search(r"refetchInterval\s*:\s*(\d+)", l).group(1)) < 10000:
            s.add("polling", path, n, l)

        # heavy imports
        if is_js:
            if re.search(r"""(import\s+\w+\s+from|require\()\s*['"](lodash|moment|aws-sdk|rxjs|antd|@mui/material|@mui/icons-material|date-fns|ramda)['"]""", l):
                s.add("heavy-import", path, n, l)
            elif re.search(r"""import\s+\*\s+as\s+\w+\s+from\s+['"](lodash|@mui/icons-material|lucide-react|react-icons/\w+|@heroicons/react/\w+/\w+|date-fns)['"]""", l):
                s.add("heavy-import", path, n, l)

        # images
        if (is_js or ext in {".html", ".php"}) and re.search(r"<img\b", l):
            tag = " ".join(lines[i:i + 6]); tag = tag[tag.find("<img"):]; tag = tag[:tag.find(">") + 1] if ">" in tag else tag
            if not (re.search(r"\bwidth\s*=", tag) and re.search(r"\bheight\s*=", tag)) and "aspect" not in tag and "fill" not in tag:
                s.add("img-no-dimensions", path, n, tag)
            if ctx.get("next") and is_js:
                s.add("raw-img-in-next", path, n, tag)
        if re.search(r"(href=|@import|url\()\s*['\"]?https://fonts\.googleapis\.com", l):
            s.add("google-fonts-link", path, n, l)

        # lists
        if ext in {".jsx", ".tsx", ".js"} and re.search(r"key=\{\s*(index|i|idx)\s*\}", l):
            s.add("list-key", path, n, l)
        if ext == ".kt" and re.search(r"^\s*items\(\s*[\w.]+\s*\)\s*\{", l):
            s.add("list-key", path, n, l)
        if ext == ".swift" and re.search(r"ForEach\(\s*[\w.]+\.indices", l):
            s.add("list-key", path, n, l)

        if ext == ".swift":
            if re.search(r"@ObservedObject\s+(private\s+)?var\s+\w+\s*(:\s*\w+)?\s*=\s*\w+\(", l):
                s.add("observedobject-init", path, n, l)
            if "AnyView(" in l:
                s.add("anyview", path, n, l)
            if "GeometryReader" in l and re.search(r"\b(List|ForEach|LazyVStack|LazyHStack|LazyVGrid)\b", " ".join(lines[max(0, i - 8):i])):
                s.add("geometry-in-list", path, n, l)
            if re.search(r"^\s*ScrollView\b(?!\(\.horizontal)", l) and re.search(r"^\s*(VStack|HStack)\b", " ".join(lines[i + 1:i + 3]).strip()) and "ForEach" in " ".join(lines[i:i + 8]):
                s.add("list-not-virtualized", path, n, l)
        if ext == ".kt":
            if "collectAsState()" in l:
                s.add("collect-lifecycle", path, n, l)
            if re.search(r"verticalScroll\(", l) and re.search(r"\.forEach\s*\{|for\s*\(", " ".join(lines[i:i + 8])):
                s.add("list-not-virtualized", path, n, l)
        if ext == ".dart" and re.search(r"ListView\(\s*$|ListView\(\s*children\s*:", l) and re.search(r"\.map\(|for\s*\(", " ".join(lines[i:i + 8])):
            s.add("list-not-virtualized", path, n, l)
        if is_js and re.search(r"<ScrollView\b", l) and ctx.get("rn") and re.search(r"\.map\(", " ".join(lines[i:i + 15])):
            s.add("list-not-virtualized", path, n, l)

    # formatters inside SwiftUI body / @Composable
    if ext == ".swift" and "var body" in text:
        in_body = False; depth = 0
        for i, l in enumerate(lines):
            if re.search(r"var body\s*:\s*some\s+View", l):
                in_body, depth = True, 0
            if in_body:
                depth += l.count("{") - l.count("}")
                if re.search(r"\b(DateFormatter|NumberFormatter|JSONDecoder|JSONEncoder|ISO8601DateFormatter|MeasurementFormatter|NSRegularExpression|CIContext)\(", l):
                    s.add("formatter-in-body", path, i + 1, l)
                if re.search(r"UIImage\(data:", l):
                    s.add("formatter-in-body", path, i + 1, l + "  (image decode in body)")
                if depth <= 0 and "{" in "".join(lines[i - 1:i + 1]):
                    in_body = False
    if ext == ".kt" and "@Composable" in text:
        for i, l in enumerate(lines):
            if re.search(r"\b(SimpleDateFormat|DecimalFormat|Regex|Gson|Moshi\.Builder|DateTimeFormatter\.ofPattern)\(", l) and "remember" not in l and indent(l) >= 8:
                s.add("formatter-in-body", path, i + 1, l)

    # file-level rules
    if is_js and re.search(r"(messages\.create|chat\.completions\.create|responses\.create|generateText)\(", text) and not re.search(r"stream", text, re.I):
        i = next(k for k, l in enumerate(lines) if re.search(r"(messages\.create|chat\.completions\.create|responses\.create|generateText)\(", l))
        s.add("ai-not-streamed", path, i + 1, lines[i])
    if ext == ".py" and re.search(r"(messages\.create|chat\.completions\.create)\(", text) and "stream" not in text:
        i = next(k for k, l in enumerate(lines) if re.search(r"(messages\.create|chat\.completions\.create)\(", l))
        s.add("ai-not-streamed", path, i + 1, lines[i])
    if is_js and re.search(r"onChange(Text)?\s*=|addEventListener\(\s*['\"]input['\"]", text) and re.search(r"fetch\(|axios|useQuery|trpc|supabase", text) \
            and re.search(r"search|query|filter|autocomplete|ara", text, re.I) and not re.search(r"debounce|throttle|useDeferredValue|useDebounce|setTimeout", text):
        i = next((k for k, l in enumerate(lines) if re.search(r"onChange(Text)?\s*=|addEventListener\(\s*['\"]input", l)), 0)
        s.add("search-no-debounce", path, i + 1, lines[i])


HEAVY = {
    "moment": "use dayjs / date-fns / Intl (moment is ~70 KB gz, not tree-shakable)",
    "lodash": "use lodash-es with per-function imports or native methods",
    "aws-sdk": "AWS SDK v2: move to modular @aws-sdk/client-* v3",
    "jquery": "rarely needed next to a modern framework",
    "core-js": "check browserslist; modern targets need few polyfills",
    "@babel/polyfill": "deprecated; rely on targeted core-js via browserslist",
    "chart.js": "fine, but import only the controllers you use (not chart.js/auto)",
    "firebase": "use the modular v9+ API and import only the services you use",
    "rxjs": "fine if used; check it is not pulled in by a single helper",
    "antd": "check per-component imports and CSS-in-JS cost",
    "three": "lazy-load the 3D view; not on the critical path",
    "pdfjs-dist": "lazy-load on demand",
    "xlsx": "lazy-load on demand (large)",
    "highlight.js": "import only needed languages",
    "@fortawesome/fontawesome-free": "use an SVG icon set with per-icon imports",
}
DUPES = [({"moment", "dayjs", "date-fns", "luxon"}, "date libraries"), ({"axios", "ky", "got", "node-fetch", "superagent"}, "HTTP clients"),
         ({"lodash", "lodash-es", "underscore", "ramda"}, "utility libraries"), ({"@mui/material", "antd", "@chakra-ui/react", "@mantine/core"}, "UI kits"),
         ({"redux", "@reduxjs/toolkit", "mobx", "zustand", "jotai", "recoil"}, "state libraries")]


def scan_package(s, path, ctx):
    try:
        pkg = json.load(open(path, encoding="utf-8"))
    except Exception:
        return
    deps = {**pkg.get("dependencies", {})}
    if "next" in deps:
        ctx["next"] = True
    if "react-native" in deps or "expo" in deps:
        ctx["rn"] = True
    for name, why in HEAVY.items():
        if name in deps:
            s.add("heavy-dependency", path, 1, f'"{name}": {deps[name]}  -> {why}')
    for group, label in DUPES:
        have = sorted(group & set(deps))
        if len(have) > 1:
            s.add("heavy-dependency", path, 1, f"{len(have)} {label}: {', '.join(have)} -> keep one")


def scan_gradle(s, path, text):
    if re.search(r"com\.android\.application|id\(\"com\.android\.application\"\)|alias\(libs\.plugins\.android\.application\)", text):
        if re.search(r"(isMinifyEnabled|minifyEnabled)\s*(=)?\s*false", text) and "release" in text:
            ln = next(i for i, l in enumerate(text.split("\n")) if re.search(r"(isMinifyEnabled|minifyEnabled)\s*(=)?\s*false", l))
            s.add("release-not-minified", path, ln + 1, "release minify disabled (R8 off: bigger, slower app)")
        if re.search(r"(isMinifyEnabled|minifyEnabled)\s*(=)?\s*true", text) and not re.search(r"(isShrinkResources|shrinkResources)\s*(=)?\s*true", text):
            ln = next(i for i, l in enumerate(text.split("\n")) if re.search(r"(isMinifyEnabled|minifyEnabled)\s*(=)?\s*true", l))
            s.add("release-not-minified", path, ln + 1, "R8 on but resource shrinking off (isShrinkResources): unused resources ship; keep names resolved via getIdentifier in res/raw/keep.xml")
        if not re.search(r"baselineprofile|baselineProfile", text) and not re.search(r"android\.application\)?\s*apply\s+false", text):
            s.add("no-baseline-profile", path, 1, "no app Baseline Profile (androidx.baselineprofile): library profiles from Compose arrive via profileinstaller, but your startup and journey code is still interpreted/JIT on first runs")


def scan_asset(s, path, root):
    rel = "/" + os.path.relpath(path, root).replace("\\", "/").lower()
    if NON_APP.search(rel) or rel.count("/") < 2 or not re.search(r"/(public|static|assets?|res|resources|images?|img|media|src|app)/|\.xcassets/", rel):
        return
    ext = os.path.splitext(path)[1].lower()
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    if ext in IMG_EXT:
        if size > 300 * 1024 or (ext == ".png" and size > 150 * 1024 and "icon" not in path.lower()) or (ext == ".gif" and size > 200 * 1024):
            s.add("big-asset", path, 0, f"{size // 1024} KB {ext}")
    elif ext in FONT_EXT and any(k in path.replace("\\", "/") for k in ("/public/", "/static/", "/assets/fonts", "/fonts/")) and "/android/" not in path and ".xcassets" not in path:
        s.add("big-asset", path, 0, f"{size // 1024} KB {ext} web font (use WOFF2, subset)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", nargs="?", default=".")
    ap.add_argument("--max", type=int, default=15, help="max hits shown per rule (default 15)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--only", default="", help="comma list of rules")
    a = ap.parse_args()
    root = os.path.abspath(a.path)
    s = Scan(root, a.max); ctx = {}
    files = list(walk(root))
    for p in files:
        if os.path.basename(p) == "package.json" and not VENDORED.search("/" + os.path.relpath(p, root).replace("\\", "/").lower()):
            scan_package(s, p, ctx)
    for p in files:
        ext = os.path.splitext(p)[1].lower(); base = os.path.basename(p)
        if ext in IMG_EXT or ext in FONT_EXT:
            scan_asset(s, p, root); continue
        if ext not in CODE_EXT and not base.endswith(".gradle.kts"):
            continue
        try:
            if os.path.getsize(p) > 1_500_000:
                continue
            text = open(p, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        if re.search(r"\.min\.(js|css)$", base) or "generated" in os.path.relpath(p, root).lower():
            continue
        if ext in {".gradle", ".kts"} and "build.gradle" in base:
            if not NON_APP.search("/" + os.path.relpath(p, root).replace("\\", "/").lower()):
                scan_gradle(s, p, text)
            continue
        scan_code(s, p, text, ext, ctx)
    only = {r.strip() for r in a.only.split(",") if r.strip()}
    hits = {k: v for k, v in s.hits.items() if not only or k in only}
    if a.json:
        print(json.dumps({"root": root, "counts": {k: s.counts[k] for k in hits}, "hits": hits}, indent=2)); return
    if not hits:
        print(f"No performance leads found under {root}."); return
    order = ["query-in-loop", "unbounded-query", "connection-per-call", "sync-io", "no-timeout", "serial-awaits", "ai-not-streamed",
             "list-not-virtualized", "formatter-in-body", "observedobject-init", "search-no-debounce", "polling", "heavy-dependency",
             "heavy-import", "big-asset", "img-no-dimensions", "raw-img-in-next", "google-fonts-link", "list-key", "geometry-in-list",
             "anyview", "collect-lifecycle", "release-not-minified", "no-baseline-profile"]
    print(f"Performance leads under {root} (confirm each; measure before/after)\n")
    for rule in sorted(hits, key=lambda r: order.index(r) if r in order else 99):
        total = s.counts[rule]
        print(f"## {rule} ({total} hit{'s' if total != 1 else ''}{', showing ' + str(len(hits[rule])) if total > len(hits[rule]) else ''})")
        for h in hits[rule]:
            loc = f"{h['file']}:{h['line']}" if h["line"] else h["file"]
            print(f"  {loc}  {h['text']}")
        print()


if __name__ == "__main__":
    main()
