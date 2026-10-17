-- Additive migration; push_subscriptions must already exist.
BEGIN;

CREATE TABLE IF NOT EXISTS activity_reminders (
	id VARCHAR(36) NOT NULL,
	subscription_id VARCHAR(36) NOT NULL,
	activity_id VARCHAR(36) NOT NULL,
	title VARCHAR(200) NOT NULL,
	outdoor BOOLEAN NOT NULL,
	latitude FLOAT NOT NULL,
	longitude FLOAT NOT NULL,
	preference VARCHAR(20) NOT NULL,
	timezone VARCHAR(64) NOT NULL,
	starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
	due_at TIMESTAMP WITH TIME ZONE NOT NULL,
	status VARCHAR(16) NOT NULL,
	attempt_count INTEGER NOT NULL,
	next_attempt_at TIMESTAMP WITH TIME ZONE,
	lease_until TIMESTAMP WITH TIME ZONE,
	last_attempt_at TIMESTAMP WITH TIME ZONE,
	sent_at TIMESTAMP WITH TIME ZONE,
	cancelled_at TIMESTAMP WITH TIME ZONE,
	last_error_code VARCHAR(64),
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_reminder_subscription_activity UNIQUE (subscription_id, activity_id),
	CONSTRAINT ck_reminder_latitude CHECK (latitude >= -90 AND latitude <= 90),
	CONSTRAINT ck_reminder_longitude CHECK (longitude >= -180 AND longitude <= 180),
	CONSTRAINT ck_reminder_preference CHECK (preference IN ('cold_sensitive', 'normal', 'heat_sensitive')),
	CONSTRAINT ck_reminder_status CHECK (status IN ('pending', 'processing', 'retry', 'sent', 'cancelled', 'missed', 'failed', 'uncertain')),
	CONSTRAINT ck_reminder_attempts CHECK (attempt_count >= 0),
	CONSTRAINT ck_reminder_due CHECK (due_at < starts_at),
	FOREIGN KEY(subscription_id) REFERENCES push_subscriptions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_reminder_due ON activity_reminders (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS ix_reminder_lease ON activity_reminders (status, lease_until);

COMMIT;
