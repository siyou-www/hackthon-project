-- Apply after 001_activity_reminders.sql, before starting the Phase 2 worker/API.
BEGIN;
ALTER TABLE activity_reminders ADD COLUMN IF NOT EXISTS lease_token VARCHAR(36);
ALTER TABLE activity_reminders ADD COLUMN IF NOT EXISTS push_started_at TIMESTAMP WITH TIME ZONE;
COMMIT;
