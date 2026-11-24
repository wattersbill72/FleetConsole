-- 0001: organisations, users, sessions, login throttle, farms, audit events.
-- Applied by `npm run migrate` (ledger: schema_migrations).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organisations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  product_name text NOT NULL DEFAULT 'Fleet Console',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id),
  username      text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE login_attempts (
  id           bigserial PRIMARY KEY,
  username     text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  succeeded    boolean NOT NULL
);
CREATE INDEX login_attempts_lookup ON login_attempts (lower(username), attempted_at);

CREATE TABLE farms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  time_zone   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX farms_org_name_key ON farms (org_id, lower(name));

-- Audit events survive the removal of what they describe (US-071, US-025):
-- no foreign keys to farms or users; subject is a type + id + label.
CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid,
  actor_user_id uuid,
  actor_label   text NOT NULL,
  action        text NOT NULL,
  subject_type  text,
  subject_id    text,
  subject_label text,
  outcome       text NOT NULL CHECK (outcome IN ('success', 'failure')),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time ON audit_events (org_id, occurred_at DESC);
CREATE INDEX audit_events_subject ON audit_events (subject_type, subject_id);
