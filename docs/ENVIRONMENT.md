# Environment

All variables are documented in [`.env.example`](../.env.example). This page
covers what must be true for a deployment to be safe.

## The secret boundary

**Backend only.** These must never reach the app bundle:

```
STRAVA_CLIENT_SECRET   WHOOP_CLIENT_SECRET
DATABASE_URL           AUTH_JWT_SECRET
TOKEN_ENCRYPTION_KEY   AI_API_KEY
WHOOP_WEBHOOK_SECRET   STRAVA_WEBHOOK_VERIFY_TOKEN
```

**Anything prefixed `EXPO_PUBLIC_` is embedded in the app binary and is not a
secret.** Only `EXPO_PUBLIC_API_URL` is set, because a URL is safe to publish.
A client secret shipped in an app is extractable in minutes.

This is why OAuth token exchange happens on the server: the app receives an
authorization code via a system browser and never sees a client secret or a
provider credential.

## Generating secrets

```bash
openssl rand -hex 32   # AUTH_JWT_SECRET
openssl rand -hex 32   # TOKEN_ENCRYPTION_KEY (must be 64 hex chars)
```

`TOKEN_ENCRYPTION_KEY` encrypts provider OAuth tokens at rest with AES-256-GCM.
**Rotating it makes existing stored tokens undecryptable** and every athlete
must reconnect their providers. Treat it as long-lived.

## Production refuses unsafe defaults

`loadEnv()` throws at boot in production without `AUTH_JWT_SECRET` (≥32 chars),
`TOKEN_ENCRYPTION_KEY` (≥64 hex chars) and `DATABASE_URL`. Development
fallbacks exist so the app runs out of the box, and this check is what stops
them ever applying to real athlete data.

An unconfigured `WHOOP_WEBHOOK_SECRET` returns 503 in production rather than
accepting unverified payloads.

## Development vs production

| Variable | Development | Production |
|---|---|---|
| `DATABASE_URL` | empty → PGlite | required |
| `USE_MOCK_DATA` | `true` | `false` |
| `AUTH_JWT_SECRET` | derived fallback | required, 32+ chars |
| `TOKEN_ENCRYPTION_KEY` | derived fallback | required, 64 hex |
| `AI_API_KEY` | optional | optional |

`AI_API_KEY` is genuinely optional everywhere. Without it the coach answers
from the deterministic responder and says so in the UI. Training decisions
never depend on it.

## Logging

The logger deep-redacts any key matching
`token|secret|password|authorization|api[_-]?key|refresh|bearer|signature|cookie`
at every nesting level, including through cycles. This means spreading a
provider response into a log call cannot leak an access token.

`LOG_LEVEL` defaults to `info` (`error` under test).

## Deployment checklist

- [ ] `AUTH_JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` generated and stored in a
      secret manager, not in the repo
- [ ] `DATABASE_URL` points at Postgres with TLS
- [ ] `USE_MOCK_DATA=false`
- [ ] `API_PUBLIC_URL` set to the real host (OAuth redirects derive from it)
- [ ] Provider redirect URIs registered and matching exactly
- [ ] Webhook secrets set; subscriptions registered against the public URL
- [ ] `pnpm db:migrate` run
- [ ] `pnpm verify` green
- [ ] Backups configured — this is health data
