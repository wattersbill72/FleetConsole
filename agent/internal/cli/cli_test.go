package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fleetconsole/agent/internal/collect"
	"fleetconsole/agent/internal/install"
	"fleetconsole/agent/internal/state"
)

type svc struct{ active string }

func (s svc) Reload() error          { return nil }
func (s svc) EnableNow() error       { return nil }
func (s svc) DisableNow() error      { return nil }
func (s svc) Restart() error         { return nil }
func (s svc) Status() (string, bool) { return s.active, s.active == "active" }

type noUsers struct{}

func (noUsers) Exists(string) bool            { return false }
func (noUsers) Ensure(string) (bool, error)   { return false, nil }
func (noUsers) Remove(string) error           { return nil }
func (noUsers) ChownAll(string, string) error { return nil }

func rig(t *testing.T, consoleURL string, active string) (*Env, *bytes.Buffer, install.Layout) {
	root := t.TempDir()
	l := install.Layout{
		BinPath: filepath.Join(root, "fleetagent"), StateDir: filepath.Join(root, "state"),
		UnitPath: filepath.Join(root, "fleetagent.service"),
	}
	out := &bytes.Buffer{}
	st := state.New(l.StateDir)
	cred := "fcn_" + strings.Repeat("b", 43)
	cfg := `{"version":3,"heartbeat_interval_s":60,"gateway":{"api_token":"supersecret","url":"x"},"list":[{"password":"p"}]}`
	if err := st.SaveEnrolment(state.Identity{NodeID: "node-9", ConsoleURL: consoleURL, FarmName: "home"}, cred, []byte(cfg)); err != nil {
		t.Fatal(err)
	}
	e := &Env{Install: &install.Env{L: l, Svc: svc{active}, Users: noUsers{}, Out: out, Version: "1.0"}, Version: "1.0", Out: out}
	return e, out, l
}

func TestStatusShowsEveryRequiredField(t *testing.T) {
	e, out, l := rig(t, "https://console.example", "active")
	state.New(l.StateDir).WriteStatus(state.Status{Version: "1.0", LastSuccess: "2026-11-24T10:00:00Z", ConfigVersion: 3, BufferDepth: 4, LastError: "rate limited", LastErrorAt: "2026-11-24T09:00:00Z"})
	if err := e.Status(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"1.0", "node-9", "home", "https://console.example", "active", "2026-11-24T10:00:00Z", "version 3", "Buffer depth:         4", "rate limited"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out.String(), "fcn_") {
		t.Fatal("credential printed")
	}
}

func TestStatusBeforeFirstHeartbeatAndWhenNotEnrolled(t *testing.T) {
	e, out, _ := rig(t, "https://c", "inactive")
	e.Status()
	if !strings.Contains(out.String(), "none recorded yet") {
		t.Fatal(out.String())
	}
	e2 := &Env{Install: &install.Env{L: install.Layout{StateDir: t.TempDir()}, Svc: svc{"inactive"}, Users: noUsers{}}, Version: "1.0", Out: out}
	out.Reset()
	if err := e2.Status(); err != nil || !strings.Contains(out.String(), "Not enrolled") {
		t.Fatalf("%v %s", err, out)
	}
}

func TestConfigMasksSecretsAtAnyDepthAndNeverShowsTheCredential(t *testing.T) {
	e, out, _ := rig(t, "https://c", "active")
	if err := e.Config(); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	if strings.Contains(s, "supersecret") || strings.Contains(s, `"p"`) || strings.Contains(s, "fcn_") {
		t.Fatalf("secret shown:\n%s", s)
	}
	if !strings.Contains(s, "********") || !strings.Contains(s, `"heartbeat_interval_s": 60`) || !strings.Contains(s, `"url": "x"`) {
		t.Fatalf("masking wrong:\n%s", s)
	}
}

func TestSelfcheckPassesOnAGoodInstallAndFailsOnEachProblem(t *testing.T) {
	e, out, l := rig(t, "https://c", "active")
	os.WriteFile(l.BinPath, []byte("x"), 0o755)
	os.WriteFile(l.UnitPath, l.Unit(), 0o644)
	if err := e.Selfcheck(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}

	for _, name := range []string{
		"program writable by others", "program missing", "unit edited", "credential world-readable",
		"state dir open", "credential malformed", "service stopped",
	} {
		t.Run(name, func(t *testing.T) {
			e, out, l := rig(t, "https://c", "active")
			os.WriteFile(l.BinPath, []byte("x"), 0o755)
			os.WriteFile(l.UnitPath, l.Unit(), 0o644)
			switch name { // each case breaks its own fresh, otherwise-good installation
			case "program writable by others":
				os.Chmod(l.BinPath, 0o777)
			case "program missing":
				os.Remove(l.BinPath)
			case "unit edited":
				os.WriteFile(l.UnitPath, []byte("tampered"), 0o644)
			case "credential world-readable":
				os.Chmod(filepath.Join(l.StateDir, "credential"), 0o644)
			case "state dir open":
				os.Chmod(l.StateDir, 0o755)
			case "credential malformed":
				os.WriteFile(filepath.Join(l.StateDir, "credential"), []byte("nope"), 0o600)
			case "service stopped":
				e.Install.Svc = svc{"failed"}
			}
			if err := e.Selfcheck(); err == nil || !strings.Contains(out.String(), "FAIL") {
				t.Fatalf("expected failure for %q:\n%s", name, out)
			}
		})
	}
}

func TestConnectivityTestReportsEachStepAndStopsAtTheFirstFailure(t *testing.T) {
	if _, _, err := collect.Platform(); err != nil {
		t.Skip("needs Ubuntu to collect a real snapshot")
	}
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/ingest/ping":
			w.Write([]byte(`{"ok":true}`))
		case "/api/ingest/snapshot":
			w.Write([]byte(`{"ok":true,"duplicate":false,"last_seq":1,"desired_config_version":3,"commands":[]}`))
		}
	}))
	defer ok.Close()
	e, out, _ := rig(t, ok.URL, "active")
	if err := e.Test(context.Background()); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for _, step := range []string{"Name resolution", "Console reachable", "Credential accepted", "Snapshot accepted"} {
		if !strings.Contains(out.String(), "[PASS] "+step) {
			t.Errorf("step %q did not pass:\n%s", step, out)
		}
	}

	// Credential rejected: later steps are skipped, exit is an error, and the reason is specific.
	rejecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"Unauthorized"}`))
	}))
	defer rejecting.Close()
	e2, out2, _ := rig(t, rejecting.URL, "active")
	if err := e2.Test(context.Background()); err == nil {
		t.Fatal("expected failure")
	}
	s := out2.String()
	if !strings.Contains(s, "[PASS] Console reachable") || !strings.Contains(s, "[FAIL] Credential accepted") ||
		!strings.Contains(s, "revoked") || !strings.Contains(s, "[SKIP] Snapshot accepted") {
		t.Fatalf("%s", s)
	}

	// Nothing listening: reach fails, credential steps skipped.
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	e3, out3, _ := rig(t, url, "active")
	if err := e3.Test(context.Background()); err == nil || !strings.Contains(out3.String(), "[FAIL] Console reachable") || !strings.Contains(out3.String(), "[SKIP] Credential accepted") {
		t.Fatalf("%v\n%s", err, out3)
	}
}

func TestHelpListsEveryCommandIncludingRemoval(t *testing.T) {
	h := Help()
	for _, c := range []string{"enrol", "run", "install", "uninstall", "status", "test", "config", "selfcheck", "version", "help"} {
		if !strings.Contains(h, "fleetagent "+c) {
			t.Errorf("help lacks %q", c)
		}
	}
}
