# Activity reminder frontend — Phase 3

The existing hourly activity editor now supports an optional **Remind me 30
minutes before** checkbox. New activities start unchecked. Merely viewing weather,
creating an ordinary activity, or restoring the page never registers a reminder
or prompts for notification permission.

## Opt-in, edits, and cancellation

1. Install/open the iPhone Home Screen PWA (iOS 16.4+) or a supported Android
   browser/PWA. Use **Enable Notifications** first and grant permission.
2. Click a weather hour, enter the activity, optionally choose outdoor status,
   and check the reminder box. Review the displayed location-local timestamp,
   timezone, and reminder temperature preference before saving.
3. Save sends the activity snapshot to the existing capability-protected PUT API.
   UI success is shown only after the backend accepts it. The backend enforces
   the 30-minute lead, finite coordinates, supported preferences, valid IANA
   timezone, and DST gap/ambiguity checks. Validation errors are displayed without
   converting the local hour through the device's timezone.
4. Editing an existing **pending** reminder keeps its UUID and uses PUT. The box
   reflects its existing opt-in. Unchecking it and saving must first cancel the
   existing reminder successfully; failed cancellation leaves the saved activity
   and server reminder unchanged and retains the editor draft.
5. **Cancel reminder for …** in Saved activity reminders uses DELETE and displays
   the confirmed cancelled state. Retry/processing reminders cannot be edited;
   cancel first. A processing reminder can be cancelled only before the worker's
   committed send boundary. A 409 error after that boundary is displayed and
   status is refreshed; the UI does not promise to retract an accepted push.
6. Cancelled/sent/failed/missed/uncertain reminder records remain in history. Their
   UUIDs are never reactivated. A new opt-in from that hour creates a new activity
   UUID explicitly. There is no automatic retry of uncertain/sent notifications.

The existing single-activity-per-hour timeline is preserved. All subscription
reminders, including other days/locations, appear in Saved activity reminders.
The timeline and Daily Plan still target the existing Los Angeles coordinates;
only matching location snapshots are merged into activities. Daily Plan submits
activities for the currently displayed forecast hours, avoiding stale historical
activities after refresh. It keeps its existing global Personal Comfort preference;
reminders have their own explicitly saved preference. Changing the global Daily
Plan preference does not silently rewrite scheduled reminders.

## Persistence and synchronization

- Notifications is the shared provider for browser support, permission,
  subscription readiness, and the existing capability. It owns the only PWA
  registration flow; activity code does not create a second worker or request
  permission automatically.
- The existing capability stays under `daycast.push.capability.v1`. Reminder
  requests send it only in the Authorization header, never a URL, activity cache,
  draft, log, or notification payload. No private VAPID key reaches the frontend.
- `daycast.activities.v1` retains local activities and confirmed reminder snapshots
  on the device. `daycast.activity-draft.v1` retains a draft and its stable UUID
  **before PUT**, so a lost response or app restart cannot create a second reminder
  on retry. Neither contains capability tokens. Blocked storage prevents a new
  reminder save and produces an actionable error.
- GET restores reminders when the subscription is available, on window focus, and
  via **Refresh reminder status**. Server snapshots override stale linked cache
  values. UTC `starts_at` is formatted with its saved IANA timezone to restore the
  original local activity hour (never parsed as a device-local timestamp).
- PUT/DELETE failures do not optimistically overwrite the saved activity. The
  draft stays available by selecting the hour again. Conflicts refresh server
  state. Old GET responses are fenced out after writes or subscription changes.
  Daily Plan results are hidden if their activity/preference inputs change.
- Disabling Notifications deletes that subscription's reminders on the backend
  and updates the device cache. A newly registered subscription starts with its
  own reminder list; reminders are never silently copied between capabilities.
- Missing/denied/unsupported subscriptions explain how to enable notifications,
  install the iPhone PWA, or recover subscription access. A retained capability
  can still list/cancel reminders even if browser permission is denied. New
  scheduling requires a supported, granted, subscribed device and successful GET.
  If existing schedules cannot be restored, save is blocked until restoration so
  an unchecked box cannot silently leave an unknown remote reminder active.

Local-only activities depend on site storage; clearing it removes those activities
and drafts. Persisted reminders can be restored only with the original capability.
Losing that capability still requires the established browser subscription reset;
this phase adds no accounts, token recovery, or cross-device synchronization.

## Validation

Run from `frontend/` (validated with Node 24):

```bash
npm ci
npm test
npm run build
npm run lint
node --test tests/push-events.test.cjs
```

React integration tests use mocked weather, push, and reminder APIs and test
opt-in, stable edits, lost responses, refresh restoration, cancellation failures,
terminal states, authorization headers, denied/unsupported/missing subscriptions,
storage failure, stale responses, and existing Daily Plan/manual push behavior.
No test uses production Neon or sends a real notification. The existing
`tests/browser_notifications.py` also checks the production build with mocked
browser permissions/API responses. Physical iPhone/Android delivery still requires
manual verification after an authorized deployment.

## Rollout requirements (not performed here)

No backend API contract, database schema, environment variable, or worker command
changes are introduced in Phase 3. Deploy the complete PR #9 backend with migrations
001 and 002 applied to persistent PostgreSQL, configured VAPID values, and a
separate minute-by-minute worker job as documented in [Phase 2](reminder-worker.md).
Then build/deploy the frontend over HTTPS using the existing `VITE_API_BASE_URL`.
Close/reopen installed PWA windows to activate the updated cached shell. Creating
a reminder without the scheduled worker running stores a pending row but does
not itself send a notification. No deployment, merge, or production settings
change is part of this implementation.
