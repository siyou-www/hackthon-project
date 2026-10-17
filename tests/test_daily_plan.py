import copy
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

import main


class DailyPlanTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.payload = {
            'latitude': 34.0522, 'longitude': -118.2437,
            'activities': [{'time': '2026-10-16T14:00', 'title': 'Play basketball', 'outdoor': True}],
        }
        self.forecast = {
            'timezone': 'America/Los_Angeles',
            'hourly': {'time': ['2026-10-16T14:00', '2026-10-16T15:00'],
                       'temperature_2m': [32, 8], 'precipitation_probability': [70, 10]},
        }

    def post(self, data=None, status=200, error=None):
        with patch.object(httpx.AsyncClient, 'get', new_callable=AsyncMock) as get:
            get.return_value = httpx.Response(status, json=self.forecast if data is None else data,
                                             request=httpx.Request('GET', 'https://api.open-meteo.com/v1/forecast'))
            get.side_effect = error
            response = self.client.post('/api/daily-plan', json=self.payload)
        return response, get

    def test_exact_response_and_shared_fetch(self):
        response, get = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            'timezone': 'America/Los_Angeles',
            'activities': [{
                'activity': self.payload['activities'][0],
                'weather': {'time': '2026-10-16T14:00', 'temperature_c': 32,
                            'temperature_f': 89.6, 'precipitation_probability': 70},
                'comfort': 'hot',
                'comfort_advice': 'Bring water and seek shade outdoors.',
                'advice': ['Bring an umbrella or consider an indoor alternative.',
                           'Stay hydrated and use sun protection.'],
            }],
        })
        get.assert_awaited_once()
        self.assertEqual(get.call_args.kwargs['params']['timezone'], 'auto')
        self.assertEqual(get.call_args.kwargs['params']['latitude'], 34.0522)

    def test_multiple_activities_order_and_cold_indoor(self):
        self.payload['activities'].insert(0, {'time': '2026-10-16T15:00', 'title': 'Study', 'outdoor': False})
        response, get = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual([a['activity']['title'] for a in response.json()['activities']], ['Study', 'Play basketball'])
        self.assertEqual(response.json()['activities'][0]['weather']['temperature_c'], 8)
        self.assertEqual(response.json()['activities'][0]['advice'], ['Bring an extra layer for your trip outside.'])
        get.assert_awaited_once()

    def test_comfort_preferences_and_context(self):
        for preference, temperature, classification in (
            ('cold_sensitive', 20, 'cold'),
            ('normal', 20, 'comfortable'),
            ('heat_sensitive', 25, 'hot'),
        ):
            for outdoor in (True, False):
                with self.subTest(preference=preference, outdoor=outdoor):
                    self.payload['preference'] = preference
                    self.payload['activities'] = [
                        {'time': '2026-10-16T14:00', 'title': 'First', 'outdoor': outdoor},
                        {'time': '2026-10-16T15:00', 'title': 'Second', 'outdoor': not outdoor},
                    ]
                    self.forecast['hourly']['temperature_2m'] = [temperature, temperature]
                    response, get = self.post()
                    self.assertEqual(response.status_code, 200)
                    results = response.json()['activities']
                    self.assertEqual(len(results), 2)
                    for activity, result in zip(self.payload['activities'], results):
                        expected = main.get_comfort(temperature, preference, activity['outdoor'])
                        self.assertEqual(result['activity'], activity)
                        self.assertEqual(result['comfort'], classification)
                        self.assertEqual(result['comfort_advice'], expected['advice'])
                        self.assertIn('weather', result)
                        self.assertIsInstance(result['advice'], list)
                    get.assert_awaited_once()

    def test_omitted_preference_matches_normal(self):
        self.forecast['hourly']['temperature_2m'][0] = 20
        default_response, _ = self.post()
        self.payload['preference'] = 'normal'
        normal_response, _ = self.post()
        self.assertEqual(default_response.status_code, 200)
        self.assertEqual(default_response.json(), normal_response.json())
        self.assertEqual(default_response.json()['activities'][0]['comfort'], 'comfortable')

    def test_invalid_preference_rejected_before_fetch(self):
        for preference in ('invalid', '', 'Normal', None, 1, True, [], {}):
            with self.subTest(preference=preference):
                self.payload['preference'] = preference
                response, get = self.post()
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()['detail'][0]['loc'], ['body', 'preference'])
                get.assert_not_awaited()

    def test_rule_thresholds_and_outdoor_context(self):
        for outdoor in (True, False):
            for temperature, rain, keyword in ((30, 0, 'hydrated'), (10, 0, 'layer'),
                                                (20, 60, 'umbrella'), (20, 59, 'No major')):
                with self.subTest(outdoor=outdoor, temperature=temperature, rain=rain):
                    self.payload['activities'][0]['outdoor'] = outdoor
                    self.forecast['hourly']['temperature_2m'][0] = temperature
                    self.forecast['hourly']['precipitation_probability'][0] = rain
                    response, _ = self.post()
                    self.assertEqual(response.status_code, 200)
                    advice = ' '.join(response.json()['activities'][0]['advice'])
                    self.assertIn(keyword, advice)
                    if not outdoor:
                        self.assertNotIn('indoor alternative', advice)

    def test_invalid_times_rejected_before_fetch(self):
        for time in ('invalid', '2026-02-30T14:00', '2026-10-16', '2026-10-16T14:30',
                     '2026-10-16T14:00Z', '2026-10-16T14:00:00', '2026-10-16T14:00-07:00'):
            with self.subTest(time=time):
                self.payload['activities'][0]['time'] = time
                response, get = self.post()
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()['detail'][0]['loc'], ['body', 'activities', 0, 'time'])
                get.assert_not_awaited()

    def test_out_of_range_rejects_whole_request(self):
        self.payload['activities'].append({'time': '2026-10-17T14:00', 'title': 'Walk', 'outdoor': True})
        response, _ = self.post()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()['detail'][0]['loc'], ['body', 'activities', 1, 'time'])
        self.assertIn('outside', response.json()['detail'][0]['msg'])

    def test_invalid_request_fields(self):
        original = copy.deepcopy(self.payload)
        for field, value in (('latitude', 91), ('longitude', -181), ('activities', [])):
            self.payload = {**original, field: value}
            response, get = self.post()
            self.assertEqual(response.status_code, 422)
            get.assert_not_awaited()
        for field, value in (('title', '  '), ('outdoor', 'unknown')):
            self.payload = copy.deepcopy(original)
            self.payload['activities'][0][field] = value
            self.assertEqual(self.post()[0].status_code, 422)
        self.payload = copy.deepcopy(original)
        del self.payload['activities'][0]['outdoor']
        self.assertEqual(self.post()[0].status_code, 422)

    def test_upstream_failures(self):
        for error, status in ((httpx.ReadTimeout('private'), 504), (httpx.ConnectError('private'), 502)):
            response, _ = self.post(error=error)
            self.assertEqual(response.status_code, status)
            self.assertNotIn('private', response.text)
        self.assertEqual(self.post(status=500)[0].status_code, 502)
        self.assertEqual(self.post(data={})[0].status_code, 502)


if __name__ == '__main__':
    unittest.main()
