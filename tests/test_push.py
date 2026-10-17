import base64
import hashlib
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import httpx
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient
from pywebpush import WebPushException
from sqlalchemy import select

import main
import push_notifications as push


def encode(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


class PushTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        private = ec.generate_private_key(ec.SECP256R1())
        public = encode(private.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))
        self.environment = patch.dict(os.environ, {
            'PUSH_DATABASE_URL': os.getenv('PUSH_TEST_DATABASE_URL', f'sqlite:///{self.directory.name}/push.db'),
            'PUSH_ALLOW_SQLITE': '1', 'RENDER': '',
            'VAPID_PRIVATE_KEY': encode(private.private_numbers().private_value.to_bytes(32, 'big')),
            'VAPID_PUBLIC_KEY': public, 'VAPID_SUBJECT': 'mailto:test@example.com',
        })
        self.environment.start()
        push.get_engine.cache_clear()
        self.client = TestClient(main.app)
        self.subscription = {'endpoint': 'https://web.push.apple.com/test-endpoint',
                             'expirationTime': None,
                             'keys': {'p256dh': public, 'auth': encode(os.urandom(16))}}

    def tearDown(self):
        if push.get_engine.cache_info().currsize:
            # PUSH_TEST_DATABASE_URL must name a disposable test database.
            push.metadata.drop_all(push.get_engine())
            push.get_engine().dispose()
        push.get_engine.cache_clear()
        self.environment.stop()
        self.directory.cleanup()

    def register(self):
        response = self.client.post('/api/push/subscriptions', json={'subscription': self.subscription})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def headers(self, saved):
        return {'Authorization': f'Bearer {saved["token"]}'}

    def test_registration_public_key_persistence_and_no_automatic_send(self):
        with patch.object(push, 'webpush') as deliver:
            self.assertEqual(self.client.get('/api/push/public-key').json(), {'public_key': os.environ['VAPID_PUBLIC_KEY']})
            saved = self.register()
            self.assertGreaterEqual(len(saved['token']), 32)
            with push.get_engine().connect() as conn:
                row = conn.execute(select(push.subscriptions)).mappings().one()
                self.assertEqual(row['token_hash'], hashlib.sha256(saved['token'].encode()).hexdigest())
                self.assertNotIn(saved['token'], str(row))
            push.get_engine().dispose()
            push.get_engine.cache_clear()
            response = self.client.post(f'/api/push/subscriptions/{saved["id"]}/test', headers=self.headers(saved))
            self.assertEqual(response.status_code, 200)
            deliver.assert_called_once()
            kwargs = deliver.call_args.kwargs
            self.assertEqual(kwargs['subscription_info']['endpoint'], self.subscription['endpoint'])
            self.assertEqual(json.loads(kwargs['data'])['title'], 'DayCast test notification')
            self.assertEqual(kwargs['vapid_claims'], {'sub': 'mailto:test@example.com'})

    def test_existing_subscription_cannot_be_taken_over_or_reset_rate_limit(self):
        saved = self.register()
        for token in (None, 'x' * 43):
            response = self.client.post('/api/push/subscriptions', json={'subscription': self.subscription, 'token': token})
            self.assertEqual(response.status_code, 409)
        response = self.client.post('/api/push/subscriptions', json={'subscription': self.subscription, 'token': saved['token']})
        self.assertEqual(response.json(), saved)

    def test_send_and_delete_require_correct_capability(self):
        saved = self.register()
        with patch.object(push, 'webpush') as deliver:
            for headers in ({}, {'Authorization': 'Bearer wrong'}, {'Authorization': saved['token']}):
                for method, path in (('POST', '/test'), ('DELETE', '')):
                    response = self.client.request(method, f'/api/push/subscriptions/{saved["id"]}{path}', headers=headers)
                    self.assertEqual(response.status_code, 403)
            deliver.assert_not_called()
        self.assertEqual(self.client.delete(f'/api/push/subscriptions/{saved["id"]}', headers=self.headers(saved)).status_code, 200)
        self.assertEqual(self.client.post(f'/api/push/subscriptions/{saved["id"]}/test', headers=self.headers(saved)).status_code, 403)

    def test_database_rate_limit_survives_new_connection_and_failed_delivery(self):
        saved = self.register()
        path = f'/api/push/subscriptions/{saved["id"]}/test'
        with patch.object(push, 'webpush') as deliver:
            self.assertEqual(self.client.post(path, headers=self.headers(saved)).status_code, 200)
            push.get_engine().dispose()
            push.get_engine.cache_clear()
            limited = self.client.post(path, headers=self.headers(saved))
            self.assertEqual(limited.status_code, 429)
            self.assertEqual(limited.headers['retry-after'], '60')
            self.client.post('/api/push/subscriptions', json={'subscription': self.subscription, 'token': saved['token']})
            self.assertEqual(self.client.post(path, headers=self.headers(saved)).status_code, 429)
            deliver.assert_called_once()
            with patch.object(push.time, 'time', return_value=push.time.time() + 61):
                deliver.side_effect = RuntimeError('private endpoint/auth data')
                failure = self.client.post(path, headers=self.headers(saved))
                self.assertEqual(failure.status_code, 502)
                self.assertNotIn('private', failure.text)
                self.assertEqual(self.client.post(path, headers=self.headers(saved)).status_code, 429)

    def test_expired_subscription_deleted(self):
        for status in (404, 410):
            saved = self.register()
            error = WebPushException('private push data', response=httpx.Response(status))
            with patch.object(push, 'webpush', side_effect=error):
                response = self.client.post(f'/api/push/subscriptions/{saved["id"]}/test', headers=self.headers(saved))
            self.assertEqual(response.status_code, 410)
            self.assertNotIn('private', response.text)
            with push.get_engine().connect() as conn:
                self.assertIsNone(conn.execute(select(push.subscriptions)).first())

    def test_concurrent_sends_only_deliver_once(self):
        saved = self.register()
        path = f'/api/push/subscriptions/{saved["id"]}/test'
        with patch.object(push, 'webpush') as deliver:
            with ThreadPoolExecutor(max_workers=4) as pool:
                statuses = list(pool.map(lambda _: self.client.post(path, headers=self.headers(saved)).status_code, range(4)))
        self.assertEqual(sorted(statuses), [200, 429, 429, 429])
        deliver.assert_called_once()

    def test_provider_failure_keeps_subscription(self):
        saved = self.register()
        with patch.object(push, 'webpush', side_effect=WebPushException('private', response=httpx.Response(503))):
            response = self.client.post(f'/api/push/subscriptions/{saved["id"]}/test', headers=self.headers(saved))
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('private', response.text)
        with push.get_engine().connect() as conn:
            self.assertIsNotNone(conn.execute(select(push.subscriptions)).first())

    def test_validation_and_ssrf_protection(self):
        for endpoint in ('http://web.push.apple.com/path', 'https://localhost/path',
                         'https://127.0.0.1/path', 'https://web.push.apple.com.evil.example/path',
                         'https://user:pass@web.push.apple.com/path', 'https://web.push.apple.com:444/path'):
            with self.subTest(endpoint=endpoint):
                subscription = {**self.subscription, 'endpoint': endpoint}
                self.assertEqual(self.client.post('/api/push/subscriptions', json={'subscription': subscription}).status_code, 422)
        for key in ('auth', 'p256dh'):
            subscription = {**self.subscription, 'keys': {**self.subscription['keys'], key: 'bad'}}
            self.assertEqual(self.client.post('/api/push/subscriptions', json={'subscription': subscription}).status_code, 422)
        for host in ('fcm.googleapis.com', 'updates.push.services.mozilla.com'):
            subscription = {**self.subscription, 'endpoint': f'https://{host}/test'}
            self.assertEqual(self.client.post('/api/push/subscriptions', json={'subscription': subscription}).status_code, 201)

    def test_missing_configuration_does_not_break_health_or_weather_validation(self):
        with patch.dict(os.environ, {'VAPID_PRIVATE_KEY': ''}):
            response = self.client.get('/api/push/public-key')
            self.assertEqual(response.status_code, 503)
            self.assertNotIn('VAPID_PRIVATE_KEY', response.text)
        self.assertEqual(self.client.get('/health').status_code, 200)
        self.assertEqual(self.client.get('/api/weather?latitude=999&longitude=0').status_code, 422)
        with patch.dict(os.environ, {'PUSH_DATABASE_URL': ''}):
            self.assertEqual(self.client.post('/api/push/subscriptions', json={'subscription': self.subscription}).status_code, 503)

    def test_render_cannot_use_ephemeral_sqlite(self):
        with patch.dict(os.environ, {'RENDER': 'true', 'PUSH_DATABASE_URL': f'sqlite:///{self.directory.name}/render.db'}):
            self.assertEqual(self.client.post('/api/push/subscriptions', json={'subscription': self.subscription}).status_code, 503)

    def test_real_library_encrypts_and_signs_with_configured_keys(self):
        # Exercise pywebpush encryption and VAPID signing; mock only HTTP transport.
        saved = self.register()
        response = httpx.Response(201)
        with patch('requests.post', return_value=response) as post:
            result = self.client.post(f'/api/push/subscriptions/{saved["id"]}/test', headers=self.headers(saved))
        self.assertEqual(result.status_code, 200)
        post.assert_called_once()
        self.assertIsInstance(post.call_args.kwargs['data'], bytes)
        self.assertTrue(post.call_args.kwargs['headers']['authorization'].startswith('vapid '))

    def test_mismatched_vapid_key_is_unavailable(self):
        other = ec.generate_private_key(ec.SECP256R1())
        with patch.dict(os.environ, {'VAPID_PUBLIC_KEY': encode(other.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))}):
            self.assertEqual(self.client.get('/api/push/public-key').status_code, 503)


if __name__ == '__main__':
    unittest.main()
