# First-launch notification onboarding

SkyCue offers an optional native modal dialog after the existing Web Push
subscription inspection completes. Eligibility requires HTTPS/Web Push support,
`default` system permission, no browser subscription or saved capability, and no
subscription-status error. iPhone/iPad also require installed standalone mode;
ordinary Safari tabs retain the existing installation instructions instead.
Granted or denied permissions never trigger first-launch onboarding.

Both Enable Notifications buttons call the same handler in `Notifications.jsx`.
The dialog invokes it directly from the user's click, preserving iOS's gesture
requirement. No permission request or subscription is created merely by opening
the dialog. Permission denial and registration/network failures appear inside
the dismissible dialog; the existing Notifications section remains available for
later recovery, test sends, and opt-out.

Not Now and Escape persist `skycue.notifications.onboarding.v1 = seen`. Clicking
Enable also remembers the attempt, so a failed request cannot cause repeated
onboarding after refresh. Existing activity/capability keys are unchanged. If
localStorage cannot be read, this optional prompt stays hidden; if a write fails,
dismissal lasts for the current mount only. Clearing site data or switching
browser profiles resets the preference. System notification settings are never
overridden. No new service worker, backend, scheduler, or VAPID configuration is
introduced.

The native `<dialog>` provides modal focus containment, Escape dismissal, and
focus restoration. Not Now receives initial focus; both actions have mobile-sized
targets. Automated React tests model native open/close in jsdom and cover initial
eligibility, user-triggered enable, persistent dismissal, subscription recovery,
granted/denied permission, unsupported browsers, iPhone standalone mode, and
registration failure. Existing reminder and forecast regression tests remain in
the suite. Run `npm test`, `npm run lint`, and `npm run build` in `frontend/`.
For native Chromium focus, keyboard navigation, Escape/reload persistence, and
eligibility checks, start `npm run preview`, then run from the repository root:
`python tests/browser_notification_onboarding.py --origin http://127.0.0.1:4173`.
This optional check requires Python Playwright and system Chromium; all API calls
are mocked. Use the preview server's actual port if 4173 is already occupied.

Physical iPhone Home Screen permission/delivery behavior should still be checked
after an independently approved deployment (iOS/iPadOS 16.4+). Automated browser
and React tests use mocked permissions/subscriptions and do not establish real
device push delivery. No production settings or deployment are part of this change.
