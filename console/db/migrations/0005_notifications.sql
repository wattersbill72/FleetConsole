-- 0005: notification targets and the outbox that delivers alert transitions to them.

CREATE TABLE notification_targets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id),
  channel    text NOT NULL,                         -- 'email' now; a second channel is a new value here (OD-2)
  address    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notification_targets_unique ON notification_targets (org_id, channel, lower(address));

-- One row per (alert transition, target). Written in the same transaction as the transition,
-- so an alert and its notification intent commit together. Delivery happens afterwards.
CREATE TABLE notifications (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organisations(id),
  alert_event_id   bigint REFERENCES alert_events(id),
  kind             text NOT NULL CHECK (kind IN ('alert_open', 'alert_close', 'test')),
  channel          text NOT NULL,
  recipient        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  provider_id      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
-- A transition notifies a given target once, however often the work is retried or re-run.
CREATE UNIQUE INDEX notifications_once ON notifications (alert_event_id, channel, recipient) WHERE alert_event_id IS NOT NULL;
CREATE INDEX notifications_due ON notifications (next_attempt_at) WHERE status = 'pending';
CREATE INDEX notifications_org_time ON notifications (org_id, created_at DESC);
