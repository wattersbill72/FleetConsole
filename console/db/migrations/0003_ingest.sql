-- 0003: snapshots, per-node ingest rate buckets, latest-state columns on nodes.

CREATE TABLE snapshots (
  id               bigserial PRIMARY KEY,
  node_id          uuid NOT NULL REFERENCES nodes(id),
  seq              bigint NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),   -- authoritative for ordering and staleness
  node_time        timestamptz NOT NULL,                 -- kept for diagnosis only
  replayed         boolean NOT NULL DEFAULT false,
  config_version   integer NOT NULL,
  -- Columns for charting and the overview. NULL means unavailable on that platform, never zero.
  cpu_pct          real,
  load1            real,
  mem_used_bytes   bigint,
  mem_total_bytes  bigint,
  uptime_s         bigint NOT NULL,
  disk_worst_pct   real,
  -- Everything else in the Snapshot (disks, addresses, services, sovereignai, error tail, agent health).
  detail           jsonb NOT NULL,
  UNIQUE (node_id, seq)            -- idempotency: a replayed or duplicated Snapshot is one record
);
CREATE INDEX snapshots_node_time ON snapshots (node_id, received_at DESC);
CREATE INDEX snapshots_received ON snapshots (received_at);   -- retention purge (US-070)

CREATE TABLE ingest_rate (
  node_id uuid NOT NULL REFERENCES nodes(id),
  bucket  timestamptz NOT NULL,
  n       integer NOT NULL,
  PRIMARY KEY (node_id, bucket)
);

ALTER TABLE nodes
  ADD COLUMN last_seq               bigint,
  ADD COLUMN applied_config_version integer,
  ADD COLUMN latest                 jsonb;
