# DayCast Phase 1 Web Push

This phase adds explicit subscription opt-in and one-device test notifications.
It adds no scheduler, automatic weather alerts, broadcast API, or user accounts.
The weather, task SQLite, and Daily Plan APIs are unchanged.

## Render configuration

Install the updated `requirements.txt`. Keep the normal start command:

```bash
python -m uvicorn main:app --host 0.0.0.0 --port "$PORT"
```

Provision **persistent PostgreSQL**, for example a Render Postgres instance in the
same region as the backend. Choose a retained plan with backups suitable for your
needs; an expiring free database is not indefinite storage. Subscription storage
must survive web-service restarts/redeployments. Set these backend variables in
Render's secret environment settings (never Vercel frontend variables):

| Variable | Value |
|---|---|
| `PUSH_DATABASE_URL` | PostgreSQL connection URL, preferably Render's internal database URL. `postgres://`, `postgresql://`, and `postgresql+psycopg://` are accepted. For external databases use the provider's TLS settings, e.g. `?sslmode=require`. |
| `VAPID_PRIVATE_KEY` | Secret base64url P-256 private scalar (32 decoded bytes), not a PEM filename. |
| `VAPID_PUBLIC_KEY` | Matching base64url uncompressed P-256 public key (65 decoded bytes). This alone is public and returned by the API. |
| `VAPID_SUBJECT` | A real operator contact such as `mailto:operator@your-domain.com`. Use a valid mailto or public HTTPS contact; avoid localhost for Apple's service. |

Generate one stable key pair locally after installing backend dependencies:

```bash
python scripts/generate_vapid.py /secure/path/daycast-vapid.env
```

The command creates a new file with mode 0600 and prints no credentials. Move its
values into Render securely; do not commit the file, paste its contents in logs,
or put the private key into `VITE_*`. Keep the pair across redeployments. Rotating
VAPID keys requires users to disable/re-enable browser subscriptions.

The backend lazily creates `push_subscriptions` on first subscription access.
The database role initially needs CREATE TABLE privilege; it also needs
SELECT/INSERT/UPDATE/DELETE afterward. The table stores a random subscription ID,
endpoint hash, subscription JSON (endpoint + browser encryption keys), SHA-256
capability-token hash, and last-send timestamp. Protect database access and backups:
subscription endpoints and keys are sensitive. Do not enable HTTP body,
Authorization header, or database parameter logging. App code never logs provider
exceptions or subscription contents. Standard access logs contain only IDs/paths.

No subscription falls back to the existing `tasks.db`. Missing push configuration
returns 503 from push routes while existing APIs remain available. Set neither
`PUSH_ALLOW_SQLITE` nor a SQLite URL on Render; SQLite is explicitly refused there.
For **local development only**, `PUSH_ALLOW_SQLITE=1` plus a
`PUSH_DATABASE_URL=sqlite:////absolute/path/push-dev.db` is supported.

Allow outbound HTTPS to browser push services: Apple's `*.push.apple.com`,
`fcm.googleapis.com` (Android/Chrome), `updates.push.services.mozilla.com`
(Firefox), and `*.notify.windows.com` (Windows). Only these endpoint hosts are
accepted to prevent arbitrary server-side HTTP destinations. The sender runs in
a FastAPI thread with a 10-second HTTP timeout, and failed sends still consume
the rate limit. Render Free can sleep/cold-start; the first test may need a retry
after the backend wakes. A provider's acceptance is not a guarantee of device
delivery. No uptime/scheduling service is introduced.

## Vercel / service worker rollout

1. Deploy the backend feature with PostgreSQL and VAPID variables configured.
2. Deploy the frontend build (`npm ci && npm run build`, output `frontend/dist`).
   Set `VITE_API_BASE_URL=https://daycast-backend.onrender.com` **before building**.
   No frontend VAPID secret or build-time public key is needed; the public key is
   fetched from the backend.
3. Use HTTPS and the existing production origin
   `https://hackthon-project-virid.vercel.app`. CORS already allows it. Other
   preview domains need separate explicit CORS configuration; this feature does
   not broaden the allowlist.
4. The existing Workbox worker imports `/push-events.js`. There is only one worker
   registration at `/sw.js` with root scope; app-shell caching stays in place and
   API requests are not cached. For an already installed app, close **all** tabs
   and Home Screen windows and reopen so the waiting updated worker can activate.
