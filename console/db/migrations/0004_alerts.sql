-- 0004: alerts and their open/close history. One open alert per (rule, subject), enforced by the database.

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id),
  rule          text NOT NULL,                  -- node_stale, farm_stale; more rules arrive with US-061
  subject_type  text NOT NULL CHECK (subject_type IN ('node', 'farm', 'app', 'gateway')),
  subject_id    uuid NOT NULL,
  subject_label text NOT NULL,
  farm_id       uuid,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  silent_since  timestamptz,                    -- when the subject was last heard from; opened_at is when we noticed
  closed_at     timestamptz,
  duration_s    integer,                        -- opened_at to closed_at
  outage_s      integer,                        -- silent_since to closed_at
  close_reason  text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX alerts_one_open ON alerts (rule, subject_id) WHERE closed_at IS NULL;
CREATE INDEX alerts_org_time ON alerts (org_id, opened_at DESC);

-- Every transition, in order. Notifications (US-062) read this; it is also the alert history.
CREATE TABLE alert_events (
  id          bigserial PRIMARY KEY,
  alert_id    uuid NOT NULL REFERENCES alerts(id),
  event       text NOT NULL CHECK (event IN ('open', 'close')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_events_alert ON alert_events (alert_id);
