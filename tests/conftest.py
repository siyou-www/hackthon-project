"""Never run destructive database tests against a remote/production database."""
import os

import pytest
from sqlalchemy.engine import make_url


def pytest_sessionstart(session):
    value = os.getenv('PUSH_TEST_DATABASE_URL')
    if value:
        try:
            url = make_url(value)
            safe = (url.get_backend_name() == 'postgresql'
                    and url.host in ('127.0.0.1', 'localhost', '::1')
                    and url.database == 'daycast_worker_test'
                    and not url.query)  # No query-level host/service overrides.
        except Exception:
            safe = False
        if not safe:
            pytest.exit('Refusing test database: use loopback PostgreSQL database daycast_worker_test only.', returncode=2)