5. On iOS/iPadOS **16.4+**, open the site in Safari → Share → Add to Home Screen,
   then launch its Home Screen icon. A regular Safari tab is not enough. Tap
   **Enable Notifications** in the installed app and grant permission. No
   permission prompt runs automatically on page load. Android Chrome can use the
   installed PWA or supported HTTPS browser context.
6. Tap **Send Test Notification**. Success means the push provider accepted it;
   look for a system notification. To test closed-app behavior, close DayCast
   after enabling, then use the saved capability with the test API below from a
   trusted local client (or tap test then promptly close the app). iOS Focus,
   disabled system notifications, network state, and OS policies can delay/suppress
   display. Tapping the notification focuses an existing DayCast window or opens
   `/`; payloads cannot choose an external click URL.

When the app is closed, the push service wakes its worker; the backend does not
need the frontend tab to remain open. The test API still needs a running backend
for the initial send. Device/closed-app delivery must be verified after deployment;
headless mocked checks cannot prove Apple/Google delivery.

## API contract and abuse protection

All paths below are under `/api/push`:

- `GET /public-key` → `{"public_key":"<public VAPID key>"}`.
- `POST /subscriptions` with
  `{"subscription":{"endpoint":"<browser HTTPS endpoint>","expirationTime":null,"keys":{"p256dh":"<browser key>","auth":"<browser auth>"}}}`
  → 201 `{"id":"<UUID>","token":"<unguessable capability>"}`.
  Browser key encodings/lengths, P-256 points, endpoint hosts, and sizes are
  validated. An existing endpoint requires its current `token` in the JSON body
  to update; unauthenticated duplicate registration returns 409 and cannot rotate
  its token or reset its rate limit.
- `POST /subscriptions/{id}/test`, header `Authorization: Bearer <token>` →
  `{"status":"accepted"}`. Sends only a fixed DayCast test message to that
  subscription, never to an endpoint supplied in the send request.
- `DELETE /subscriptions/{id}`, same Authorization header →
  `{"status":"unregistered"}`. The frontend also calls PushManager.unsubscribe().

Capability tokens are generated with 256 bits of randomness and stored only as
hashes server-side. The frontend stores its capability in localStorage, never in
URLs or logs. Treat it as a device-level credential; protect against XSS. There
is no account identity or cross-device subscription management in this phase.
Do not put tokens in shell history or query strings. A trusted test client can
POST to the test route with the Authorization header using its securely supplied
capability; no public broadcast endpoint exists.

Missing/wrong capability returns 403. A database-atomic timestamp claim enforces
one test per subscription per 60 seconds across workers/restarts (429 with
Retry-After). Re-registration with the same capability does not reset it. Provider
404/410 deletes the expired record and returns 410; other delivery failures return
502 without exposing provider details. Bad input returns 422; missing config or
unavailable DB returns 503. Each failed attempt also consumes the cooldown.

**Disable Notifications** removes the server record and browser subscription.
If localStorage was cleared or a record expired, use **Reset Browser Subscription**
and enable again to get a new capability. Lost capabilities cannot recover old
server records; old browser endpoints become invalid and are removed if delivery
is ever attempted. There is no automatic renewal or cleanup scheduler yet. Browser
permission changes are refreshed on window focus. If permission is denied, change
it in browser settings or iPhone Settings → Notifications → DayCast and reopen.

The per-subscription limit is intentionally MVP scope: it is not a global traffic
quota, IP-based signup protection, or a replacement for infrastructure-level
request limits. Add platform/WAF quotas before high-volume public rollout.

## Validation

```bash
python -m pip install -r requirements.txt pytest
python -m pytest -q
cd frontend
npm ci
npm run build
npm run lint
node --test tests/push-events.test.cjs
```

Optional browser smoke checks (mocks only, requires Python `playwright` plus
`/usr/bin/chromium`): run `npm run preview -- --host 127.0.0.1 --port 4173`, then
from repository root run `python tests/browser_notifications.py`.

Push tests use disposable local SQLite by default. To repeat them against a
**disposable PostgreSQL test database**, set `PUSH_TEST_DATABASE_URL` and run
`python -m pytest tests/test_push.py -q`. These tests create/drop the push table;
**never point this variable at a production database**. Network delivery is mocked,
including a check of real pywebpush encryption/signing with only HTTP mocked.

Before release, manually verify permission grant/denial, subscription persistence
through a Render redeploy, a real notification with the iPhone app closed,
notification tap behavior, Android delivery, cooldown, and opt-out. None of those
real-provider/device outcomes can be inferred from mocked tests alone.
