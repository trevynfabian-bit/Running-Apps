# Architecture

## Shape

```
┌─────────────────────────────────────────────┐
│  apps/mobile — Expo / React Native          │
│  screens · design system · offline cache    │
└───────────────┬─────────────────────────────┘
                │ HTTPS, bearer token
┌───────────────▼─────────────────────────────┐
│  apps/api — Hono                            │
│  routes · services · sync engine            │
│  ┌────────────────────────────────────────┐ │
│  │ providers: strava · whoop · healthkit  │ │
│  │            manual · mock               │ │
│  └────────────────────────────────────────┘ │
└───────────────┬─────────────────────────────┘
                │
        ┌───────▼────────┐   ┌──────────────────┐
        │  PostgreSQL    │   │ packages/core    │
        │  (PGlite dev)  │   │ pure domain +    │
        └────────────────┘   │ engines, no I/O  │
                             └──────────────────┘

modules/health-kit — Swift native module (iOS only)
        reads on-device, pushes to the ingest endpoint
```

## Layering

**Domain (`packages/core`)** — the whole model and every engine. Zero runtime
dependencies, no I/O, no implicit clock, no randomness. Callers inject ids and
timestamps. This is what makes coaching logic reproducible and testable, and
it is why 204 unit tests run in under a second.

**Application (`apps/api/src/services`)** — assembles athlete context and
orchestrates use cases. `loadAthleteContext` is deliberately the *single*
place that builds the picture of an athlete, so the dashboard, the coach and
the review generator cannot disagree about the same person.

**Infrastructure (`apps/api/src/providers`, `db`)** — external APIs and
persistence. Providers implement one interface; nothing upstream branches on
which service data came from.

**Presentation (`apps/mobile`)** — screens compose design-system primitives.
No business logic; no API-shape knowledge beyond the typed client.

## Key decisions

### Embedded Postgres for development

`DATABASE_URL` unset selects PGlite — real Postgres compiled to WASM. Same SQL
dialect, same migrations, same constraints, no service to install. Production
points at Supabase/RDS/Neon by setting the variable. Tests therefore exercise
genuine unique constraints and upserts rather than mocks.

### Idempotency lives in the database

Every provider table has a unique index on `(connection, external_id)`, and
`workout_sources` is unique on `(provider, external_id)`. Replayed webhooks and
overlapping sync windows cannot duplicate rows regardless of application logic.
Canonical workouts are *rebuilt* from provider rows rather than appended to, so
running a sync twice leaves the database identical to running it once — a
property the test suite asserts directly.

### Deduplication is weighted, not rule-based

No single signal is trusted: device clocks drift, GPS distance disagrees by a
few percent between platforms, and auto-detected activities clip the start.
Hard gates reject impossible matches (different provider, different sport, far
apart in time); a weighted score decides the rest. Single-link clustering is
used because A may match B strongly and C weakly while all three are the same
run.

### One authentication boundary

Auth is a single allowlist in `app.ts` and defaults to requiring a token. It is
not attached to routers, because a sub-app mounted at `/api` with a wildcard
`use()` also captures `/api/webhooks/*` and the OAuth callback — neither of
which can carry a bearer token. That bug shipped and was caught by the
integration tests; the allowlist form makes it structurally hard to
reintroduce.

### The LLM never decides

```
raw data → normalisation → features → athlete state
        → plan → deterministic decision → LLM explanation → athlete
```

The engine decides and generates its own explanation. The model rephrases.
A model outage degrades prose, never training.

## Extension points

Designed for, not built:

- **More providers** (Garmin, COROS, Polar, Oura) — implement
  `FitnessDataProvider`, register it. Sync, dedup and the UI need no changes.
- **Weather** — `CanonicalWorkout` already carries `temperatureCelsius`, and
  the efficiency engine already excludes hot runs from comparison.
- **Route intelligence** — GPS is stored; route similarity is already computed
  during dedup.
- **Apple Watch** — the workout structure model is player-agnostic.
- **Other sports** — `SportType` and the load engine already handle non-running
  activity as recovery cost.

## Known gaps

Stated plainly rather than implied:

- **The Train screen does not capture live GPS, pace or heart rate.** It shows
  elapsed time and the prescription. Live capture needs background location and
  sensor integration; showing a fabricated or stale number mid-interval would be
  worse than showing none. Completed runs are imported from Strava/HealthKit.
- **The native HealthKit module has not been compiled.** This environment has no
  iOS toolchain, so the Swift and the config plugin are written and reviewed but
  unverified against a real build. Everything TypeScript-side degrades safely on
  non-iOS platforms and is exercised by the app.
- **Webhook processing uses an in-process queue.** `sync_jobs` is the durable
  record, so moving to a worker process changes who calls `processQueuedJobs`,
  not how work is represented. Fine for one instance; needs a real worker before
  horizontal scaling.
- **Row-level security is not enabled.** Every query filters by `athleteId` and
  the API is the only client. If Supabase is adopted with direct client access,
  RLS policies become mandatory — see `DATA_MODEL.md`.
- **Strava's inferred workout types are heuristic.** Session type is guessed
  from the activity name and shape, deliberately conservatively.
- **Notifications are modelled but not delivered.** Preferences are stored; no
  push transport is wired up.
