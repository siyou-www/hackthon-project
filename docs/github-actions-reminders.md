# GitHub Actions reminder scheduling (disabled by default)

`.github/workflows/daycast-reminders.yml` runs the existing one-shot worker on a
standard `ubuntu-latest` GitHub-hosted runner with Python 3.12. There is no web
service keep-alive dependency and no migration/deployment step in the workflow.
No GitHub settings, variables, Secrets or Environments were created by this change.

## Timing and delivery

The UTC schedule `2-57/5 * * * *` requests a run at minutes 02, 07, 12, …, 57.
The offset avoids the exact top of the hour, but does not reserve runner capacity.
GitHub scheduling, runner queues, Python setup, pip installation and a sleeping
database can delay the actual worker. Runs can also be dropped. This is a
hackathon schedule, not a precise delivery-time guarantee.

Worker catch-up grace is now 15 minutes. Its single deadline is the earlier of
`due_at + 15 minutes` and `starts_at`; equality is expired. Claiming, lease recovery,
retry eligibility, the locked pre-send check and final TTL use that deadline.
Immediately before the push call, the worker floors the remaining seconds for TTL;
if no whole second remains it marks the reminder missed instead of forcing TTL 1.
This does not weaken fencing, 90-second leases, cancellation or the three-attempt
limit. Accepted and uncertain sends remain terminal and are never automatically
retried. The committed send boundary still protects crash recovery.

A due reminder may be submitted about 15–30 minutes before its activity instead
of exactly 30 minutes before. Retries become eligible after 30/60 seconds but
usually execute on the next five-minute run, not after an in-process sleep.
Delayed runs can still exhaust the deadline before all attempts happen. Batches
remain limited to 20 and a soft 50-second worker budget; monitor backlog. The
worker does not intentionally start a push call after its deadline. Transport,
push-provider queues and OS behavior mean device display before activity start
cannot be guaranteed, even with a bounded TTL.

## Workflow trust boundaries

- Only `schedule` and `workflow_dispatch` are supported: no PR, push or
  `pull_request_target` trigger and no user-supplied command/ref inputs.
- The job requires the exact upstream repository and `refs/heads/main`. Automatic
  runs additionally require `vars.DAYCAST_REMINDERS_ENABLED == 'true'`. A manual
  main-branch run is explicit authorization to process real due reminders even
  with that flag false. Feature-branch/fork dispatches cannot run this job.
- Permissions are only `contents: read`; checkout uses the event's trusted main
  revision with `persist-credentials: false`. No write, OIDC or deployment token
  permission is requested.
- The global concurrency group serializes scheduled/manual runs with
  `cancel-in-progress: false`. PostgreSQL locks still protect against other
  schedulers. GitHub may replace an older queued run with a newer one; the workflow
  queue is not the durable reminder queue. Database rows are the durable queue.
- Jobs time out after five minutes. A timeout can leave a processing lease that a
  later run recovers safely; post-send uncertainty must never be retried manually
  by resetting database rows.
- Checkout is pinned to official `actions/checkout` v6.0.0 commit
  `1af3b93b6815bc44a9784bd300feb67ff0d1eeb3`; setup-python to official v6.0.0 commit
  `e797f83bcb11b83ae66e0230d6156d7c80228e7c`. These were fetched from the official
  repositories and their action metadata, credential-persistence and cache setup
  paths reviewed. Both use Node 24 on the standard runner. This is not a claim of
  an exhaustive action-source security audit. Review future SHA updates.
- The four application secrets appear only in the worker step's environment.
  Checkout, setup and dependency installation do not receive them. Pip cache is
  for dependencies only; there is no artifact upload or secret file generation.
  No capabilities are supplied to the workflow. Do not add environment dumps,
  shell tracing, verbose HTTP/SQL logging, or raw exception output. GitHub masking
  is supplemental protection, not permission to print secrets.

Protect main and require review of worker, workflow and dependency changes before
allowing access to the production environment. The existing requirements contain
version ranges; reviewing dependency changes and hash-locking dependencies are
additional supply-chain hardening for longer-term use. Never change this workflow
to check out untrusted PR code while holding production secrets.

## Controlled rollout — operator actions after separate approval

1. Review/merge PR #9 and this workflow into the default branch `main` when ready.
   A schedule on this unmerged feature branch does not activate cron. Keep all
   other reminder schedulers stopped to avoid unnecessary duplicate work.
