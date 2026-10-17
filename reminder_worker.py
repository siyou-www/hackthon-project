"""One-shot reminder worker. Run: python -m reminder_worker --limit 20."""
import argparse
import asyncio
import base64
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, select, update

from comfort import get_comfort
from push_notifications import get_engine, reminders, subscriptions, vapid_config
from weather_service import activity_advice, fetch_weather

UTC = timezone.utc
LEASE_SECONDS = 90
GRACE_SECONDS = 900
MAX_ATTEMPTS = 3


def utc_now():
    return datetime.now(UTC)


def aware(value):
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def send_deadline(row):
    return min(aware(row['due_at']) + timedelta(seconds=GRACE_SECONDS), aware(row['starts_at']))


def expired(row, now):
    return now >= send_deadline(row)


def owned(row, token):
    return row and row['status'] == 'processing' and row['lease_token'] == token


def finish(engine, row, status, code=None, next_attempt=None):
    """Fenced updates cannot overwrite cancellation or a newer worker's claim."""
    with engine.begin() as connection:
        return connection.execute(update(reminders).where(
            reminders.c.id == row['id'], reminders.c.status == 'processing',
            reminders.c.lease_token == row['lease_token'],
        ).values(status=status, last_error_code=code, next_attempt_at=next_attempt,
                 lease_until=None, lease_token=None, updated_at=utc_now(),
                 **({'sent_at': utc_now()} if status == 'sent' else {}),
                 **({'push_started_at': None} if status == 'retry' else {}))).rowcount


def retry(engine, row, code, retry_after=None):
    now = utc_now()
    if expired(row, now):
        finish(engine, row, 'missed', code)
        return 'missed'
    delay = 30 * 2 ** (row['attempt_count'] - 1)
    if retry_after is not None:
        delay = max(delay, retry_after)
    next_attempt = now + timedelta(seconds=delay)
    if row['attempt_count'] >= MAX_ATTEMPTS:
        finish(engine, row, 'failed', code)
        return 'failed'
    if next_attempt >= send_deadline(row):
        finish(engine, row, 'missed', code)
        return 'missed'
    finish(engine, row, 'retry', code, next_attempt)
    return 'retry'


def recover_leases(engine, limit=100):
    now = utc_now()
    with engine.begin() as connection:
        rows = connection.execute(select(reminders).where(
            reminders.c.status == 'processing', reminders.c.lease_until <= now,
        ).order_by(reminders.c.lease_until).limit(limit).with_for_update(skip_locked=True)).mappings().all()
        for row in rows:
            if row['push_started_at'] is not None:
                status, code = 'uncertain', 'send_outcome_unknown'
            elif expired(row, now):
                status, code = 'missed', 'lease_expired_after_window'
            elif row['attempt_count'] >= MAX_ATTEMPTS:
                status, code = 'failed', 'lease_attempts_exhausted'
            else:
                status, code = 'retry', 'lease_expired_before_send'
            connection.execute(update(reminders).where(reminders.c.id == row['id']).values(
                status=status, last_error_code=code, next_attempt_at=now if status == 'retry' else None,
                lease_until=None, lease_token=None, updated_at=now))
    return len(rows)


def claim_one(engine):
    now = utc_now()
    with engine.begin() as connection:
        row = connection.execute(select(reminders).where(
            reminders.c.status.in_(['pending', 'retry']), reminders.c.due_at <= now,
            reminders.c.next_attempt_at <= now,
        ).order_by(reminders.c.next_attempt_at, reminders.c.id).limit(1)
          .with_for_update(skip_locked=True)).mappings().first()
        if row is None:
            return None
        row = dict(row)
        if expired(row, now) or row['attempt_count'] >= MAX_ATTEMPTS:
            status = 'missed' if expired(row, now) else 'failed'
            connection.execute(update(reminders).where(reminders.c.id == row['id']).values(
                status=status, next_attempt_at=None, updated_at=now, last_error_code='not_eligible'))
            return {'outcome': status}
        token = str(uuid4())
        row.update(status='processing', lease_token=token,
                   lease_until=now + timedelta(seconds=LEASE_SECONDS),
                   last_attempt_at=now, attempt_count=row['attempt_count'] + 1,
                   next_attempt_at=None, push_started_at=None, last_error_code=None)
        connection.execute(update(reminders).where(reminders.c.id == row['id']).values(
            **{key: row[key] for key in ('status', 'lease_token', 'lease_until', 'last_attempt_at',
                                        'attempt_count', 'next_attempt_at', 'push_started_at', 'last_error_code')},
            updated_at=now))
        return row


