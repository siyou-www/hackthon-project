"""Security invariants for the secret-bearing schedule; never execute an Actions job."""
from pathlib import Path
import re

import yaml

WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/daycast-reminders.yml'


def load():
    # BaseLoader preserves GitHub's `on` key instead of YAML 1.1 boolean coercion.
    return yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)


def test_schedule_is_offset_and_has_no_untrusted_pr_or_push_triggers():
    workflow = load()
    assert set(workflow['on']) == {'schedule', 'workflow_dispatch'}
    assert workflow['on']['schedule'] == [{'cron': '2-57/5 * * * *'}]
    condition = workflow['jobs']['reminders']['if']
    assert "github.repository == 'siyou-www/hackthon-project' &&" in condition
    assert "github.ref == 'refs/heads/main' &&" in condition
    assert "github.event_name == 'schedule' && vars.DAYCAST_REMINDERS_ENABLED == 'true'" in condition
    assert "github.event_name == 'workflow_dispatch' ||" in condition


def test_secrets_are_only_in_worker_step_and_no_artifacts_are_uploaded():
    workflow = load()
    assert 'env' not in workflow
    job = workflow['jobs']['reminders']
    assert 'env' not in job
    steps = job['steps']
    worker = steps[-1]
    assert worker['run'] == 'python -m reminder_worker --limit 20'
    assert set(worker['env']) == {'PUSH_DATABASE_URL', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT'}
    for name, value in worker['env'].items():
        assert value == '${{ secrets.' + name + ' }}'
    for step in steps[:-1]:
        assert 'secrets.' not in str(step)
        assert 'env' not in step
        assert 'upload-artifact' not in step.get('uses', '')


def test_readonly_token_immutable_actions_and_serial_non_cancelling_jobs():
    workflow = load()
    assert workflow['permissions'] == {'contents': 'read'}
    assert workflow['concurrency'] == {'group': 'daycast-reminder-worker', 'cancel-in-progress': 'false'}
    job = workflow['jobs']['reminders']
    assert job['runs-on'] == 'ubuntu-latest'
    assert job['environment'] == 'daycast-reminders'
    assert int(job['timeout-minutes']) == 5
    checkout, python = job['steps'][:2]
    for step in (checkout, python):
        assert re.fullmatch(r'actions/(checkout|setup-python)@[0-9a-f]{40}', step['uses'])
    assert checkout['with']['persist-credentials'] == 'false'
    assert 'ref' not in checkout['with']  # Event's main SHA, never a PR/user-selected ref.
    assert python['with']['python-version'] == '3.12'