2. Ensure migrations 001 and 002 are already applied through the approved
   migration process. Do not add them to Actions. Use a dedicated worker database
   role with schema usage, reminder SELECT/UPDATE and subscription SELECT/DELETE
   permissions needed for lookup and expired-subscription cascade. It should not
   have schema CREATE/ALTER privileges; missing schema should fail, not migrate.
3. Create/configure GitHub Environment **daycast-reminders** under repository
   Settings → Environments. Restrict deployment branches to **main only** before
   adding secrets. Required reviewers would pause every cron run; use main/code
   review protection for unattended operation, or deliberately require approvals.
   Environment protection availability depends on the repository plan.
4. Add these **Environment Secrets**, securely copying values from the approved
   configuration, never through code, PR text, logs, issues or artifacts:

   | Secret | Value |
   |---|---|
   | `PUSH_DATABASE_URL` | Dedicated worker PostgreSQL URL reachable from GitHub runners; use the provider's external TLS endpoint, e.g. Neon with `sslmode=require`, not Render-internal networking. |
   | `VAPID_PRIVATE_KEY` | Existing private VAPID key; keep it secret and keep the key pair stable. |
   | `VAPID_PUBLIC_KEY` | Matching public VAPID key. |
   | `VAPID_SUBJECT` | Existing real operator contact. |

   Verify the database/network policy permits the approved connection route.
   Standard runners do not provide a fixed outbound IP. Never disable TLS to make
   a connection succeed. Do not expose connection URLs in connection-test logs.
5. Leave the **repository Actions variable** `DAYCAST_REMINDERS_ENABLED` unset or
   explicitly `false` (false is safest if an organization variable exists). This
   is a repository-level variable, not an Environment variable: the job condition
   is evaluated before environment execution. Do not put secret values in variables.
6. For an authorized real test, go to **Actions → DayCast reminder worker → Run
   workflow → main**. This manual run works while automatic scheduling is off.
   Check the **Process due reminders** log for aggregate JSON counts such as
   `sent`, `retry`, `missed`, `failed`, `uncertain`, `expired` and `recovered`.
   A green run may contain nonfatal failed/uncertain outcomes. Fatal configuration
   errors return a generic message and exit code 1. No secret-bearing diagnostic
   output or artifact is needed. Verify real iPhone/Android delivery separately.
7. Only after that review, set repository variable `DAYCAST_REMINDERS_ENABLED` to
   exactly `true` to opt into cron. This implementation did not set that variable
   or run workflow_dispatch. Monitor actual job times, outcome counts and backlog.

## Costs, limits and shutdown

There are nominally 288 scheduled requests per day. Public repositories generally
receive free standard hosted runners; private repositories consume their plan's
included minutes and may incur charges when exceeded. Confirm repository visibility,
Actions eligibility, budgets, cache limits and current GitHub/Neon terms before
activation. The workflow cannot guarantee zero cost for every repository plan.
Long inactive public repositories can have schedules disabled automatically.

After the hackathon:

1. Set `DAYCAST_REMINDERS_ENABLED` to `false` to skip future automatic jobs. Manual
   runs remain possible and can send real notifications.
2. For a complete stop, use **Actions → DayCast reminder worker → … → Disable
   workflow**, then cancel queued/in-progress runs. Already accepted pushes cannot
   be recalled. Ensure any alternate Render cron/other worker is also stopped.
3. Cancel unwanted future reminders through the existing capability-protected UI
   or APIs and tell demo users scheduling has ended. Re-enabling later will mark
   overdue reminders missed, not send an unlimited historical backlog.
4. Remove the Environment's worker secrets if retiring Actions permanently. Do not
   rotate/delete shared Render VAPID settings merely to stop this scheduler: that
   would affect manual push and existing subscriptions. No shutdown action was
   performed as part of this change.

## Local validation

Backend tests exercise delayed runs, the activity-start cutoff, final pre-send
expiry, rounded-down TTL, five-minute retries, accepted/uncertain duplicate
prevention, cancellation, fencing and PostgreSQL concurrent execution. Workflow
security tests check trigger/branch gates, secret scope, SHA pins and permissions.
The YAML was also checked with actionlint. Frontend tests/build/lint and worker
handler tests remain regression requirements. None of these checks enables Actions
or connects to production Neon; PostgreSQL tests use the guarded loopback database.
