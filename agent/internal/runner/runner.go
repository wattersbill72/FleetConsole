// Package runner is the heartbeat loop: collect, send, handle the console's answer.
package runner

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"fleetconsole/agent/internal/api"
	"fleetconsole/agent/internal/collect"
	"fleetconsole/agent/internal/state"
)

type Collector interface {
	Collect(ctx context.Context, volumes []string) collect.Host
}

type Runner struct {
	Store     *state.Store
	Client    *api.Client
	Collector Collector
	Version   string
	Log       *log.Logger
	// Now is injectable for tests.
	Now func() time.Time

	lastProblem string
	noticedCfg  int
	status      state.Status
}

type envelope struct {
	NodeID               string `json:"node_id"`
	AgentVersion         string `json:"agent_version"`
	AppliedConfigVersion int    `json:"applied_config_version"`
	NodeTime             string `json:"node_time"`
	Seq                  int64  `json:"seq"`
	Replayed             bool   `json:"replayed"`
}

type agentHealth struct {
	BufferDepth  int    `json:"buffer_depth"`
	DroppedCount int    `json:"dropped_count"`
	LogShipping  string `json:"log_shipping"`
}

// snapshot is Snapshot v1 (contracts/snapshot.v1.schema.json). Groups that need later stories
// (services, sovereignai, error_tail) are omitted, which the contract allows.
type snapshot struct {
	SchemaVersion int          `json:"schema_version"`
	Envelope      envelope     `json:"envelope"`
	Host          collect.Host `json:"host"`
	AgentHealth   agentHealth  `json:"agent_health"`
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Once performs a single heartbeat.
func (r *Runner) Once(ctx context.Context) (*api.SnapshotResponse, error) {
	id, err := r.Store.LoadIdentity()
	if err != nil {
		return nil, err
	}
	cred, err := r.Store.LoadCredential()
	if err != nil {
		return nil, err
	}
	cfg, err := r.Store.LoadConfig()
	if err != nil {
		return nil, err
	}

	host := r.Collector.Collect(ctx, cfg.DiskVolumes)
	seq, err := r.Store.NextSeq()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(snapshot{
		SchemaVersion: 1,
		Envelope: envelope{
			NodeID: id.NodeID, AgentVersion: r.Version, AppliedConfigVersion: cfg.Version,
			NodeTime: r.now().UTC().Format(time.RFC3339), Seq: seq,
		},
		Host:        host,
		AgentHealth: agentHealth{LogShipping: "off"},
	})
	if err != nil {
		return nil, err
	}

	resp, err := r.Client.SendSnapshot(ctx, cred, body)
	if err != nil {
		return nil, err
	}
	// The console already holds a Snapshot with this number (we lost or reset our counter): jump past it.
	if resp.Duplicate && resp.LastSeq >= seq {
		if err := r.Store.AdvanceSeqTo(resp.LastSeq); err != nil {
			return resp, err
		}
	}
	if resp.DesiredConfigVersion != cfg.Version && r.noticedCfg != resp.DesiredConfigVersion {
		// Fetching and applying new configuration arrives with US-020.
		r.noticedCfg = resp.DesiredConfigVersion
		r.Log.Printf("console has configuration version %d; running %d (applying changes is not supported by this agent version)", resp.DesiredConfigVersion, cfg.Version)
	}
	return resp, nil
}

// OnceRecorded is Once plus the status file, for `run --once` and anything else that should leave a record.
func (r *Runner) OnceRecorded(ctx context.Context) (*api.SnapshotResponse, error) {
	resp, err := r.Once(ctx)
	r.recordStatus(err)
	return resp, err
}

// Run heartbeats at the configured interval until ctx is cancelled. The first heartbeat is immediate.
func (r *Runner) Run(ctx context.Context) error {
	for {
		wait := r.cycle(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// cycle runs one heartbeat, reports state changes in the log, and returns how long to wait.
func (r *Runner) cycle(ctx context.Context) time.Duration {
	interval := 60 * time.Second
	if cfg, err := r.Store.LoadConfig(); err == nil {
		interval = time.Duration(cfg.HeartbeatIntervalS) * time.Second
	}

	_, err := r.Once(ctx)
	r.recordStatus(err)
	if err == nil {
		if r.lastProblem != "" {
			r.Log.Printf("recovered: heartbeat accepted")
			r.lastProblem = ""
		}
		return interval
	}
	if ctx.Err() != nil {
		return interval
	}

	problem := Describe(err)
	if problem != r.lastProblem { // log a problem when it starts or changes, not every minute
		r.Log.Printf("heartbeat failed: %s", problem)
		r.lastProblem = problem
	}
	var apiErr *api.Error
	if errors.As(err, &apiErr) && apiErr.RetryAfter > interval {
		return apiErr.RetryAfter
	}
	return interval
}

// Describe turns an error into the sentence an operator should read.
func Describe(err error) string {
	var apiErr *api.Error
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case 401:
			return "credential rejected by the console (node removed or credential revoked)"
		case 429:
			return "rate limited by the console"
		}
		return apiErr.Message
	}
	return err.Error()
}

// recordStatus keeps status.json current for `fleetagent status`. It never fails a heartbeat.
func (r *Runner) recordStatus(err error) {
	now := r.now().UTC().Format(time.RFC3339)
	if r.status.StartedAt == "" {
		r.status.StartedAt = now
	}
	r.status.Version = r.Version
	if cfg, cerr := r.Store.LoadConfig(); cerr == nil {
		r.status.ConfigVersion = cfg.Version
	}
	if err == nil {
		r.status.LastSuccess = now
	} else {
		r.status.LastError = Describe(err)
		r.status.LastErrorAt = now
	}
	if werr := r.Store.WriteStatus(r.status); werr != nil {
		r.Log.Printf("could not write status file: %v", werr)
	}
}
