# Backend, API, database and infrastructure

Most "the app is slow" reports end at an API. Measure the endpoint, find where the time goes (DB, external calls, CPU, queueing), fix that part, and re-measure p95 - not the average.

## Measure
- **Single endpoint timing**: `curl -o /dev/null -s -w 'dns %{time_namelookup} connect %{time_connect} tls %{time_appconnect} ttfb %{time_starttransfer} total %{time_total} size %{size_download}\n' <url>` (repeat 20×; add auth headers as needed).
- **Load / latency distribution** (only against environments you own, never production without permission): `npx autocannon -c 20 -d 30 <url>`, `hey -n 500 -c 20 <url>`, `k6 run script.js` (thresholds like `http_req_duration: ['p(95)<300']`), `wrk`. Report p50/p95/p99, throughput and error rate; increase concurrency until latency bends - that is the capacity.
- **Where the time goes**: APM / OpenTelemetry traces (Datadog, New Relic, Sentry, Grafana Tempo, Honeycomb), `Server-Timing` headers, framework debug tools (Laravel Telescope/Debugbar/Pulse, Django Debug Toolbar/Silk, Rails rack-mini-profiler, Node `clinic doctor/flame`, `0x`, `--cpu-prof`), slow-request logs with query counts.
- **Database**: slow query log (MySQL `slow_query_log` + `long_query_time`, Postgres `log_min_duration_statement`, `pg_stat_statements`), `EXPLAIN ANALYZE` (Postgres) / `EXPLAIN ANALYZE` or `EXPLAIN FORMAT=TREE` (MySQL 8), query count per request.
- **Resources**: CPU, memory, connection pool usage, DB connections, queue depth, GC pauses, event-loop lag (Node `perf_hooks.monitorEventLoopDelay`).
- **CPU profiles per language** (when a trace shows time in your code, not in I/O): Node `node --cpu-prof` / `clinic flame` / `0x`, heap `--heap-prof`; Python `python -m cProfile -o out.prof` + `snakeviz`, `py-spy top --pid` and `py-spy record` on a running process without restarting it, `memray` for memory; PHP Xdebug profiler or Blackfire / Tideways, `XHProf`; Go `net/http/pprof` + `go tool pprof -http=:0`, `go test -bench -cpuprofile`; JVM/Kotlin async-profiler, JFR (`-XX:StartFlightRecording`); Ruby `stackprof`, `rack-mini-profiler`; .NET `dotnet-trace`, `dotnet-counters`. Profile under realistic load (replay or the load tool), read self-time top-down, fix the top frames, re-profile.

## Database
- **N+1** (S:`query-in-loop`): one query for the list, then one per row. Fix with eager loading or batching:
  - Laravel: `Model::with('relation')`, `load()`, `loadMissing()`; `Model::preventLazyLoading(!app()->isProduction())` to catch it.
  - Prisma: `include`/`select` relations, or one `findMany({ where: { id: { in: ids } } })`; Drizzle: relational queries / joins.
  - Django: `select_related` (FK/one-to-one), `prefetch_related` (many); Rails: `includes`; SQLAlchemy: `selectinload`/`joinedload`.
  - GraphQL: DataLoader per request.
  - In-memory lookups in loops (`$collection->where('id', $x)->first()`, `array.find` inside `map`) are O(n²): build a map once (`keyBy('id')`, `new Map(items.map(i => [i.id, i]))`).
- **Unbounded queries** (S:`unbounded-query`): always paginate lists; cap page size server-side; select only needed columns (`select([...])`, avoid `SELECT *` on wide tables with blobs/JSON); count with `COUNT(*)` queries, not by loading rows.
- **Pagination**: keyset/cursor (`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20`) instead of large `OFFSET`, which scans skipped rows.
- **Indexes**: for each hot query, index the `WHERE` equality columns first, then range/sort columns (composite index order matters); index foreign keys; covering indexes for read-heavy queries; verify with `EXPLAIN` (look for full scans: `type: ALL` in MySQL, `Seq Scan` on big tables in Postgres, `Using filesort`, `Using temporary`). Functions on indexed columns (`WHERE DATE(created_at) = …`, `LOWER(email)`) prevent index use unless you index the expression. Leading-wildcard `LIKE '%x'` cannot use a B-tree index (use full-text search).
- **Writes**: batch inserts/updates (`insert([...])`, `upsert`, `createMany`), wrap many writes in one transaction, avoid row-by-row updates in loops; long transactions hold locks and block others.
- **Connection pooling** (S:`connection-per-call`): one pool per process; size it to the DB's limits across all instances; serverless needs an external pooler (PgBouncer, RDS Proxy, Supabase/Neon poolers, Prisma Accelerate) and a module-level client singleton.
- **Read replicas** for heavy read traffic and reports; keep writes and read-after-write on the primary.
- **Big tables**: partitioning or archiving old rows; summary tables / materialized views for dashboards instead of aggregating millions of rows per request.

