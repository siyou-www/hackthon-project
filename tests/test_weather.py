import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

import main


class WeatherTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.data = {
            'timezone': 'America/Los_Angeles',
            'hourly': {
                'time': ['2026-10-16T08:00', '2026-10-16T09:00'],
                'temperature_2m': [15, -10],
                'precipitation_probability': [20, 0],
            },
        }
        self.params = {'latitude': 34.05, 'longitude': -118.24}

    def fetch(self, data=None, status=200, error=None):
        response = httpx.Response(
            status, json=self.data if data is None else data,
            request=httpx.Request('GET', 'https://api.open-meteo.com/v1/forecast'),
        )
        with patch.object(httpx.AsyncClient, 'get', new_callable=AsyncMock) as get:
            get.return_value = response
            get.side_effect = error
            result = self.client.get('/api/weather', params=self.params)
        return result, get

    def test_valid_forecast_and_conversion(self):
        response, get = self.fetch()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            'timezone': self.data['timezone'],
            'hourly': [
                {'time': '2026-10-16T08:00', 'temperature_c': 15,
                 'temperature_f': 59, 'precipitation_probability': 20},
                {'time': '2026-10-16T09:00', 'temperature_c': -10,
                 'temperature_f': 14, 'precipitation_probability': 0},
            ],
        })
        get.assert_awaited_once_with(
            'https://api.open-meteo.com/v1/forecast',
            params={**self.params, 'hourly': 'temperature_2m,precipitation_probability',
                    'temperature_unit': 'celsius', 'timezone': 'auto'},
        )

    def test_invalid_coordinates_do_not_call_provider(self):
        for params in ({}, {'latitude': 91, 'longitude': 0},
                       {'latitude': -91, 'longitude': 0},
                       {'latitude': 0, 'longitude': 181},
                       {'latitude': 0, 'longitude': -181},
                       {'latitude': 'abc', 'longitude': 0},
                       {'latitude': 'nan', 'longitude': 0},
                       {'latitude': 0, 'longitude': 'inf'}):
            with self.subTest(params=params), patch.object(httpx.AsyncClient, 'get') as get:
                self.assertEqual(self.client.get('/api/weather', params=params).status_code, 422)
                get.assert_not_called()

    def test_coordinate_boundaries(self):
        for latitude, longitude in ((-90, -180), (90, 180)):
            self.params = {'latitude': latitude, 'longitude': longitude}
            self.assertEqual(self.fetch()[0].status_code, 200)

    def test_timeout(self):
        response, _ = self.fetch(error=httpx.ReadTimeout('private details'))
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json(), {'detail': 'Weather service timed out. Please try again.'})

    def test_provider_errors(self):
        for status in (400, 429, 500):
            with self.subTest(status=status):
                response, _ = self.fetch(status=status)
                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json(), {'detail': 'Weather service is unavailable. Please try again.'})
        response, _ = self.fetch(error=httpx.ConnectError('private details'))
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('private', response.text)

    def test_http_status_logging_excludes_sensitive_details(self):
        request = httpx.Request(
            'GET', 'https://private-user:private-password@example.com/?token=private-token',
            headers={'Authorization': 'Bearer private-header'},
        )
        upstream = httpx.Response(429, request=request, text='private-response-body')
        error = httpx.HTTPStatusError('private-exception-message', request=request, response=upstream)
        with self.assertLogs('weather_service', level='WARNING') as logs:
            response, _ = self.fetch(error=error)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {'detail': 'Weather service is unavailable. Please try again.'})
        self.assertEqual(logs.output, [
            'WARNING:weather_service:Open-Meteo request failed: exception=HTTPStatusError upstream_status=429',
        ])
        self.assertIsNone(logs.records[0].exc_info)

    def test_transport_logging_preserves_timeout_and_connection_responses(self):
        for error, status, detail in (
            (httpx.ReadTimeout('private-timeout-details'), 504, 'Weather service timed out. Please try again.'),
            (httpx.ConnectError('private-connection-details'), 502, 'Weather service is unavailable. Please try again.'),
        ):
            with self.subTest(error=type(error).__name__), self.assertLogs('weather_service', level='WARNING') as logs:
                response, _ = self.fetch(error=error)
            self.assertEqual(response.status_code, status)
            self.assertEqual(response.json(), {'detail': detail})
            self.assertEqual(logs.output, [
                f'WARNING:weather_service:Open-Meteo request failed: exception={type(error).__name__} upstream_status=None',
            ])
            self.assertIsNone(logs.records[0].exc_info)

    def test_missing_or_incomplete_data(self):
        cases = [{}, {'timezone': 'UTC'}, {'timezone': 'UTC', 'hourly': None}, []]
        for key in self.data['hourly']:
            data = copy.deepcopy(self.data)
            del data['hourly'][key]
            cases.append(data)
        for value in ([], [None, 1], [True, 1], ['bad', 1], [1]):
            data = copy.deepcopy(self.data)
            data['hourly']['temperature_2m'] = value
            cases.append(data)
        for key, value in (('time', ['', 'x']), ('precipitation_probability', [-1, 101])):
            data = copy.deepcopy(self.data)
            data['hourly'][key] = value
            cases.append(data)
        data = copy.deepcopy(self.data)
        data['timezone'] = ''
        cases.append(data)
        for data in cases:
            with self.subTest(data=data):
                response, _ = self.fetch(data=data)
                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json(), {'detail': 'Weather service returned incomplete or invalid forecast data.'})

    def test_invalid_json(self):
        with patch.object(httpx.AsyncClient, 'get', new_callable=AsyncMock) as get:
            get.return_value = httpx.Response(200, text='not JSON', request=httpx.Request('GET', 'https://api.open-meteo.com'))
            self.assertEqual(self.client.get('/api/weather', params=self.params).status_code, 502)

    def test_health_tasks_and_cors_regression(self):
        self.assertEqual(self.client.get('/health').json(), {'status': 'ok'})
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'DB_NAME', str(Path(directory) / 'tasks.db')):
            main.init_db()
            response = self.client.post('/tasks', json={'title': 'Weather regression'})
            self.assertEqual(response.status_code, 200)
            task_id = response.json()['id']
            self.assertEqual(self.client.get(f'/tasks/{task_id}').json()['title'], 'Weather regression')
            self.assertEqual(len(self.client.get('/tasks').json()['tasks']), 1)
            self.assertEqual(len(self.client.get('/tasks/search?q=Weather').json()['tasks']), 1)
            self.assertEqual(self.client.put(f'/tasks/{task_id}', json={'title': 'Updated'}).json()['title'], 'Updated')
            self.assertEqual(self.client.patch(f'/tasks/{task_id}/complete').json()['completed'], 1)
            self.assertEqual(len(self.client.get('/tasks?completed=true').json()['tasks']), 1)
            self.assertEqual(self.client.get('/tasks/stats').json(), {'total_tasks': 1, 'completed_tasks': 1, 'pending_tasks': 0})
            self.assertEqual(self.client.delete(f'/tasks/{task_id}').status_code, 200)
            self.assertEqual(self.client.get(f'/tasks/{task_id}').status_code, 404)
        for origin in ('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'):
            response = self.client.options('/api/weather', headers={'Origin': origin, 'Access-Control-Request-Method': 'GET'})
            self.assertEqual(response.headers['access-control-allow-origin'], origin)
            self.assertEqual(response.headers['access-control-allow-credentials'], 'true')


if __name__ == '__main__':
    unittest.main()
