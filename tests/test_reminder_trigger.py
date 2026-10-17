"""HTTP adapter tests: never acquire a real database or send a notification."""
import asyncio
import secrets
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import main
import reminder_trigger as trigger


@pytest.fixture
def setup(monkeypatch):
    secret = secrets.token_urlsafe(32)
    monkeypatch.setenv('REMINDER_CRON_SECRET', secret)
    engine = Mock(return_value=SimpleNamespace(dialect=SimpleNamespace(name='postgresql')))
    worker = Mock(return_value={'recovered': 0, 'sent': 1})
    monkeypatch.setattr(trigger.reminder_worker, 'get_engine', engine)
    monkeypatch.setattr(trigger.reminder_worker, 'run_once', worker)
    return TestClient(main.app), {'Authorization': f'Bearer {secret}'}, engine, worker


@pytest.mark.parametrize('headers', [None, {'Authorization': 'Bearer incorrect'},
                                    {'Authorization': 'Basic incorrect'}])
def test_rejects_before_database_or_worker(setup, headers):
    client, _, engine, worker = setup
    response = client.post('/api/internal/run-reminders', headers=headers)
    assert response.status_code == 401
    assert response.json() == {'detail': 'Unauthorized.'}
    engine.assert_not_called()
    worker.assert_not_called()


@pytest.mark.parametrize('secret', ['', 'short', 'a' * 64, 'not valid ' * 8])
def test_fails_closed_with_missing_or_weak_configuration(setup, monkeypatch, secret):
    client, headers, engine, worker = setup
    monkeypatch.setenv('REMINDER_CRON_SECRET', secret)
    assert client.post('/api/internal/run-reminders', headers=headers).status_code == 503
    engine.assert_not_called()
    worker.assert_not_called()


def test_authorized_execution_off_event_loop_and_safe_summary(setup):
    client, headers, engine, worker = setup
    def execute(actual_engine):
        assert actual_engine is engine.return_value
        with pytest.raises(RuntimeError):
            asyncio.get_running_loop()
        return {'recovered': 0, 'sent': 2, 'skipped': 1,
                'subscription': 'sensitive', 'failed': 'sensitive', 'retry': -1}
    worker.side_effect = execute
    response = client.post('/api/internal/run-reminders', headers=headers)
    assert response.status_code == 200
    assert response.json() == {'outcomes': {'recovered': 0, 'sent': 2, 'skipped': 1}}
    engine.assert_called_once_with()
    worker.assert_called_once_with(engine.return_value)


@pytest.mark.parametrize('failure_at', ['engine', 'worker'])
def test_failures_are_redacted(setup, caplog, failure_at):
    client, headers, engine, worker = setup
    target = engine if failure_at == 'engine' else worker
    target.side_effect = RuntimeError('private-database-url-and-subscription')
    response = client.post('/api/internal/run-reminders', headers=headers)
    assert response.status_code == 503
    assert response.json() == {'detail': 'Reminder execution failed; retry safely.'}
    assert 'private-database-url-and-subscription' not in response.text + caplog.text
    assert headers['Authorization'] not in response.text + caplog.text


def test_non_post_methods_and_query_secrets_do_not_run(setup):
    client, headers, engine, worker = setup
    for method in ('get', 'put', 'delete', 'patch'):
        assert getattr(client, method)('/api/internal/run-reminders', headers=headers).status_code == 405
    assert client.post('/api/internal/run-reminders', params={'secret': 'not-accepted'}).status_code == 401
    engine.assert_not_called()
    worker.assert_not_called()


def test_requires_postgresql(setup):
    client, headers, engine, worker = setup
    engine.return_value.dialect.name = 'sqlite'
    assert client.post('/api/internal/run-reminders', headers=headers).status_code == 503
    worker.assert_not_called()