## Caching
Layers, from closest to the user: browser cache → CDN/edge → application cache (Redis/Memcached/in-process) → DB cache/materialized views.
- Cache keys must include everything that changes the result (user/tenant, locale, filters, permissions). Never put per-user responses in a shared cache without the user in the key; use `Cache-Control: private` for per-user HTTP responses.
- TTL + explicit invalidation on writes; `stale-while-revalidate` to avoid thundering herds; lock/single-flight around expensive recomputation (Laravel `Cache::lock`, `Cache::flexible`; Node single-flight helpers).
- Cache expensive, frequently read, rarely changed data: config, reference lists (currencies, banks, countries), permission sets, rendered fragments, third-party responses with their allowed TTLs.
- HTTP: `ETag`/`Last-Modified` + 304 for API responses that clients re-fetch; CDN caching for public GET endpoints (`s-maxage`).

## External calls
- **Timeouts on every outgoing call** (S:`no-timeout`): connect + read/total. Laravel `Http::timeout(5)->connectTimeout(2)`; Guzzle `timeout`/`connect_timeout`; Python `requests.get(url, timeout=(3, 10))`; Node `fetch(url, { signal: AbortSignal.timeout(5000) })`, axios `timeout`; Go `http.Client{Timeout: …}`.
- Retries only for idempotent operations, with exponential backoff + jitter and a cap; idempotency keys for payments and other writes.
- Circuit breakers / fallbacks for flaky dependencies so one slow provider does not exhaust workers.
- **Parallelize independent calls** (S:`serial-awaits`): `Promise.all`, `asyncio.gather`, Laravel `Http::pool`, Guzzle promises, `async let`, Go goroutines + errgroup. Respect provider rate limits (concurrency caps such as `p-limit`).
- Move slow calls out of the request (next section) when the user does not need the result immediately.

## Background jobs and queues
- Queue anything slow that the response does not need: emails, notifications, webhooks out, PDF/report generation, image/video processing, search indexing, analytics, third-party syncs (Laravel queues + Horizon, BullMQ, Celery/RQ, Sidekiq, Cloud Tasks/SQS).
- Return quickly (202 Accepted + job id, or optimistic success), then push the result (WebSocket/SSE/push notification) or let the client poll with backoff.
- Jobs must be idempotent and retry-safe; set timeouts and max attempts; monitor queue depth and age.
- Scheduled heavy work (reports, cleanups) off-peak, in chunks (`chunkById`, cursor iteration) to avoid memory blowups and long locks.

## Payloads and protocol
- Compression (brotli/gzip) for JSON; avoid sending fields the client does not use (API resources/serializers, GraphQL field selection); paginate nested collections.
- HTTP keep-alive and HTTP/2 between services; reuse clients (S:`connection-per-call` for HTTP clients created per call).
- Binary formats (protobuf/MessagePack) only when JSON size/parse time is proven to matter.
- Avoid chatty APIs: one screen should not need 20 requests; add an aggregate endpoint/BFF or batch endpoint.

## AI / LLM features
- **Stream** responses (S:`ai-not-streamed`) - time to first token is what users feel; render incrementally (SSE, `ReadableStream`, framework AI SDK streaming helpers).
- Use prompt caching for long repeated system prompts/context where the provider supports it; cache final answers for identical inputs when appropriate.
- Pick the smallest model that meets quality for each step (classification, routing, extraction) and reserve large models for hard steps; cap `max_tokens`.
- Parallelize independent LLM calls; set timeouts; move long generations to background jobs with progress updates.
- Measure: time to first token, total time, tokens in/out, cost per request, error/timeout rate.

## Runtime and infrastructure
- **PHP/Laravel**: OPcache on (with sane `validate_timestamps` in production), `config:cache`/`route:cache`/`view:cache`/`event:cache`, `composer --optimize-autoloader --classmap-authoritative`, PHP-FPM `pm` settings sized to memory, Octane/FrankenPHP/RoadRunner for high-throughput APIs (watch for state leaking between requests), Redis for cache/session/queue instead of file/database drivers.
- **Node**: never block the event loop (sync fs/crypto/JSON on large inputs, S:`sync-io`); use worker threads for CPU work; cluster or multiple instances per core; stream large responses/files instead of buffering.
- **Python**: async frameworks (FastAPI/Starlette) need async drivers - a sync DB call inside `async def` blocks the loop; gunicorn/uvicorn workers sized to cores; Celery for slow work.
- **Region and CDN**: app, DB and cache in the same region; app region near most users; CDN for static assets and cacheable pages; edge functions only for logic that does not need the central DB on every request.
- **Load balancing and scaling**: stateless instances (sessions/cache in Redis), health checks, autoscaling on CPU/latency/queue depth, graceful shutdown; check that one hot instance is not caused by sticky sessions.
- **Cold starts** (serverless): smaller bundles, fewer dependencies, provisioned concurrency/min instances for latency-critical functions, keep DB connections pooled.

## Observability (prevent the next regression)
- Per-endpoint p50/p95/p99 latency, error rate and throughput dashboards; alerts on p95 and error rate, not averages.
- Traces with DB spans and external-call spans; log query counts and slow queries per request.
- RUM on clients connected to backend traces (trace ids in request headers) to see full user-perceived latency.
- Performance tests in CI for critical endpoints (k6 thresholds) and a load test before big launches or campaigns.
