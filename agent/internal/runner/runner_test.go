package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fleetconsole/agent/internal/api"
	"fleetconsole/agent/internal/collect"
	"fleetconsole/agent/internal/state"
)

type fakeCollector struct{ host collect.Host }

func (f fakeCollector) Collect(ctx context.Context, v []string) collect.Host { return f.host }

type fixture struct {
	t      *testing.T
	store  *state.Store
	srv    *httptest.Server
	logs   *bytes.Buffer
	bodies []map[string]any
	auth   []string
	reply  func(seq int64) (int, map[string]any, map[string]string) // status, body, headers
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{t: t, logs: &bytes.Buffer{}}
	f.reply = func(seq int64) (int, map[string]any, map[string]string) {
		return 200, map[string]any{"ok": true, "duplicate": false, "last_seq": seq, "desired_config_version": 1, "commands": []any{}}, nil
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(b, &m)
		f.bodies = append(f.bodies, m)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		seq := int64(m["envelope"].(map[string]any)["seq"].(float64))
		status, body, hdr := f.reply(seq)
		for k, v := range hdr {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(f.srv.Close)
	f.store = state.New(filepath.Join(t.TempDir(), "s"))
	if err := f.store.SaveEnrolment(state.Identity{NodeID: "node-1", ConsoleURL: f.srv.URL}, "fcn_cred", []byte(`{"version":1,"heartbeat_interval_s":60}`)); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) runner(h collect.Host) *Runner {
	cl, err := api.New(f.srv.URL, "t")
	if err != nil {
		f.t.Fatal(err)
	}
	return &Runner{
		Store: f.store, Client: cl, Collector: fakeCollector{h}, Version: "9.9.9",
		Log: log.New(f.logs, "", 0),
		Now: func() time.Time { return time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC) },
	}
}

var cpu = 12.5

func healthyHost() collect.Host {
	used, total := int64(4e9), int64(16e9)
	return collect.Host{Hostname: "dell01", OS: "ubuntu", OSVersion: "24.04", UptimeS: 1000, CPUPct: &cpu,
		MemUsedBytes: &used, MemTotalBytes: &total, Disks: []collect.Disk{{Mount: "/", UsedBytes: 1, TotalBytes: 2}}, Addresses: []string{"10.0.0.2"}}
}

func TestHeartbeatBodyMatchesSnapshotV1(t *testing.T) {
	f := newFixture(t)
	if _, err := f.runner(healthyHost()).Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	b := f.bodies[0]
	env := b["envelope"].(map[string]any)
	if b["schema_version"] != float64(1) || env["node_id"] != "node-1" || env["agent_version"] != "9.9.9" ||
		env["seq"] != float64(1) || env["replayed"] != false || env["applied_config_version"] != float64(1) ||
		env["node_time"] != "2026-11-24T10:00:00Z" {
		t.Fatalf("envelope %v", env)
	}
	host := b["host"].(map[string]any)
	if host["cpu_pct"] != 12.5 || host["hostname"] != "dell01" || host["load"] != nil || host["temperature_c"] != nil {
		t.Fatalf("host %v", host)
	}
	if b["agent_health"].(map[string]any)["buffer_depth"] != float64(0) {
		t.Fatal("agent_health")
	}
	if f.auth[0] != "Bearer fcn_cred" {
		t.Fatalf("auth %q", f.auth[0])
	}
}

func TestSequenceIncreasesAndSurvivesRestart(t *testing.T) {
	f := newFixture(t)
	f.runner(healthyHost()).Once(context.Background())
	f.runner(healthyHost()).Once(context.Background()) // a "restarted" agent: new Runner, same directory
	f.runner(healthyHost()).Once(context.Background())
	var seqs []float64
	for _, b := range f.bodies {
		seqs = append(seqs, b["envelope"].(map[string]any)["seq"].(float64))
	}
	if seqs[0] != 1 || seqs[1] != 2 || seqs[2] != 3 {
		t.Fatalf("%v", seqs)
	}
}

func TestLostCounterJumpsPastTheConsolesLastSeq(t *testing.T) {
	f := newFixture(t)
	f.reply = func(seq int64) (int, map[string]any, map[string]string) {
		if seq <= 50 {
			return 200, map[string]any{"ok": true, "duplicate": true, "last_seq": 50, "desired_config_version": 1, "commands": []any{}}, nil
		}
		return 200, map[string]any{"ok": true, "duplicate": false, "last_seq": seq, "desired_config_version": 1, "commands": []any{}}, nil
	}
	r := f.runner(healthyHost())
	r.Once(context.Background()) // seq 1 collides with stored 50
	r.Once(context.Background())
	if got := f.bodies[1]["envelope"].(map[string]any)["seq"]; got != float64(51) {
		t.Fatalf("next seq %v", got)
	}
}

func TestProblemsAreLoggedOnceAndRecoveryIsLogged(t *testing.T) {
	f := newFixture(t)
	status := 401
	f.reply = func(seq int64) (int, map[string]any, map[string]string) {
		if status == 401 {
			return 401, map[string]any{"error": "Unauthorized"}, nil
		}
		return 200, map[string]any{"ok": true, "last_seq": seq, "desired_config_version": 1, "commands": []any{}}, nil
	}
	r := f.runner(healthyHost())
	ctx := context.Background()
	r.cycle(ctx)
	r.cycle(ctx)
	r.cycle(ctx)
	if n := strings.Count(f.logs.String(), "credential rejected"); n != 1 {
		t.Fatalf("logged %d times:\n%s", n, f.logs.String())
	}
	status = 200
	r.cycle(ctx)
	if !strings.Contains(f.logs.String(), "recovered") {
		t.Fatalf("no recovery line:\n%s", f.logs.String())
	}
	if strings.Contains(f.logs.String(), "fcn_cred") {
		t.Fatal("credential leaked to the log")
	}
}

func TestRetryAfterLongerThanTheIntervalIsHonoured(t *testing.T) {
	f := newFixture(t)
	f.reply = func(seq int64) (int, map[string]any, map[string]string) {
		return 429, map[string]any{"error": "Rate limit exceeded"}, map[string]string{"Retry-After": "300"}
	}
	if wait := f.runner(healthyHost()).cycle(context.Background()); wait != 300*time.Second {
		t.Fatalf("wait %v", wait)
	}
}

func TestIntervalComesFromConfigAndNetworkErrorsDoNotCrash(t *testing.T) {
	f := newFixture(t)
	f.srv.Close() // console unreachable
	r := f.runner(healthyHost())
	if wait := r.cycle(context.Background()); wait != 60*time.Second {
		t.Fatalf("wait %v", wait)
	}
	if !strings.Contains(f.logs.String(), "heartbeat failed") {
		t.Fatal("expected a failure line")
	}
}

func TestNewerConsoleConfigIsNoticedOnce(t *testing.T) {
	f := newFixture(t)
	f.reply = func(seq int64) (int, map[string]any, map[string]string) {
		return 200, map[string]any{"ok": true, "last_seq": seq, "desired_config_version": 4, "commands": []any{}}, nil
	}
	r := f.runner(healthyHost())
	r.Once(context.Background())
	r.Once(context.Background())
	if n := strings.Count(f.logs.String(), "configuration version 4"); n != 1 {
		t.Fatalf("noticed %d times", n)
	}
}

func TestRunStopsPromptlyOnCancel(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { done <- f.runner(healthyHost()).Run(ctx) }()
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
	if len(f.bodies) < 1 {
		t.Fatal("first heartbeat must be immediate")
	}
}

func TestStatusFileRecordsSuccessAndLastError(t *testing.T) {
	f := newFixture(t)
	r := f.runner(healthyHost())
	r.cycle(context.Background())
	st, err := f.store.ReadStatus()
	if err != nil || st.LastSuccess != "2026-11-24T10:00:00Z" || st.LastError != "" || st.ConfigVersion != 1 || st.Version != "9.9.9" {
		t.Fatalf("%+v %v", st, err)
	}
	f.reply = func(seq int64) (int, map[string]any, map[string]string) {
		return 401, map[string]any{"error": "Unauthorized"}, nil
	}
	r.cycle(context.Background())
	st, _ = f.store.ReadStatus()
	if !strings.Contains(st.LastError, "credential rejected") || st.LastSuccess == "" {
		t.Fatalf("%+v", st)
	}
	if err := f.store.CheckPermissions(); err != nil {
		t.Fatal(err)
	}
}
