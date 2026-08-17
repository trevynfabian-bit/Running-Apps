# Data model

PostgreSQL. Schema in `apps/api/src/db/schema.ts`; generated migrations in
`apps/api/drizzle/`.

## Conventions

- **All timestamps are `timestamptz` in UTC.** Localisation happens only at the
  presentation edge.
- **Training days are `date` in the athlete's timezone.** "Which day was this
  run on" is a local-calendar question — a 23:40 run belongs to Tuesday even
  though it is Wednesday in UTC. `canonical_workouts` carries both
  `start_time` (instant) and `local_date` (training day).
- **Raw provider payloads are retained** alongside normalised columns, so a
  normalisation bug can be fixed and replayed without re-fetching.
- **Unique constraints enforce idempotency.** Not application logic.

## Tables

### Identity

| Table | Notes |
|---|---|
| `users` | Credentials. `password_hash` is scrypt. Unique email. |
| `athlete_profiles` | One per user. Availability, constraints, markers as JSONB. |
| `body_measurements` | Append-only observations, one row per provider per metric per instant. Never overwritten — conflicts are resolved at read time by the provenance engine. |

### Connections

`provider_connections` — one row per (athlete, provider).

`access_token_encrypted` and `refresh_token_encrypted` hold AES-256-GCM
ciphertext and are read only by the token service. They are never selected into
a response DTO. `sync_cursor` holds the provider-specific incremental
high-water mark.

### Raw provider records

`strava_activities`, `whoop_cycles`, `whoop_recoveries`, `whoop_sleep`,
`whoop_workouts`, `healthkit_samples`.

Each has `UNIQUE (connection_id, external_id)`. **This is what makes replayed
webhooks and overlapping sync windows safe** — a duplicate insert conflicts and
updates in place instead of creating a second row.

WHOOP ids are stored as `text`: v2 sleep and workout ids are UUIDs while cycle
ids are int64, and text avoids both precision loss and type confusion.

### Canonical workouts

`canonical_workouts` is the deduplicated training history. Everything
analytical reads from here.

`workout_sources` joins it to the provider records it was built from:

```sql
PRIMARY KEY (canonical_workout_id, provider, external_id)
UNIQUE      (provider, external_id)
```

The unique constraint enforces that **a provider record belongs to exactly one
canonical workout**, which is what makes re-clustering safe: the rebuild pass
repoints sources at the surviving workout and deletes the emptied rows.

`contributed_fields` records which fields each source supplied, so the app can
answer "where did this number come from?" per field, not just per workout.

### Planning

`training_plans` → `training_blocks` → `planned_workouts`.
`race_goals` (targets) and `race_results` (performances that anchor fitness
estimates) are separate: a goal is an intention, a result is evidence.

### Derived daily state

`check_ins`, `recovery_states`, `training_loads`, `coach_decisions` — all
unique on `(athlete_id, date)`, so recomputation updates rather than
accumulates. `weekly_summaries` is unique on `(athlete_id, week_start)`.

Derived state is cached rather than authoritative: it can be rebuilt from
`canonical_workouts` plus the raw provider tables at any time.

### Coach memory

`coach_memory` distinguishes `stated_preference` from `observed_pattern` from
`temporary_condition`, with an `observation_count` and `expires_at`.

Conflating these is how an assistant ends up confidently wrong about someone —
one unusual week must not become a permanent belief about how they train.

### Operations

`sync_jobs` is the durable queue (status, attempts, `run_after` for exponential
backoff). `sync_events` stores inbound webhooks with `UNIQUE (provider,
event_key)` so a redelivery is acknowledged without reprocessing.

`audit_logs` records security- and lifecycle-relevant actions. It contains what
happened and to whom — **never tokens or raw health values**.

## Deletion

Foreign keys cascade from `users` down, so deleting a user removes everything.

Per-provider deletion (`DELETE /api/connections/:provider?deleteData=true`) is
more careful: a canonical workout is removed only when that provider was its
**only** source. A run corroborated by two services survives disconnecting one
of them, with that source's contribution dropped. The UI says this explicitly
before the athlete confirms.

## Row-level security

RLS is **not** enabled. Every query filters by `athlete_id` and the API is the
only database client.

If Supabase is adopted with direct client access, RLS becomes mandatory:

```sql
ALTER TABLE canonical_workouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY athlete_isolation ON canonical_workouts
  USING (athlete_id IN (
    SELECT id FROM athlete_profiles WHERE user_id = auth.uid()
  ));
```

Repeat for every athlete-scoped table. Until then the isolation boundary is the
API, and that is a deliberate, stated position rather than an oversight.

## Migrations

```bash
pnpm --filter @running/api exec drizzle-kit generate --name <description>
pnpm db:migrate
```

Migrations are generated from `schema.ts` rather than hand-written, so the SQL
cannot drift from the TypeScript. The runner works against both PGlite and
real Postgres and records applied migrations, so it is safe to re-run.
