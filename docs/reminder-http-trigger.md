# Optional external HTTP scheduler

`POST /api/internal/run-reminders` runs the existing one-shot worker synchronously
in FastAPI's thread pool. No body or query parameters are needed. Authenticate
with `Authorization: Bearer <REMINDER_CRON_SECRET>` over HTTPS. GET and other
methods cannot execute the worker. The route is omitted from public OpenAPI.

Generate a dedicated secret with Python `secrets.token_urlsafe(32)` in a trusted
local environment. Store it only in Render's secret environment configuration and
the scheduler's protected request-header configuration. Accepted configuration is
43–128 URL-safe characters with at least 16 distinct characters; use cryptographic
generation, not a password. Missing/weak configuration disables execution (503).
Missing/incorrect authorization returns 401 before any database or worker access.
Never put the secret in a URL, repository, frontend, screenshot, or request logs.
Disable scheduler request-header logging and restrict scheduler/admin access.
Rotate the secret on both services if exposed. No application code logs headers
or raw exceptions; ensure infrastructure/APM likewise redacts Authorization.

The existing `PUSH_DATABASE_URL` must point to PostgreSQL with the existing reminder
schema, and existing `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, and `VAPID_SUBJECT`
must be configured. No new schema migration is required. This adapter does not
change row locking, leases, cancellation, deadlines, retries, accepted/uncertain
delivery handling, or notification content. It adds no scheduler or background
process. Defaults remain 20 reminders and a 50-second between-item time budget;
a slow in-progress operation can exceed that budget.

Success example: `{"outcomes":{"recovered":0,"sent":1}}`. Counts vary by execution;
only known nonnegative integer outcome counters are exposed. Configuration/database/
worker failures return a generic 503 without exception details. A partial run may
already have delivered notifications: a retry uses the worker's existing persistent
deduplication rather than assuming no work occurred. A caller timeout/disconnect
does not guarantee execution stopped. Authorized concurrent calls retain existing
database safeguards but can consume Render threads; keep the secret private and
avoid overlapping scheduler requests.

## Deployment steps (not performed by this change)

1. Review/merge and deploy through the normal approved process.
2. Set the dedicated secret securely; verify existing database/schema/VAPID setup.
3. Configure a trusted scheduler (e.g. cron-job.org) to POST over HTTPS every five
   minutes, using the protected Authorization header, no body, and a timeout long
   enough for Render cold start plus worker execution. Verify the provider's
   current timeout/security limits first. Do not paste a real secret in shell
   history, scheduler URLs, or logs.
4. Check status codes and aggregate counts. Render Free cold starts, external
   scheduler delays/timeouts, and downtime can still miss the existing 15-minute
   catch-up deadline; delivery is not guaranteed. This trigger wakes the web
   service instead of requiring an always-running web process.
5. Prefer one scheduling source to limit load. The existing GitHub Actions workflow
   remains unchanged; disabling/enabling a scheduler is a separate operator action.
6. To shut down, disable the external job and unset/rotate this secret. Manual push
   tests and the standalone worker continue unchanged. Check current free-tier
   scheduler limits and Render/Neon quotas; no paid services are provisioned here.

Tests mock engine acquisition and delivery. Run `python -m pytest -q` for backend
regression coverage; no production database is needed.
