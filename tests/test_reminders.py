import copy
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import httpx
from pywebpush import WebPushException
from sqlalchemy import delete, select, update

import activity_reminders as api
import push_notifications as push
import test_push


class ReminderTests(unittest.TestCase):
    # Reuse isolated test DB/key setup without inheriting/rerunning the push tests.
    setUpDatabase = test_push.PushTests.setUp
    tearDownDatabase = test_push.PushTests.tearDown
    register = test_push.PushTests.register
    headers = test_push.PushTests.headers

    def setUp(self):
        self.setUpDatabase()
        self.clock = patch.object(api, 'utc_now', return_value=datetime(2030, 1, 1, 12, tzinfo=timezone.utc))
        self.clock.start()
        self.saved = self.register()
        self.activity_id = str(uuid4())
        self.base = f'/api/push/subscriptions/{self.saved["id"]}/reminders'
        self.path = f'{self.base}/{self.activity_id}'
        self.payload = {'time': '2030-01-02T14:00', 'timezone': 'America/Los_Angeles',
                        'latitude': 34.0522, 'longitude': -118.2437,
                        'title': 'Basketball', 'outdoor': True, 'preference': 'heat_sensitive'}

    def tearDown(self):
        self.clock.stop()
        self.tearDownDatabase()

    def put(self, payload=None, path=None):
        return self.client.put(path or self.path, json=self.payload if payload is None else payload,
                               headers=self.headers(self.saved))

    def test_create_read_update_and_utc_storage(self):
        with patch.object(push, 'webpush') as send:
            response = self.put()
            self.assertEqual(response.status_code, 200, response.text)
            created = response.json()
            self.assertEqual(created['starts_at'], '2030-01-02T22:00:00Z')
            self.assertEqual(created['due_at'], '2030-01-02T21:30:00Z')
            self.assertEqual(created['next_attempt_at'], created['due_at'])
            self.assertEqual(created['status'], 'pending')
            self.assertEqual(created['attempt_count'], 0)
            self.assertEqual(created['timezone'], 'America/Los_Angeles')
            for key in ('lease_until', 'sent_at', 'last_attempt_at', 'cancelled_at', 'last_error_code'):
                self.assertIsNone(created[key])
            listing = self.client.get(self.base, headers=self.headers(self.saved)).json()
            self.assertEqual(listing['reminders'], [created])
            self.assertNotIn(self.saved['token'], str(listing))
            self.assertNotIn(self.subscription['endpoint'], str(listing))
            updated = self.put({**self.payload, 'title': 'Walk', 'time': '2030-01-03T15:00'}).json()
            self.assertEqual(updated['id'], created['id'])
            self.assertEqual(updated['title'], 'Walk')
            self.assertEqual(updated['starts_at'], '2030-01-03T23:00:00Z')
            send.assert_not_called()

    def test_duplicate_requests_are_noops_even_after_lead_time(self):
        first = self.put().json()
        self.assertEqual(self.put().json(), first)
        with patch.object(api, 'utc_now', return_value=datetime(2030, 1, 3, tzinfo=timezone.utc)):
            self.assertEqual(self.put().json(), first)
            self.assertEqual(self.put({**self.payload, 'title': 'Changed'}).status_code, 422)
        with push.get_engine().connect() as conn:
            self.assertEqual(len(conn.execute(select(push.reminders)).all()), 1)

    def test_cancel_idempotent_and_cannot_reactivate(self):
        self.put()
        response = self.client.delete(self.path, headers=self.headers(self.saved))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'cancelled')
        self.assertIsNone(response.json()['next_attempt_at'])
        self.assertIsNotNone(response.json()['cancelled_at'])
        self.assertEqual(self.client.delete(self.path, headers=self.headers(self.saved)).json(), response.json())
        for payload in (self.payload, {**self.payload, 'time': '2030-02-02T14:00'}):
            self.assertEqual(self.put(payload).status_code, 409)
        self.assertEqual(self.put(path=f'{self.base}/{uuid4()}').status_code, 200)

    def test_sent_and_other_nonpending_rows_are_not_rescheduled(self):
        self.put()
        for status in ('sent', 'processing', 'retry', 'failed', 'missed', 'uncertain'):
            with self.subTest(status=status), push.get_engine().begin() as conn:
                conn.execute(update(push.reminders).values(status=status, attempt_count=2))
            self.assertEqual(self.put().status_code, 409)
            self.assertEqual(self.put({**self.payload, 'title': 'Another'}).status_code, 409)
        with push.get_engine().begin() as conn:
            conn.execute(update(push.reminders).values(status='sent'))
        self.assertEqual(self.client.delete(self.path, headers=self.headers(self.saved)).status_code, 409)

    def test_auth_required_for_every_operation_and_scoped_to_subscription(self):
        self.put()
        self.subscription = {**self.subscription, 'endpoint': 'https://web.push.apple.com/another'}
        other = self.register()
        for headers in ({}, {'Authorization': 'Bearer wrong'}, self.headers(other)):
            for method, path, kwargs in (('PUT', self.path, {'json': self.payload}), ('GET', self.base, {}), ('DELETE', self.path, {})):
                with self.subTest(method=method, headers_present=bool(headers)):
                    self.assertEqual(self.client.request(method, path, headers=headers, **kwargs).status_code, 403)
        other_base = f'/api/push/subscriptions/{other["id"]}/reminders'
        self.assertEqual(self.client.get(other_base, headers=self.headers(other)).json(), {'reminders': []})
        self.assertEqual(self.client.delete(f'{other_base}/{self.activity_id}', headers=self.headers(other)).status_code, 404)
        # Same activity UUID on a different subscription is independent.
        self.assertEqual(self.client.put(f'{other_base}/{self.activity_id}', json=self.payload, headers=self.headers(other)).status_code, 200)

    def test_invalid_inputs(self):
        for field, value in (('latitude', 91), ('latitude', -91), ('latitude', 'NaN'),
                             ('longitude', 181), ('longitude', '-Infinity'),
                             ('preference', 'unknown'), ('timezone', 'Not/A_Zone'),
                             ('title', '  '), ('title', 'x' * 201), ('outdoor', 'yes'),
                             ('time', '2030-01-02T14:30'), ('time', '2030-02-30T14:00'),
                             ('time', '2030-01-02T14:00Z')):
            with self.subTest(field=field, value=value):
                self.assertEqual(self.put({**self.payload, field: value}).status_code, 422)
        self.assertEqual(self.put({**self.payload, 'status': 'sent'}).status_code, 422)
        self.assertEqual(self.put(path=f'{self.base}/not-a-uuid').status_code, 422)
        for field in ('time', 'timezone', 'latitude', 'longitude', 'title', 'outdoor'):
            payload = copy.deepcopy(self.payload)
            del payload[field]
            self.assertEqual(self.put(payload).status_code, 422)

    def test_dst_gap_and_ambiguity_rejected_but_adjacent_hour_allowed(self):
        for time, message in (('2030-03-10T02:00', 'does not exist'), ('2030-11-03T01:00', 'ambiguous')):
            response = self.put({**self.payload, 'time': time})
            self.assertEqual(response.status_code, 422)
            self.assertIn(message, response.text)
        response = self.put({**self.payload, 'time': '2030-03-10T03:00'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['starts_at'], '2030-03-10T10:00:00Z')

    def test_30_minute_lead_boundary_and_past_rejected(self):
        payload = {**self.payload, 'time': '2030-01-01T13:00', 'timezone': 'UTC'}
        for minutes, expected in ((29, 422), (30, 200)):
            with patch.object(api, 'utc_now', return_value=datetime(2030, 1, 1, 13, tzinfo=timezone.utc) - timedelta(minutes=minutes)):
                self.assertEqual(self.put(payload).status_code, expected)
        self.assertEqual(self.put({**self.payload, 'time': '2029-01-01T14:00'}).status_code, 422)

    def test_coordinates_preferences_and_timezones(self):
        for index, preference in enumerate(('normal', 'cold_sensitive', 'heat_sensitive')):
            response = self.put({**self.payload, 'preference': preference, 'latitude': -90 if index == 0 else 90, 'longitude': 180})
            self.assertEqual(response.status_code, 200)
        response = self.put({**self.payload, 'timezone': 'Asia/Taipei', 'time': '2030-01-03T06:00'})
        self.assertEqual(response.json()['starts_at'], '2030-01-02T22:00:00Z')

    def test_subscription_deletion_cascades_in_database(self):
        self.put()
        # Direct SQL deletion proves database FK cascade, not just endpoint cleanup.
        with push.get_engine().begin() as conn:
            conn.execute(delete(push.subscriptions).where(push.subscriptions.c.id == self.saved['id']))
        with push.get_engine().connect() as conn:
            self.assertIsNone(conn.execute(select(push.reminders)).first())

    def test_unregister_and_expired_manual_push_remove_reminders(self):
        self.put()
        self.assertEqual(self.client.delete(f'/api/push/subscriptions/{self.saved["id"]}', headers=self.headers(self.saved)).status_code, 200)
        with push.get_engine().connect() as conn:
            self.assertIsNone(conn.execute(select(push.reminders)).first())
        self.saved = self.register()
        self.base = f'/api/push/subscriptions/{self.saved["id"]}/reminders'
        self.path = f'{self.base}/{self.activity_id}'
        self.put()
        with patch.object(push, 'webpush', side_effect=WebPushException('private', response=httpx.Response(410))):
            response = self.client.post(f'/api/push/subscriptions/{self.saved["id"]}/test', headers=self.headers(self.saved))
        self.assertEqual(response.status_code, 410)
        with push.get_engine().connect() as conn:
            self.assertIsNone(conn.execute(select(push.reminders)).first())

    def test_concurrent_duplicate_puts_have_one_id(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.put(), range(4)))
        self.assertEqual([r.status_code for r in results], [200] * 4)
        self.assertEqual(len({r.json()['id'] for r in results}), 1)

    def test_missing_cancel_and_empty_listing(self):
        self.assertEqual(self.client.get(self.base, headers=self.headers(self.saved)).json(), {'reminders': []})
        self.assertEqual(self.client.delete(self.path, headers=self.headers(self.saved)).status_code, 404)


if __name__ == '__main__':
    unittest.main()
