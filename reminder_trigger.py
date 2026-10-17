"""Capability-protected HTTP adapter for the existing one-shot worker."""
import os
import re
import secrets

from fastapi import APIRouter, Header, HTTPException

import reminder_worker

router = APIRouter()
OUTCOMES = frozenset({
    'recovered', 'sent', 'missed', 'failed', 'uncertain', 'retry',
    'expired', 'cancelled', 'skipped',
})


@router.post('/api/internal/run-reminders', include_in_schema=False)
def run_reminders(authorization: str | None = Header(default=None)):
    # A synchronous route runs in FastAPI's thread pool, not its event loop.
    secret = os.getenv('REMINDER_CRON_SECRET', '')
    # Generate with secrets.token_urlsafe(32); reject short/repetitive config.
    if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', secret) or len(set(secret)) < 16:
        raise HTTPException(503, detail='Reminder trigger is unavailable.')
    supplied = authorization or ''
    expected = f'Bearer {secret}'
    if not secrets.compare_digest(supplied.encode('utf-8'), expected.encode('ascii')):
        raise HTTPException(401, detail='Unauthorized.', headers={'WWW-Authenticate': 'Bearer'})

    # Authentication must precede engine acquisition (which can create tables).
    try:
        engine = reminder_worker.get_engine()
        if engine.dialect.name != 'postgresql':
            raise ValueError('worker_requires_postgresql')
        outcomes = reminder_worker.run_once(engine)
        # Explicit allowlist: never serialize arbitrary worker/database values.
        summary = {key: value for key, value in outcomes.items()
                   if key in OUTCOMES and type(value) is int and value >= 0}
    except Exception:
        # Exception messages may contain database URLs or push credentials.
        raise HTTPException(503, detail='Reminder execution failed; retry safely.') from None
    return {'outcomes': summary}
