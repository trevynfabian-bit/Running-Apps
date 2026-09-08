# Integrations

Setup for Strava, WHOOP and Apple Health, plus the facts that were verified
against primary sources rather than recalled.

Every endpoint and scope string lives in one file per provider
(`apps/api/src/providers/<provider>/api.ts`) so there is exactly one place to
re-check against the official documentation.

---

## Mock mode

`USE_MOCK_DATA=true` (the default) swaps every provider for a generator with
an identical interface. No network calls, no credentials, deterministic output
seeded from the athlete id.

The generated data is realistic rather than tidy — the same run appears in
multiple providers with slightly different distance, duration and start time,
some runs have no heart rate, and recovery responds to training load — so the
dedup and recovery engines are genuinely exercised rather than trivially
satisfied.

---

## Strava

### Setup

1. Create an application at <https://www.strava.com/settings/api>.
2. Set the Authorization Callback Domain to your API host (`localhost` in dev).
3. Fill in `.env`:

```
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REDIRECT_URI=http://localhost:4000/api/connections/strava/callback
STRAVA_WEBHOOK_VERIFY_TOKEN=any-string-you-choose
USE_MOCK_DATA=false
```

### Endpoints

| Purpose | Endpoint |
|---|---|
| Authorize | `GET https://www.strava.com/oauth/authorize` |
| Token / refresh | `POST https://www.strava.com/oauth/token` |
| Revoke | `POST https://www.strava.com/oauth/revoke` |
| API base | `https://www.strava.com/api/v3` |
| Webhooks | `https://www.strava.com/api/v3/push_subscriptions` |

> **Deauthorization endpoint changed.** As of 1 June 2026 `POST /oauth/revoke`
> is Strava's recommended deauthorization endpoint and becomes the **only**
> supported one on 1 June 2027; `/oauth/deauthorize` is deprecated. The client
> calls `/oauth/revoke` first and falls back to the legacy path only if
> rejected, so it works across the transition in both directions. This is the
> kind of detail that would have been wrong if taken from memory.

### Scopes

`read`, `activity:read_all`, `profile:read_all`.

`activity:read_all` is required to see activities marked private or
followers-only. Without it a private long run silently vanishes from the
athlete's history, corrupting every volume and load figure. **No write scope is
requested** — the app never modifies Strava data.

### Webhooks

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=$STRAVA_CLIENT_ID \
  -F client_secret=$STRAVA_CLIENT_SECRET \
  -F callback_url=https://your-host/api/webhooks/strava \
  -F verify_token=$STRAVA_WEBHOOK_VERIFY_TOKEN
```

Strava GETs the callback with `hub.mode`, `hub.challenge` and
`hub.verify_token`, expecting the challenge echoed back as
`{"hub.challenge": "..."}`. Events are persisted, deduplicated on a derived
key, acknowledged immediately, then processed out of band.

`object_type: "athlete"` with `updates.authorized === "false"` is the
deauthorization signal and clears the stored tokens.

### Rate limits

Usage is read from the `X-RateLimit-Usage` / `X-RateLimit-Limit` response
headers, and pagination stops early at 90% of the short-term limit or 95% of
the daily limit rather than waiting to be rejected. The next scheduled sync
resumes from the stored cursor.

---

## WHOOP (v2)

### Setup

1. Create an application at <https://developer.whoop.com>.
2. Add the redirect URI.
3. Fill in `.env`:

```
WHOOP_CLIENT_ID=
WHOOP_CLIENT_SECRET=
WHOOP_REDIRECT_URI=http://localhost:4000/api/connections/whoop/callback
WHOOP_WEBHOOK_SECRET=
USE_MOCK_DATA=false
```

### Source of truth

Every endpoint, scope and field name was taken from WHOOP's published OpenAPI
document at `https://api.prod.whoop.com/developer/doc/openapi.json`. A snapshot
is committed at [`whoop-openapi-v2.snapshot.json`](whoop-openapi-v2.snapshot.json)
so the model can be diffed against it later.

| Purpose | Endpoint |
|---|---|
| Authorize | `https://api.prod.whoop.com/oauth/oauth2/auth` |
| Token | `https://api.prod.whoop.com/oauth/oauth2/token` |
| API base | `https://api.prod.whoop.com/developer` |

