# Automatic activity reminder worker — Phase 2

This extends Phase 1 persistence with an independent, one-shot Python worker:

```bash
python -m reminder_worker --limit 20
```

Run from repository root after installing `requirements.txt`. This imports shared
weather/advice code, not `main.py`; it does not start FastAPI, initialize task
SQLite, or call the Render web service. Production CLI execution requires
PostgreSQL. A cron job can execute it with the web service fully asleep.

## Delivery policy

Each run validates VAPID configuration, recovers expired processing leases, and
claims due `pending`/`retry` reminders with PostgreSQL `FOR UPDATE SKIP LOCKED`.
It claims one item at a time, with a random lease token, 90-second lease, and an
incremented attempt count. Lease-token predicates fence out stale workers; DB
transactions are short and no network request holds database row locks. Default
limits are 20 items and a soft 50-second budget checked between items; individual
network calls can extend the run. Overlapping cron runs are safe.

The catch-up window ends 15 minutes after the scheduled reminder due time (or
at activity start if earlier);
reminders are never intentionally sent after the activity starts. Old due items
are marked `missed`. Each eligible attempt fetches fresh Open-Meteo data explicitly
in the saved IANA timezone, matches the activity's local hour, and combines
existing weather advice with Personal Comfort advice. This also handles locations
with half-hour UTC offsets. Existing HTTP APIs retain `timezone=auto` by default.
No UV advice is requested or added.

Immediately before sending, the worker locks subscription then reminder, checks
ownership, lease expiry, cancellation and deadline again, and commits
`push_started_at`. Once this boundary commits, the reminder is no longer
cancellable. An earlier cancellation during weather fetching succeeds and blocks
the send. Deleting a subscription before this boundary also blocks sending.
Cancellation/unsubscription cannot retract a request already handed to a provider;
there is an unavoidable small race after the final eligibility check.

- Provider 2xx acceptance → `sent`, with `sent_at`; never automatically retried.
- Weather/missing-hour failures → bounded `retry`, then `failed` after 3 attempts.
- Explicit provider 429/503 responses → bounded retry, using at least the numeric
  `Retry-After` delay where supplied. Backoff is 30 then 60 seconds; a retry that
  cannot fit inside the catch-up window is marked `missed`.
- Provider 400/401/403/413 → `failed`, without automatic retry.
- Provider 404/410 → remove the expired subscription and cascade-delete its
  reminders, preserving the established expired-subscription behavior.
- Connection loss, timeout, unexpected/ambiguous push responses → `uncertain`,
  never automatically retried. Do not infer failure from a lost response.
- Expired lease **before** the committed send boundary → retry if attempts/time
  remain; otherwise `failed`/`missed`.
- Expired lease **after** the send boundary → `uncertain`, never retried. This
  includes a crash just before the request, after provider acceptance, or before
  recording `sent` successfully.

This intentionally prefers avoiding duplicate sends over guaranteeing a send.
Exactly-once end-to-end Web Push is unavailable: some uncertain reminders may
never have reached the provider. Neither an ambiguous send nor a crash can safely
be retried without risking duplicates. Notification/provider acceptance also does
not prove that a device displayed the message.

Each message includes a unique `daycast-reminder-<UUID>` notification tag and a
stable 32-character Web Push Topic. With the separately approved minimal worker
handler change, displayed notifications use this tag. Manual test payloads still
fall back to `daycast-test`. Manual test routes and their 60-second cooldown are
unchanged; scheduled delivery does not consume/reset the manual test timestamp.

The command prints only aggregate outcome counts. Fatal errors return exit code 1
with a generic message and no traceback. Error codes persisted to PostgreSQL are
fixed labels, never exception messages. It never logs endpoints, subscription
keys, capability tokens, VAPID values, activity titles, or coordinates. Do not turn
on HTTP/SQL debug logging in deployment. Nonfatal failed/uncertain reminders appear
in aggregate counts; monitor them rather than relying only on cron exit status.

## Migration and deployment requirements (not performed here)

1. Apply `001_activity_reminders.sql` if Phase 1 has not yet been installed, then
   apply `migrations/002_reminder_worker_leases.sql` before running the new API or
   worker. Migration 002 adds nullable `lease_token` and `push_started_at` columns.
   SQLAlchemy `create_all` does not alter existing tables. Apply migrations during
   a controlled rollout with the future worker stopped; do not mix worker schema
   versions. Lease tokens/send-boundary fields are not exposed by reminder APIs.
2. Give the worker the existing `PUSH_DATABASE_URL`, `VAPID_PRIVATE_KEY`,
   `VAPID_PUBLIC_KEY`, and `VAPID_SUBJECT` through the platform's secret settings.
   No subscription capability tokens or frontend secrets are required. Keep the
   VAPID pair stable across deployments. No new environment variable is required.
3. Provision an external scheduled process, for example a **Render Cron Job**
   using the same repository/branch and dependency install step. Set its command
   to `python -m reminder_worker --limit 20` and schedule `* * * * *` (every minute).
   Share the persistent PostgreSQL database and its TLS/network requirements.
   This costs cron compute plus persistent database service; verify current
   provider prices and quotas before enabling. It does not require a paid,
   always-running web process. No cron service was created by this change.
4. Allow HTTPS egress to `api.open-meteo.com` and the existing approved browser
   push providers. Monitor job failures, failed/uncertain counts, and backlog.
   For more than 20 due activities per minute, revisit batch/runtime limits and
   capacity. A one-minute scheduler has normal timing jitter, not exact delivery.
5. Deploy the approved service worker handler change when ready. Existing Home
   Screen apps must close/reopen so the waiting worker activates; older workers
   still display pushes but use the old shared test tag. No React UI was changed.
6. Verify opt-in reminders with iPhone Home Screen PWA on iOS 16.4+ and Android,
   including closed-app display, cancellation, notification click, and expired
   subscriptions. Physical device delivery is not established by mocked tests.

PR #9 remains unmerged. This implementation has not been deployed and no existing
production environment variables, Neon data, or schedules were changed. The [Phase 3 frontend](reminder-frontend.md) now provides opt-in, restoration and
cancellation controls using the existing capability-protected CRUD APIs.

## Tests and safe local PostgreSQL

```bash
python -m pytest -q
```

Default tests use disposable SQLite for unit tests and skip PostgreSQL-only
locking checks. Run the full regression suite with an isolated local database:

```bash
PUSH_TEST_DATABASE_URL='postgresql+psycopg://<local-test-credentials>@127.0.0.1:55432/daycast_worker_test' \
  python -m pytest -q
```

The test guard refuses remote database URLs and any PostgreSQL test database not
named `daycast_worker_test` on loopback. Test setup overrides runtime push database
configuration, so tests do not use production `PUSH_DATABASE_URL`/Neon. Tests drop
tables: use a disposable local PostgreSQL instance only. Weather and push delivery
are mocked, including simulated acceptance followed by a database failure. No
real test notifications are sent.

## GitHub Actions scheduling

A disabled-by-default five-minute GitHub Actions workflow is now included. See
[Actions rollout, secrets, manual runs and shutdown](github-actions-reminders.md).
It is an alternative to the optional Render Cron setup above, not an additional
scheduler to run simultaneously. The worker uses a 15-minute catch-up grace with
a centralized activity-start cutoff and final TTL check.
