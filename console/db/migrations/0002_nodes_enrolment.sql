-- 0002: enrolments, nodes, node credentials, node configuration versions.

CREATE TABLE enrolments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id),
  farm_id       uuid NOT NULL REFERENCES farms(id),
  token_hash    text NOT NULL UNIQUE,
  platform      text NOT NULL CHECK (platform IN ('ubuntu', 'macos')),
  display_name  text,
  initial_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  cancelled_at  timestamptz,
  node_id       uuid
);
CREATE INDEX enrolments_farm_idx ON enrolments (farm_id);

CREATE TABLE nodes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organisations(id),
  farm_id                uuid NOT NULL REFERENCES farms(id),
  display_name           text NOT NULL,
  platform               text NOT NULL CHECK (platform IN ('ubuntu', 'macos')),
  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','healthy','degraded','stale','expected-offline','decommissioning','removed')),
  hostname               text,
  os_version             text,
  agent_version          text,
  desired_config_version integer NOT NULL DEFAULT 1,
  last_heartbeat_at      timestamptz,
  enrolled_at            timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz
);
CREATE INDEX nodes_farm_idx ON nodes (farm_id);

ALTER TABLE enrolments ADD CONSTRAINT enrolments_node_fk FOREIGN KEY (node_id) REFERENCES nodes(id);

CREATE TABLE node_credentials (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id    uuid NOT NULL REFERENCES nodes(id),
  hash       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX node_credentials_node_idx ON node_credentials (node_id);

CREATE TABLE node_configs (
  node_id    uuid NOT NULL REFERENCES nodes(id),
  version    integer NOT NULL,
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY (node_id, version)
);
