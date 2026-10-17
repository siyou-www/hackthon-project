import asyncio
import json
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi import HTTPException
from pywebpush import WebPushException
from sqlalchemy import insert, select, update

import push_notifications as push
import reminder_worker as worker
import test_push
from weather_service import fetch_weather


class WorkerTests(unittest.TestCase):
    setUpDatabase = test_push.PushTests.setUp
    tearDown = test_push.PushTests.tearDown
    register = test_push.PushTests.register
    headers = test_push.PushTests.headers

    def setUp(self):
        self.setUpDatabase()
        self.saved = self.register()
        self.engine = push.get_engine()
        self.now = datetime(2030, 1, 2, 21, 30, tzinfo=timezone.utc)
        self.clock = patch.object(worker, 'utc_now', side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.row_id = str(uuid4())
        self.activity_id = str(uuid4())
        with self.engine.begin() as conn:
            conn.execute(insert(push.reminders).values(
                id=self.row_id, subscription_id=self.saved['id'], activity_id=self.activity_id,
                title='Basketball', outdoor=True, latitude=34.0522, longitude=-118.2437,
                timezone='America/Los_Angeles', preference='heat_sensitive',
                starts_at=self.now + timedelta(minutes=30), due_at=self.now,
                status='pending', attempt_count=0, next_attempt_at=self.now,
                created_at=self.now, updated_at=self.now))
        self.forecast = {'timezone': 'America/Los_Angeles', 'hourly': [
            {'time': '2030-01-02T14:00', 'temperature_c': 32, 'temperature_f': 89.6,
             'precipitation_probability': 80}]}

    def row(self):
        with self.engine.connect() as conn:
            row = conn.execute(select(push.reminders).where(push.reminders.c.id == self.row_id)).mappings().first()
            return dict(row) if row else None

    def change(self, **values):
        with self.engine.begin() as conn:
            conn.execute(update(push.reminders).where(push.reminders.c.id == self.row_id).values(**values))

    def run_worker(self, status=201, error=None, forecast=None):
        with patch.object(worker, 'fetch_weather', new_callable=AsyncMock) as weather, patch.object(worker, 'webpush') as send:
            weather.return_value = forecast or self.forecast
            send.return_value = httpx.Response(status)
            send.side_effect = error
            result = worker.run_once(self.engine)
        return result, weather, send

    def test_success_advice_tag_and_duplicate_prevention(self):
        result, weather, send = self.run_worker()
        self.assertEqual(result['sent'], 1)
        row = self.row()
        self.assertEqual(row['status'], 'sent')
        self.assertIsNotNone(row['sent_at'])
        self.assertIsNotNone(row['push_started_at'])
        self.assertIsNone(row['lease_token'])
        weather.assert_awaited_once_with(34.0522, -118.2437, forecast_timezone='America/Los_Angeles')
        kwargs = send.call_args.kwargs
        payload = json.loads(kwargs['data'])
        self.assertEqual(payload['tag'], f'daycast-reminder-{self.row_id}')
        self.assertIn('Basketball', payload['title'])
        self.assertIn('umbrella', payload['body'])
        self.assertIn('seek shade outdoors', payload['body'])
        self.assertEqual(len(kwargs['headers']['Topic']), 32)
        self.assertEqual(kwargs['subscription_info']['endpoint'], self.subscription['endpoint'])
        _, weather, send = self.run_worker()
        weather.assert_not_awaited()
        send.assert_not_called()

    def test_not_due_missed_and_cancelled_do_not_send(self):
        for changes, expected in (({'due_at': self.now + timedelta(minutes=1)}, 'pending'),
                                  ({'due_at': self.now - timedelta(seconds=worker.GRACE_SECONDS + 60)}, 'missed'),
                                  ({'status': 'cancelled'}, 'cancelled')):
            self.change(**{'status':'pending', 'due_at':self.now, 'next_attempt_at':self.now, **changes})
            _, _, send = self.run_worker()
            self.assertEqual(self.row()['status'], expected)
            send.assert_not_called()

    def test_cancel_during_weather_prevents_send(self):
        async def weather(*args, **kwargs):
            path = f'/api/push/subscriptions/{self.saved["id"]}/reminders/{self.activity_id}'
            response = self.client.delete(path, headers=self.headers(self.saved))
            self.assertEqual(response.status_code, 200)
            return self.forecast
        with patch.object(worker, 'fetch_weather', side_effect=weather), patch.object(worker, 'webpush') as send:
            worker.run_once(self.engine)
        send.assert_not_called()
        self.assertEqual(self.row()['status'], 'cancelled')

    def test_subscription_deleted_during_weather_prevents_send(self):
        async def weather(*args, **kwargs):
            response = self.client.delete(f'/api/push/subscriptions/{self.saved["id"]}', headers=self.headers(self.saved))
            self.assertEqual(response.status_code, 200)
            return self.forecast
        with patch.object(worker, 'fetch_weather', side_effect=weather), patch.object(worker, 'webpush') as send:
            worker.run_once(self.engine)
        send.assert_not_called()
        self.assertIsNone(self.row())

    def test_weather_retries_are_bounded(self):
        with patch.object(worker, 'fetch_weather', side_effect=HTTPException(504, 'private')), patch.object(worker, 'webpush') as send:
            for attempt in range(1, 4):
                worker.run_once(self.engine)
                self.assertEqual(self.row()['attempt_count'], attempt)
                self.assertEqual(self.row()['status'], 'failed' if attempt == 3 else 'retry')
                self.now += timedelta(seconds=65)
        send.assert_not_called()
        self.assertEqual(self.row()['last_error_code'], 'weather_unavailable')

    def test_missing_forecast_hour_retries_and_elapsed_window_is_missed(self):
        self.run_worker(forecast={'hourly': []})
        self.assertEqual(self.row()['status'], 'retry')
        self.now += timedelta(seconds=worker.GRACE_SECONDS + 60)
        _, weather, send = self.run_worker()
        self.assertEqual(self.row()['status'], 'missed')
        weather.assert_not_awaited()
        send.assert_not_called()

    def test_provider_rejection_retries_but_acceptance_never_retries(self):
        self.run_worker(error=WebPushException('private', response=httpx.Response(503)))
        self.assertEqual(self.row()['status'], 'retry')
        self.assertIsNone(self.row()['push_started_at'])
        self.now += timedelta(seconds=60)
        self.run_worker(status=202)
        self.assertEqual(self.row()['status'], 'sent')
        self.now += timedelta(seconds=100)
        self.assertNotIn('sent', self.run_worker()[0])

    def test_retry_after_beyond_window_marks_missed(self):
        self.run_worker(error=WebPushException('private', response=httpx.Response(429, headers={'Retry-After': str(worker.GRACE_SECONDS + 300)})))
        self.assertEqual(self.row()['status'], 'missed')

    def test_permanent_rejection_failed_ambiguous_errors_uncertain(self):
        for error, expected in ((WebPushException('private', response=httpx.Response(403)), 'failed'),
                                (WebPushException('private', response=httpx.Response(502)), 'uncertain'),
                                (TimeoutError('private endpoint auth'), 'uncertain')):
            self.change(status='pending', attempt_count=0, next_attempt_at=self.now, push_started_at=None)
            self.run_worker(error=error)
            self.assertEqual(self.row()['status'], expected)
            self.assertNotIn('private', self.row()['last_error_code'])
            self.assertNotIn('sent', self.run_worker()[0])

    def test_expired_push_deletes_subscription_and_reminders(self):
        self.run_worker(error=WebPushException('private', response=httpx.Response(410)))
        self.assertIsNone(self.row())
        with self.engine.connect() as conn:
            self.assertIsNone(conn.execute(select(push.subscriptions)).first())

    def test_lease_recovery_before_send_fences_old_worker(self):
        stale = worker.claim_one(self.engine)
        self.now += timedelta(seconds=91)
        worker.recover_leases(self.engine)
        fresh = worker.claim_one(self.engine)
        self.assertNotEqual(stale['lease_token'], fresh['lease_token'])
        self.assertIsNone(worker.prepare_send(self.engine, stale))
        self.assertEqual(worker.finish(self.engine, stale, 'failed', 'stale_worker'), 0)
        self.assertEqual(self.row()['lease_token'], fresh['lease_token'])

    def test_crash_after_send_boundary_never_resends(self):
        claim = worker.claim_one(self.engine)
        self.assertIsNotNone(worker.prepare_send(self.engine, claim))
        # Could have crashed just before OR just after provider acceptance.
        self.now += timedelta(seconds=91)
        _, weather, send = self.run_worker()
        self.assertEqual(self.row()['status'], 'uncertain')
        weather.assert_not_awaited()
        send.assert_not_called()

    def test_db_failure_after_provider_acceptance_never_resends(self):
        real_finish = worker.finish
        def fail_sent(engine, row, status, *args, **kwargs):
            if status == 'sent':
                raise RuntimeError('database unavailable')
            return real_finish(engine, row, status, *args, **kwargs)
        with patch.object(worker, 'finish', side_effect=fail_sent):
            with self.assertRaises(RuntimeError):
                self.run_worker()
        self.assertIsNotNone(self.row()['push_started_at'])
        self.now += timedelta(seconds=91)
        self.run_worker()
        self.assertEqual(self.row()['status'], 'uncertain')

    def test_cancel_after_send_boundary_returns_conflict(self):
        claim = worker.claim_one(self.engine)
        worker.prepare_send(self.engine, claim)
        path = f'/api/push/subscriptions/{self.saved["id"]}/reminders/{self.activity_id}'
        self.assertEqual(self.client.delete(path, headers=self.headers(self.saved)).status_code, 409)

    def test_bad_config_leaves_reminder_pending(self):
        with patch.object(worker, 'vapid_config', side_effect=HTTPException(503)):
            with self.assertRaises(HTTPException):
                worker.run_once(self.engine)
        self.assertEqual(self.row()['status'], 'pending')
        self.assertEqual(self.row()['attempt_count'], 0)

    def test_expired_leases_obey_window_and_attempt_limits(self):
        for count, delta, expected in ((3, 91, 'failed'), (1, worker.GRACE_SECONDS + 60, 'missed')):
            self.change(status='pending', attempt_count=count - 1, next_attempt_at=self.now,
                        due_at=self.now, push_started_at=None)
            worker.claim_one(self.engine)
            self.now += timedelta(seconds=delta)
            worker.recover_leases(self.engine)
            self.assertEqual(self.row()['status'], expected)

    def test_cli_import_does_not_import_main_or_create_task_database(self):
        result = subprocess.run([sys.executable, '-c',
            'import sys; import reminder_worker; assert "main" not in sys.modules'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cli_failure_redacts_secrets(self):
        with patch.object(worker, 'get_engine', side_effect=RuntimeError('SECRET_ENDPOINT')), patch('builtins.print') as output, patch.object(sys, 'argv', ['reminder_worker']):
            self.assertEqual(worker.main(), 1)
        self.assertNotIn('SECRET', str(output.call_args))

    def test_shared_weather_helper_accepts_explicit_timezone(self):
        provider = {'timezone':'Asia/Kolkata','hourly':{'time':['2030-01-02T14:00'], 'temperature_2m':[20], 'precipitation_probability':[10]}}
        with patch.object(httpx.AsyncClient, 'get', new_callable=AsyncMock) as get:
            get.return_value = httpx.Response(200, json=provider, request=httpx.Request('GET','https://api.open-meteo.com'))
            forecast = asyncio.run(fetch_weather(20, 70, forecast_timezone='Asia/Kolkata'))
        self.assertEqual(get.call_args.kwargs['params']['timezone'], 'Asia/Kolkata')
        self.assertEqual(forecast['hourly'][0]['temperature_c'], 20)

    def test_activity_hour_in_half_hour_offset_timezone(self):
        self.now = datetime(2030, 1, 2, 8, tzinfo=timezone.utc)
        self.change(timezone='Asia/Kolkata', starts_at=self.now + timedelta(minutes=30),
                    due_at=self.now, next_attempt_at=self.now)
        _, weather, send = self.run_worker()
        weather.assert_awaited_once_with(34.0522, -118.2437, forecast_timezone='Asia/Kolkata')
        self.assertIn('Starts at 14:00 (Asia/Kolkata)', json.loads(send.call_args.kwargs['data'])['body'])

    def test_postgresql_skips_locked_due_rows(self):
        if self.engine.dialect.name != 'postgresql':
            self.skipTest('SKIP LOCKED requires the isolated PostgreSQL run')
        with self.engine.begin() as connection:
            connection.execute(select(push.reminders).where(push.reminders.c.id == self.row_id).with_for_update())
            with patch.object(worker, 'webpush') as send, ThreadPoolExecutor(max_workers=1) as pool:
                result = pool.submit(worker.run_once, self.engine).result(timeout=5)
            self.assertNotIn('sent', result)
            send.assert_not_called()
        self.assertEqual(self.row()['status'], 'pending')

    def test_concurrent_workers_postgresql_only_send_once(self):
        if self.engine.dialect.name != 'postgresql':
            self.skipTest('PostgreSQL row locking is verified in the isolated PostgreSQL run')
        barrier = Barrier(2)
        async def weather(*args, **kwargs):
            return self.forecast
        def run():
            barrier.wait(timeout=5)
            return worker.run_once(self.engine)
        with patch.object(worker, 'fetch_weather', side_effect=weather), patch.object(worker, 'webpush', return_value=httpx.Response(201)) as send:
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: run(), range(2)))
        self.assertEqual(sum(result.get('sent', 0) for result in results), 1)
        send.assert_called_once()
        self.assertEqual(self.row()['status'], 'sent')

    def test_delayed_five_minute_schedule_sends_once_with_reduced_ttl(self):
        self.now += timedelta(minutes=5, seconds=30)
        result, _, send = self.run_worker()
        self.assertEqual(result['sent'], 1)
        self.assertEqual(send.call_args.kwargs['ttl'], 570)
        self.now += timedelta(minutes=5)
        _, weather, send = self.run_worker()
        weather.assert_not_awaited()
        send.assert_not_called()

    def test_deadline_is_earlier_of_grace_or_activity_start(self):
        row = self.row()
        self.assertEqual(worker.send_deadline(row), self.now + timedelta(minutes=15))
        row['starts_at'] = self.now + timedelta(minutes=2)
        self.assertEqual(worker.send_deadline(row), row['starts_at'])
        self.assertTrue(worker.expired(row, row['starts_at']))

    def test_at_fifteen_minute_deadline_reminder_is_missed_without_fetch(self):
        self.now += timedelta(minutes=15)
        _, weather, send = self.run_worker()
        self.assertEqual(self.row()['status'], 'missed')
        weather.assert_not_awaited()
        send.assert_not_called()

    def test_ttl_is_capped_by_earlier_activity_start(self):
        self.change(starts_at=self.now + timedelta(minutes=1))
        hour = {**self.forecast['hourly'][0], 'time': '2030-01-02T13:31'}
        _, _, send = self.run_worker(forecast={'hourly': [hour]})
        self.assertEqual(send.call_args.kwargs['ttl'], 60)
        self.assertEqual(self.row()['status'], 'sent')

    def test_no_send_at_activity_start_even_with_grace_remaining(self):
        self.change(starts_at=self.now + timedelta(minutes=1))
        self.now += timedelta(minutes=1)
        _, weather, send = self.run_worker()
        self.assertEqual(self.row()['status'], 'missed')
        weather.assert_not_awaited()
        send.assert_not_called()

    def test_deadline_crossed_after_send_boundary_prevents_push(self):
        prepare = worker.prepare_send
        def pause_after_commit(engine, claim):
            subscription = prepare(engine, claim)
            self.now = worker.send_deadline(claim)
            return subscription
        with patch.object(worker, 'prepare_send', side_effect=pause_after_commit):
            _, _, send = self.run_worker()
        self.assertEqual(self.row()['status'], 'missed')
        self.assertEqual(self.row()['last_error_code'], 'window_elapsed_before_push')
        send.assert_not_called()

    def test_subsecond_remaining_ttl_is_not_rounded_up(self):
        self.now += timedelta(minutes=14, seconds=59, microseconds=500000)
        _, _, send = self.run_worker()
        self.assertEqual(self.row()['status'], 'missed')
        send.assert_not_called()

    def test_weather_delay_crossing_deadline_is_missed(self):
        self.now += timedelta(minutes=14, seconds=59)
        async def weather(*args, **kwargs):
            self.now += timedelta(seconds=2)
            return self.forecast
        with patch.object(worker, 'fetch_weather', side_effect=weather), patch.object(worker, 'webpush') as send:
            worker.run_once(self.engine)
        self.assertEqual(self.row()['status'], 'missed')
        send.assert_not_called()

    def test_retries_on_subsequent_five_minute_runs_are_bounded_and_can_succeed(self):
        self.now += timedelta(seconds=70)  # Queue and dependency installation delay.
        with patch.object(worker, 'fetch_weather', side_effect=HTTPException(504)), patch.object(worker, 'webpush') as send:
            for _ in range(2):
                worker.run_once(self.engine)
                self.assertEqual(self.row()['status'], 'retry')
                self.now += timedelta(minutes=5)
            send.assert_not_called()
        self.run_worker()
        self.assertEqual(self.row()['status'], 'sent')
        self.assertEqual(self.row()['attempt_count'], 3)
        self.now += timedelta(minutes=5)
        self.assertNotIn('sent', self.run_worker()[0])

    def test_retry_must_fit_before_activity_start(self):
        self.change(starts_at=self.now + timedelta(seconds=20))
        claim = worker.claim_one(self.engine)
        self.assertEqual(worker.retry(self.engine, claim, 'weather_unavailable'), 'missed')
        self.assertIsNone(self.row()['next_attempt_at'])