| Data | Path |
|---|---|
| Cycles | `GET /v2/cycle`, `/v2/cycle/{id}` |
| Recovery | `GET /v2/recovery`, `/v2/cycle/{cycleId}/recovery` |
| Sleep | `GET /v2/activity/sleep`, `/v2/activity/sleep/{id}` |
| Workouts | `GET /v2/activity/workout`, `/v2/activity/workout/{id}` |
| Profile | `GET /v2/user/profile/basic` |
| Body | `GET /v2/user/measurement/body` |
| Revoke | `DELETE /v2/user/access` |

### Scopes

```
read:recovery  read:cycles  read:sleep  read:workout
read:profile   read:body_measurement    offline
```

Two things that bite:

- **Note the inconsistent pluralisation** — `read:cycles` is plural,
  `read:workout` singular. These are copied verbatim from the OpenAPI document.
- **`offline` is not a data scope.** It is what makes WHOOP issue a refresh
  token. Without it the integration silently stops working when the first
  access token expires.

### v1 → v2 differences that matter

- Sleep and workout ids are **UUIDs** in v2 (int64 in v1). Cycle ids remain
  int64. All are stored as text to avoid both precision loss and type
  confusion.
- Records carry `score_state`, which may be `PENDING_SCORE` or `UNSCORABLE`.
  **A non-SCORED record has no `score` object at all** — every consumer must
  tolerate its absence rather than assuming a score exists. Pending records are
  stored so we know they exist and filled in when the scored webhook arrives.
- Pagination is by opaque `nextToken`, not numeric offsets.

### Webhooks

Configure the URL as `https://your-host/api/webhooks/whoop` and set
`WHOOP_WEBHOOK_SECRET`.

Signature verification is HMAC-SHA256 over `timestamp + rawBody`, compared in
constant time. **The raw body must be used** — re-serialising parsed JSON
changes key order and whitespace, and therefore the digest. Timestamps older
than 5 minutes are rejected to blunt replay.

In production, an unconfigured webhook secret returns 503 rather than
accepting unverified payloads.

---

## Apple Health / HealthKit

### The architectural constraint

**HealthKit has no server API.** Health data lives on-device in an encrypted
store that only the user's own device can read; Apple provides no mechanism for
a backend to reach it. Anything claiming otherwise is not describing HealthKit.

So the flow inverts. The iOS app reads via the native module and POSTs
normalised samples to `POST /api/connections/healthkit/ingest`, which is
idempotent on the HKSample UUID. `HealthKitProvider.capabilities.serverPull` is
`false`, and its pull methods throw explicitly rather than silently returning
nothing.

### Setup

No credentials. Requires a real iOS device or simulator and a development
build — HealthKit is not available in Expo Go.

```bash
pnpm --filter @running/mobile prebuild
# then open apps/mobile/ios in Xcode, or use EAS
```

The config plugin injects three things during prebuild, all of which are
required for HealthKit to function at all:

1. `com.apple.developer.healthkit` entitlement.
2. `NSHealthShareUsageDescription`. **Without this iOS terminates the app the
   moment it requests authorization** — a hard crash, not a denied prompt.
3. The `healthkit` device capability, so the App Store does not offer the app
   to devices that cannot run it.

No `NSHealthUpdateUsageDescription` is declared, because the app never writes
to HealthKit. Requesting a permission it does not use would be asking under
false pretences.

### Permissions cannot be introspected

`authorizationStatus(for:)` **never reveals read permission.** Apple treats that
as privacy-sensitive: knowing a query returned nothing would leak that the user
has no data of that kind.

Consequences the code and copy both respect:

- `requestAuthorization` reports only that the sheet completed, never which
  types were granted.
- An empty result means "nothing to report" — **never** "the user said no".
- The UI says exactly this rather than implying certainty it cannot have.

### Types read

Workouts and routes; heart rate, resting heart rate, HRV; active energy,
distance, steps; body mass, height, VO₂max; running speed, power, stride
length, vertical oscillation, ground contact time (iOS 16+, each guarded
individually so older systems simply report fewer metrics); sleep analysis.

---

## Adding a provider

1. Implement `FitnessDataProvider` (`apps/api/src/providers/types.ts`).
2. Put endpoint constants in one `api.ts`, normalisation in `normalize.ts` —
   separated so normalisation is testable against fixtures and a fix can be
   replayed over retained raw payloads without re-fetching.
3. Register it in `providers/registry.ts`.

The sync engine, dedup pipeline and every screen need no changes.
