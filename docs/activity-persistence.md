# Activity persistence investigation

On main (`93cd690`), `App.jsx` lazily reads `daycast.activities.v1` through
`activityStorage.js`. Saving synchronously writes the new activity before setting
React state. A separate effect persists the reminder-overlay view. Reminder
restoration does not delete ordinary activities. StrictMode save/remount tests,
including an empty reminder response, found no stale-state overwrite. This code
even writes an empty object on mount, so a completely absent key is inconsistent
with that release running with working localStorage.

The historical PWA release `59f159bddb58d814aa7f514eca9cdcd83b3eda4c`
stores activities only in React state. Its production build reproduces both
reported symptoms: saving never creates the key, and refresh loses activities.
The PWA used prompt-mode updates without any update prompt UI: new service
workers wait while old clients remain open, and refresh keeps serving the old
cached shell. A real Chromium upgrade test reproduced this problem; it failed
before the fix because the updated worker never took control.

The minimal change enables Workbox `skipWaiting` and `clientsClaim`, retaining
the existing registration and avoiding an automatic page reload. The next user
refresh gets the current application. The browser test checks that updating
does not discard the current editor, then verifies saving and another reload
retain the activity and UUID. No storage keys, subscriptions, or capabilities
are cleared. Activities already lost from a memory-only release cannot be recovered.

## Reproduce

Run `npm test`, `npm run lint`, `npm run build`, and
`node --test tests/push-events.test.cjs` inside `frontend/`.
The optional browser test requires Python Playwright and `/usr/bin/chromium`.
From the repository root, build the historical frontend in a temporary directory:

```sh
old_release=$(mktemp -d)
git archive 59f159bddb58d814aa7f514eca9cdcd83b3eda4c frontend | tar -x -C "$old_release"
(cd "$old_release/frontend" && npm ci && npm run build)
python tests/browser_activity_persistence.py --previous-dist "$old_release/frontend/dist"
```

It serves both builds on loopback and mocks all weather API requests; it never
connects to Neon or sends notifications. Existing React tests cover opt-in,
restore, cancellation, authorization failures, and stable reminder UUIDs.

## Production verification still required

The environment proxy rejected the deployed URL with `CONNECT tunnel failed,
response 403` and the GitHub deployment API with `Forbidden`. Therefore the
actual production bundle/deployment revision was not verified. A stale cached
release is a reproduced explanation, not a confirmed inspection of that browser.
Confirm Vercel's production commit includes the persistence implementation; an
older deployed build also needs the correct release, not just a cache refresh.

After an independently approved deployment, verify the updated worker is active,
refresh, save an activity, inspect the storage key, and refresh again. Check a
pending reminder and an ordinary activity separately. Until then, closing every
DayCast tab/PWA window allows a waiting update to activate, provided the deployed
release already contains persistence. No deployment, environment changes,
database migration, or worker scheduling changes are part of this fix.
