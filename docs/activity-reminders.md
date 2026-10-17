# Activity reminder persistence — Phase 1

This phase stores explicitly requested reminder schedules only. There is no cron
worker, frontend change, push delivery, deployment, or new environment variable.
Existing manual Web Push, weather, Personal Comfort, Daily Plan, and task SQLite
contracts are preserved.

## API

All three routes require `Authorization: Bearer <existing subscription capability>`.
Authorization is scoped to the subscription ID in the URL, using the existing
hashed capability. Reminder rows store no capabilities or browser push keys.

- `PUT /api/push/subscriptions/{id}/reminders/{activity_id}` saves a pending reminder
  and returns 200 with its representation. Both path IDs must be UUIDs. Keep a
  stable, client-generated activity UUID for retries/edits. Example JSON body:

```json
{
  "time": "2030-01-02T14:00",
  "timezone": "America/Los_Angeles",
  "title": "Basketball",
  "outdoor": true,
  "latitude": 34.0522,
  "longitude": -118.2437,
  "preference": "heat_sensitive"
}
```

This is example schedule data. `time` must be a valid local hourly timestamp in
exact `YYYY-MM-DDTHH:00` format, matching the current weather timeline. `timezone`
is an IANA timezone name. DST gaps and repeated/ambiguous hours are rejected,
not guessed. Coordinates must be finite and in latitude/longitude range.
`preference` accepts `normal` (default), `cold_sensitive`, or `heat_sensitive`.
`outdoor` must be a JSON boolean, and the trimmed title must be nonblank and no
longer than 200 characters. Unknown fields are rejected.

New schedules and changed schedules require a start at least 30 minutes after
server UTC time. Due time is calculated by the server as start minus 30 minutes.
No client-supplied due time or status is accepted. This persistence-only phase
makes no forecast/network request and does not verify that the supplied timezone
matches the coordinates or enforce a forecast horizon. Use the weather API's
returned timezone; weather availability will be checked by a future worker.

An identical PUT is a no-op: ID, creation/update timestamps and scheduling state
are unchanged. This allows retrying an accepted save even after the lead window
has passed. A changed PUT edits only a `pending` reminder, preserving its ID.
The unique key `(subscription_id, activity_id)` prevents duplicate rows; PostgreSQL
parent-row locks serialize saves/cancellation with subscription deletion.

The response includes `id`, `subscription_id`, `activity_id`, the activity snapshot,
`starts_at`, `due_at`, `status`, `attempt_count`, `next_attempt_at`, `lease_until`,
`last_attempt_at`, `sent_at`, `cancelled_at`, `last_error_code`, `created_at`, and
`updated_at`. Datetimes use UTC ISO 8601 strings ending in `Z`; unavailable values
are null. For the example, `starts_at` is `2030-01-02T22:00:00Z` and `due_at` is
`2030-01-02T21:30:00Z`. Initially status is `pending`, attempt count is zero, and
next attempt is the due time. This does not cause any notification to be sent.

- `GET /api/push/subscriptions/{id}/reminders` returns
  `{"reminders": [...]}` sorted by start time and ID, including cancelled/history
  rows. An authorized subscription with no reminders receives an empty array.
- `DELETE /api/push/subscriptions/{id}/reminders/{activity_id}` cancels a `pending`
  or future `retry` reminder and returns its representation. The row is retained
  as a tombstone; repeated DELETE returns the same cancelled row. Unknown reminder
  IDs return 404. Sent, processing, and other final states return 409 on DELETE.

PUT returns 409 for any non-pending row, including an identical retry against a
cancelled or sent reminder. A new explicit reminder after cancellation requires a
new activity UUID. No request can reset a sent/cancelled reminder to pending.
Supported future worker states are `processing`, `retry`, `sent`, `missed`,
`failed`, and `uncertain`; these APIs do not create those states. Status/retry/lease
fields are reserved for future worker code.

Missing/wrong/cross-subscription capabilities return 403; invalid fields and
insufficient lead time return 422. Database failures use existing generic 503
responses. Existing subscription DELETE and expired-subscription cleanup remove
all child reminders through a database `ON DELETE CASCADE` foreign key.

## PostgreSQL migration

The existing `PUSH_DATABASE_URL` and persistent PostgreSQL database are reused.
No new secrets or production variable changes are necessary.

Before enabling the new routes in a deployment, apply
`migrations/001_activity_reminders.sql` to that database using the operator's
normal migration tooling. `push_subscriptions` must already exist. The migration
adds only the reminder table, checks, unique key, cascade, and due/lease indexes;
it does not change or delete existing subscription or task data. It is wrapped in
a transaction and can be reapplied using IF NOT EXISTS. This is not a migration
framework or a repair for an incompatible preexisting reminder schema.

The existing SQLAlchemy initialization also creates missing tables if its role
has CREATE permission. Explicit migration is recommended for controlled rollout;
use a migration role if the runtime role lacks schema privileges. No migration
has been applied to production as part of this change.

Activity/due/retry/lease timestamps are PostgreSQL TIMESTAMPTZ. The local IANA name
is retained separately. SQLite is still local-test-only for push data and enables
foreign-key enforcement to exercise the same deletion behavior. Task SQLite is
untouched.

## Tests

```bash
python -m pytest -q
```

To run reminder and manual push tests on a **disposable** PostgreSQL database:

```bash
PUSH_TEST_DATABASE_URL='<disposable PostgreSQL URL>' \
  python -m pytest tests/test_reminders.py tests/test_push.py -q
```

The existing test setup creates/drops tables. Never target a production database.
Delivery is mocked; reminder CRUD does not call the push sender at all.