def message_for(row):
    forecast = asyncio.run(fetch_weather(row['latitude'], row['longitude'], forecast_timezone=row['timezone']))
    local_time = aware(row['starts_at']).astimezone(ZoneInfo(row['timezone']))
    hour = next((hour for hour in forecast['hourly'] if hour['time'] == local_time.strftime('%Y-%m-%dT%H:%M')), None)
    if hour is None:
        raise ValueError('forecast_hour_missing')
    advice = activity_advice(SimpleNamespace(outdoor=row['outdoor']), hour)
    comfort = get_comfort(hour['temperature_c'], row['preference'], row['outdoor'])
    return {
        'title': f"DayCast: {row['title']}"[:100],
        'body': (f"Starts at {local_time:%H:%M} ({row['timezone']}). "
                 f"{hour['temperature_c']}°C; rain {hour['precipitation_probability']}%. "
                 + ' '.join(advice) + ' ' + comfort['advice'])[:500],
        'tag': f"daycast-reminder-{row['id']}",
    }


def prepare_send(engine, claim):
    """Commit the irreversible send boundary after a final cancellation/lease check.

    Crash after this commit => uncertain, never an automatic second send. Locks
    follow the CRUD API's parent-then-child order; network calls hold no DB locks.
    """
    with engine.begin() as connection:
        subscription = connection.execute(select(subscriptions).where(
            subscriptions.c.id == claim['subscription_id']).with_for_update()).mappings().first()
        row = connection.execute(select(reminders).where(
            reminders.c.id == claim['id']).with_for_update()).mappings().first()
        now = utc_now()  # Lock acquisition can take time; do not reuse an earlier timestamp.
        if not subscription or not owned(row, claim['lease_token']) or aware(row['lease_until']) <= now:
            return None
        if expired(row, now):
            connection.execute(update(reminders).where(reminders.c.id == row['id']).values(
                status='missed', lease_token=None, lease_until=None, next_attempt_at=None,
                updated_at=now, last_error_code='window_elapsed_during_weather'))
            return None
        connection.execute(update(reminders).where(reminders.c.id == row['id']).values(
            push_started_at=now, updated_at=now))
        return json.loads(subscription['subscription'])


def process(engine, row, vapid):
    try:
        message = message_for(row)
    except (HTTPException, ValueError, KeyError):
        return retry(engine, row, 'weather_unavailable')
    except Exception:
        finish(engine, row, 'failed', 'advice_failed')
        return 'failed'
    subscription = prepare_send(engine, row)
    if subscription is None:
        return 'skipped'
    private, _, subject = vapid
    # Topic is a stable <=32-character base64url provider-side coalescing key.
    topic = base64.urlsafe_b64encode(hashlib.sha256(row['id'].encode()).digest()[:24]).decode().rstrip('=')
    # Recheck after the committed send boundary, directly before calling the provider.
    ttl = int((send_deadline(row) - utc_now()).total_seconds())
    if ttl <= 0:
        finish(engine, row, 'missed', 'window_elapsed_before_push')
        return 'missed'
    try:
        response = webpush(subscription_info=subscription, data=json.dumps(message),
                           vapid_private_key=private, vapid_claims={'sub': subject},
                           ttl=ttl,
                           timeout=10, headers={'Topic': topic})
        status = response.status_code
    except WebPushException as error:
        response = error.response
        status = response.status_code if response is not None else None
    except Exception:
        # Includes timeouts/connection loss: the provider might already have accepted.
        response, status = None, None
    if status is not None and 200 <= status < 300:
        # If DB persistence fails, leave push_started_at intact for uncertain recovery.
        finish(engine, row, 'sent')
        return 'sent'
    if status in (404, 410):
        with engine.begin() as connection:
            connection.execute(delete(subscriptions).where(subscriptions.c.id == row['subscription_id']))
        return 'expired'
    if status in (429, 503):
        retry_after = None
        value = response.headers.get('Retry-After', '')
        if value.isdigit():
            retry_after = GRACE_SECONDS + 1 if len(value) > 6 else min(int(value), GRACE_SECONDS + 1)
        return retry(engine, row, f'push_rejected_{status}', retry_after)
    if status in (400, 401, 403, 413):
        finish(engine, row, 'failed', f'push_rejected_{status}')
        return 'failed'
    finish(engine, row, 'uncertain', 'send_outcome_unknown')
    return 'uncertain'


def run_once(engine, limit=20, max_seconds=50):
    # Validate config before claiming rows. Bad config must not consume reminders.
    vapid = vapid_config()
    recovered = recover_leases(engine)
    outcomes = {'recovered': recovered}
    deadline = time.monotonic() + max_seconds
    for _ in range(limit):
        if time.monotonic() >= deadline:
            break
        row = claim_one(engine)
        if row is None:
            break
        outcome = row.get('outcome') or process(engine, row, vapid)
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    return outcomes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error('--limit must be between 1 and 100')
    try:
        engine = get_engine()
        if engine.dialect.name != 'postgresql':
            raise ValueError('worker_requires_postgresql')
        print(json.dumps(run_once(engine, limit=args.limit), sort_keys=True))
    except Exception:
        # No exception repr/traceback: libraries may include database URLs or endpoints.
        print('Reminder worker failed. Check database/schema and VAPID configuration; retry safely.')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
