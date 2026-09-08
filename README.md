# Running OS

A personal running coach and performance intelligence system.

It aggregates Strava, WHOOP and Apple Health into one deduplicated training
history, estimates fitness and recovery from it, generates a periodised plan,
and adapts that plan day to day — explaining every decision it makes.

The loop it implements:

```
MEASURE → UNDERSTAND → PLAN → TRAIN → RECOVER → ANALYSE → ADAPT → IMPROVE
```

---

## Quick start

No API credentials are needed. Mock mode generates a realistic athlete history
so the whole product runs end to end out of the box.

```bash
pnpm install
cp .env.example .env

pnpm db:migrate     # embedded Postgres (PGlite) — no server to install
pnpm db:seed        # 12 weeks of training across three providers
pnpm api:dev        # http://localhost:4000

pnpm mobile:start   # Expo — press i for iOS
```

The seed prints credentials to sign in with (`athlete@example.com`).

Verify everything:

```bash
pnpm verify         # typecheck + lint + tests
```

---

## What's here

```
packages/core         Domain model and performance engines. Pure TypeScript,
                      zero runtime dependencies, 204 unit tests.
packages/contracts    Zod schemas shared by the app and the API.
apps/api              Hono + Drizzle + PostgreSQL. Providers, sync, coaching.
apps/mobile           Expo / React Native app.
modules/health-kit    Native Swift HealthKit module + Expo config plugin.
docs/                 Architecture, data model, integrations, coaching engine.
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first.

---

## The parts that matter

### One run, three services, one record

The same run arrives from Strava, WHOOP and Apple Health with different start
times, distances and clipping. Counting it three times would corrupt every
volume, load and fitness number downstream, so ingest matches records on
weighted similarity across time, duration, distance, heart rate and route, then
merges them field by field — GPS distance from Strava, heart rate from WHOOP —
recording which source supplied what.

The seed demonstrates it: **165 provider records collapse to 55 canonical
workouts, merging 110 duplicates.**

### Decisions are deterministic; the LLM only explains them

`decideToday` in `packages/core` decides what the athlete does, from recovery,
load, hard-day spacing and race proximity. It generates its own explanation.
The AI coach reads that decision and rephrases it.

The model is never given the database — it receives a small curated context
object. If it is unavailable, misconfigured, or absent entirely, the athlete
still gets a correct decision and a coherent explanation. A deterministic
responder answers questions from the same context, and the UI says when it did.

### Estimates are labelled as estimates

Race predictions, VO₂max and threshold pace are modelled, not measured, and
carry a confidence derived from data recency, sample count and model agreement.
A marathon extrapolated from a 5K is shown with lower confidence than a 10K,
because it is a weaker claim.

### Recovery is our own interpretation, not a copy

The composite score combines the wearable's own number with HRV and resting
heart rate **relative to the athlete's own baseline**, sleep, subjective
check-in and training load. Weights redistribute across whatever signals are
present, so a missing strap lowers confidence rather than the score. It
diverges from any single provider's number by design.

### It is a coach, not a clinician

The app never diagnoses. Reported pain overrides every other signal and returns
rest plus a recommendation to see a qualified professional. Sustained extreme
fatigue triggers a referral prompt, phrased as a signpost.

---

## Configuration

Everything runs without credentials. To connect real services, set the
variables in `.env.example` and set `USE_MOCK_DATA=false`.

Client secrets are **backend-only**. Nothing prefixed `EXPO_PUBLIC_` is a
secret — those values ship inside the app binary.

See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for the OAuth, webhook and
HealthKit setup.

---

## Testing

```bash
pnpm test                          # everything
pnpm --filter @running/core test   # engines only
pnpm --filter @running/api test    # end-to-end API
```

API tests run against real Postgres via PGlite with real migrations, so
constraints, upserts and idempotency are genuinely exercised.

---

## Status

Working end to end: sign-up, onboarding, provider connection, historical sync,
deduplication, fitness estimation, plan generation, daily coaching decisions,
workout execution and logging, post-workout analysis, progress trends, weekly
review, and the coach.

Known gaps are listed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#known-gaps)
— most notably that the Train screen does not capture live GPS or heart rate,
and that the native HealthKit module has not been compiled against a real iOS
toolchain in this environment.
