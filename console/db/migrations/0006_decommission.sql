-- 0006: the command queue and the state of a node's removal.

CREATE TABLE node_commands (
  id           bigserial PRIMARY KEY,
  node_id      uuid NOT NULL REFERENCES nodes(id),
  command      text NOT NULL CHECK (command IN ('decommission', 'rotate-credential', 'upgrade', 'refresh-config')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'confirmed', 'failed', 'expired', 'cancelled')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  finished_at  timestamptz,
  result       text                         -- the agent's reason when it reports failure
);
-- At most one live command of each kind per node.
CREATE UNIQUE INDEX node_commands_one_live ON node_commands (node_id, command) WHERE status IN ('queued', 'delivered');

ALTER TABLE nodes
  ADD COLUMN decommission_requested_at   timestamptz,
  ADD COLUMN decommission_purge          boolean NOT NULL DEFAULT false,   -- the operator's choice: delete history when removal completes
  ADD COLUMN decommission_unconfirmed_at timestamptz,                      -- the agent did not confirm in time; credential revoked
  ADD COLUMN removed_via                 text CHECK (removed_via IN ('agent', 'operator')),
  ADD COLUMN removal_report              jsonb;                            -- what the agent's own verification found
