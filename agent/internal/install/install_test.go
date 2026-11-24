package install

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"fleetconsole/agent/internal/collect"
)

// ---- fakes ----

type fakeSvc struct {
	reloads, restarts int
	enabled, active   bool
	failEnable        error
}

func (f *fakeSvc) Reload() error { f.reloads++; return nil }
func (f *fakeSvc) EnableNow() error {
	if f.failEnable != nil {
		return f.failEnable
	}
	f.enabled, f.active = true, true
	return nil
}
func (f *fakeSvc) DisableNow() error { f.enabled, f.active = false, false; return nil }
func (f *fakeSvc) Restart() error    { f.restarts++; return nil }
func (f *fakeSvc) Status() (string, bool) {
	if f.active {
		return "active", f.enabled
	}
	return "inactive", f.enabled
}

type fakeUsers struct {
	have       map[string]bool
	failChown  error
	failCreate error
}

func (f *fakeUsers) Exists(n string) bool { return f.have[n] }
func (f *fakeUsers) Ensure(n string) (bool, error) {
	if f.failCreate != nil {
		return false, f.failCreate
	}
	if f.have[n] {
		return false, nil
	}
	f.have[n] = true
	return true, nil
}
func (f *fakeUsers) Remove(n string) error         { delete(f.have, n); return nil }
func (f *fakeUsers) ChownAll(string, string) error { return f.failChown }

// ---- console stub ----

type console struct {
	srv         *httptest.Server
	enrols      atomic.Int32
	removed     atomic.Int32
	removedBy   atomic.Value
	removedBody atomic.Value
	enrolFail   int // HTTP status to return for /api/enrol, 0 = success
}

func newConsole(t *testing.T) *console {
	c := &console{}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/enrol":
			c.enrols.Add(1)
			if c.enrolFail != 0 {
				w.WriteHeader(c.enrolFail)
				w.Write([]byte(`{"code":"token_used","error":"This enrolment token has already been used."}`))
				return
			}
			w.WriteHeader(201)
			w.Write([]byte(`{"node_id":"11111111-1111-4111-8111-111111111111","credential":"fcn_` + strings.Repeat("a", 43) +
				`","farm":{"ID":"f1","Name":"home"},"config":{"schema_version":1,"version":1,"heartbeat_interval_s":60}}`))
		case "/api/ingest/removed":
			c.removed.Add(1)
			c.removedBy.Store(r.Header.Get("Authorization"))
			b, _ := io.ReadAll(r.Body)
			c.removedBody.Store(string(b))
			w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(c.srv.Close)
	return c
}

// ---- harness ----

type rig struct {
	t     *testing.T
	root  string
	env   *Env
	svc   *fakeSvc
	users *fakeUsers
	out   *bytes.Buffer
	self  string
}

func newRig(t *testing.T) *rig {
	if _, _, err := collect.Platform(); err != nil {
		t.Skip("needs Ubuntu:", err)
	}
	root := t.TempDir()
	self := filepath.Join(root, "downloaded-agent")
	os.WriteFile(self, []byte("#!/bin/sh\necho fake agent\n"), 0o755)
	r := &rig{t: t, root: root, svc: &fakeSvc{}, users: &fakeUsers{have: map[string]bool{}}, out: &bytes.Buffer{}, self: self}
	r.env = &Env{
		L: Layout{
			BinPath: filepath.Join(root, "usr/local/bin/fleetagent"), StateDir: filepath.Join(root, "var/lib/fleetagent"),
			UnitPath: filepath.Join(root, "etc/systemd/system/fleetagent.service"), User: "fleetagent",
		},
		Svc: r.svc, Users: r.users, Out: r.out, Version: "1.2.3",
	}
	r.env.L.DeriveMaint()
	os.MkdirAll(filepath.Dir(r.env.L.UnitPath), 0o755)
	return r
}

func (r *rig) install(c *console, extra ...func(*Options)) error {
	o := Options{ConsoleURL: c.srv.URL, Token: "fce_tok", SelfPath: r.self}
	for _, f := range extra {
		f(&o)
	}
	return r.env.Install(context.Background(), o)
}

func (r *rig) tree() []string {
	var out []string
	filepath.Walk(r.root, func(p string, fi os.FileInfo, err error) error {
		// Files only: parent directories such as /usr/local/bin belong to the system, not the agent.
		rel, _ := filepath.Rel(r.root, p)
		if !fi.IsDir() && rel != "downloaded-agent" {
			out = append(out, rel)
		}
		return nil
	})
	return out
}

// ---- tests ----

func TestUnitFileRunsUnprivilegedAndLogsToItsOwnFile(t *testing.T) {
	u := string(DefaultLayout().Unit())
	for _, want := range []string{
		"User=fleetagent", "Restart=always", "WantedBy=multi-user.target", "After=network-online.target",
		"ExecStart=/usr/local/bin/fleetagent run --dir /var/lib/fleetagent --log /var/lib/fleetagent/logs/agent.log",
		"NoNewPrivileges=true", "ProtectSystem=strict", "ReadWritePaths=/var/lib/fleetagent", "StandardOutput=null",
	} {
		if !strings.Contains(u, want) {
			t.Errorf("unit lacks %q", want)
		}
	}
}

func TestInstallCreatesEverythingAndPrintsTheSummary(t *testing.T) {
	r, c := newRig(t), (*console)(nil)
	c = newConsole(t)
	if err := r.install(c); err != nil {
		t.Fatalf("%v\n%s", err, r.out)
	}
	for _, p := range []string{r.env.L.BinPath, r.env.L.UnitPath, filepath.Join(r.env.L.StateDir, "credential"), filepath.Join(r.env.L.StateDir, "logs")} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("missing %s", p)
		}
	}
	if !r.users.have["fleetagent"] || !r.svc.enabled || !r.svc.active {
		t.Fatal("account or service not set up")
	}
	if b, _ := os.ReadFile(r.env.L.UnitPath); !bytes.Equal(b, r.env.L.Unit()) {
		t.Fatal("unit content")
	}
	out := r.out.String()
	for _, want := range []string{"11111111-1111-4111-8111-111111111111", "home", c.srv.URL, "active", "fleetagent uninstall"} {
		if !strings.Contains(out, want) {
			t.Errorf("summary lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "fcn_") || strings.Contains(out, "fce_tok") {
		t.Fatal("summary leaked a secret")
	}
}

func TestRerunReportsTheExistingInstallationAndChangesNothing(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	if err := r.install(c); err != nil {
		t.Fatal(err)
	}
	before := snapshotTree(t, r.root)
	r.out.Reset()
	if err := r.install(c); err != nil {
		t.Fatal(err)
	}
	if c.enrols.Load() != 1 {
		t.Fatalf("re-run enrolled again (%d)", c.enrols.Load())
	}
	if after := snapshotTree(t, r.root); after != before {
		t.Fatalf("re-run changed files:\n%s\n---\n%s", before, after)
	}
	if !strings.Contains(r.out.String(), "already installed") || !strings.Contains(r.out.String(), "--upgrade") {
		t.Fatal(r.out.String())
	}
}

func snapshotTree(t *testing.T, root string) string {
	var b strings.Builder
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if !fi.IsDir() {
			data, _ := os.ReadFile(p)
			b.WriteString(p + " " + fi.ModTime().String() + " " + string(data) + "\n")
		}
		return nil
	})
	return b.String()
}

// A failed install leaves no partial installation behind, whichever step fails.
func TestFailedInstallLeavesNothingBehind(t *testing.T) {
	cases := map[string]func(r *rig, c *console){
		"enrolment refused":      func(r *rig, c *console) { c.enrolFail = 410 },
		"account creation fails": func(r *rig, c *console) { r.users.failCreate = errors.New("useradd: boom") },
		"chown fails":            func(r *rig, c *console) { r.users.failChown = errors.New("chown: boom") },
		"service start fails":    func(r *rig, c *console) { r.svc.failEnable = errors.New("systemctl: boom") },
	}
	for name, arrange := range cases {
		t.Run(name, func(t *testing.T) {
			r, c := newRig(t), newConsole(t)
			arrange(r, c)
			if err := r.install(c); err == nil {
				t.Fatal("expected failure")
			}
			if left := r.env.L.Residue(r.users); len(left) != 0 {
				t.Fatalf("left behind: %v", left)
			}
			if tr := r.tree(); len(tr) != 0 {
				t.Fatalf("files remain: %v", tr)
			}
			if r.svc.enabled || r.users.have["fleetagent"] {
				t.Fatal("service or account remains")
			}
			if !strings.Contains(r.out.String(), "Nothing was left behind") {
				t.Fatalf("no confirmation:\n%s", r.out)
			}
		})
	}
}

func TestRollbackAfterEnrolmentTellsTheConsoleSoNoOrphanStaysPending(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.svc.failEnable = errors.New("boom")
	r.install(c)
	if c.removed.Load() != 1 {
		t.Fatalf("console notified %d times", c.removed.Load())
	}
	if got, _ := c.removedBy.Load().(string); !strings.HasPrefix(got, "Bearer fcn_") {
		t.Fatalf("auth %q", got)
	}
}

func TestInstallRefusesBadInputBeforeTouchingTheMachine(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	if err := r.install(c, func(o *Options) { o.Token = "" }); err == nil {
		t.Fatal("expected error")
	}
	if err := r.install(c, func(o *Options) { o.ConsoleURL = "http://console.example.com" }); err == nil {
		t.Fatal("plain http must be refused")
	}
	if tr := r.tree(); len(tr) != 0 || c.enrols.Load() != 0 {
		t.Fatalf("touched the machine: %v enrols=%d", tr, c.enrols.Load())
	}
}

func TestUninstallRemovesEverythingNotifiesTheConsoleAndVerifies(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	if err := r.install(c); err != nil {
		t.Fatal(err)
	}
	// agent log and a stray temp file, as a running agent would leave
	os.WriteFile(r.env.L.LogPath(), []byte("log"), 0o600)
	os.WriteFile(r.env.L.LogPath()+".1", []byte("old"), 0o600)
	os.WriteFile(filepath.Join(r.env.L.StateDir, ".tmp-seq-123"), []byte("x"), 0o600)
	r.out.Reset()

	rep, err := r.env.Uninstall(context.Background())
	if err != nil || len(rep.Left) != 0 || rep.Console != "notified" {
		t.Fatalf("%+v %v\n%s", rep, err, r.out)
	}
	if c.removed.Load() != 1 {
		t.Fatal("console not told")
	}
	if tr := r.tree(); len(tr) != 0 {
		t.Fatalf("files remain: %v", tr)
	}
	if r.svc.enabled || r.users.have["fleetagent"] {
		t.Fatal("service or account remains")
	}
	if !strings.Contains(r.out.String(), "Verified: nothing of the agent remains") {
		t.Fatal(r.out.String())
	}
}

func TestUninstallTouchesNothingElse(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	sibling := filepath.Join(filepath.Dir(r.env.L.StateDir), "someone-elses-data")
	os.WriteFile(sibling, []byte("keep"), 0o600)
	foreignInState := filepath.Join(r.env.L.StateDir, "not-ours.txt")
	os.WriteFile(foreignInState, []byte("keep"), 0o600)
	otherBin := filepath.Join(filepath.Dir(r.env.L.BinPath), "other-tool")
	os.WriteFile(otherBin, []byte("keep"), 0o755)

	rep, err := r.env.Uninstall(context.Background())
	for _, p := range []string{sibling, foreignInState, otherBin} {
		if _, serr := os.Stat(p); serr != nil {
			t.Errorf("%s was removed", p)
		}
	}
	// The state directory holds a file that is not the agent's, so it must be left and reported, not deleted.
	if err == nil || len(rep.Left) != 1 || rep.Left[0] != r.env.L.StateDir {
		t.Fatalf("%+v %v", rep, err)
	}
}

func TestUninstallWorksOfflineAndTwice(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	c.srv.Close() // no network
	rep, err := r.env.Uninstall(context.Background())
	if err != nil || len(rep.Left) != 0 || !strings.HasPrefix(rep.Console, "unreachable") {
		t.Fatalf("%+v %v", rep, err)
	}
	if !strings.Contains(r.out.String(), "Mark this node removed in the console") {
		t.Fatal("must tell the operator how to finish when the console was unreachable")
	}
	r.out.Reset()
	rep2, err := r.env.Uninstall(context.Background())
	if err != nil || !rep2.NothingInstalled || !strings.Contains(r.out.String(), "Nothing is installed") {
		t.Fatalf("%+v %v\n%s", rep2, err, r.out)
	}
}

func TestUninstallCleansUpPartialInstallations(t *testing.T) {
	r := newRig(t)
	os.MkdirAll(filepath.Dir(r.env.L.BinPath), 0o755)
	os.WriteFile(r.env.L.BinPath, []byte("x"), 0o755) // only the program
	r.users.have["fleetagent"] = true                 // and the account
	rep, err := r.env.Uninstall(context.Background())
	if err != nil || len(rep.Left) != 0 || rep.Console != "not enrolled" {
		t.Fatalf("%+v %v", rep, err)
	}
}

func TestReinstallRemovesThenEnrolsAsANewNode(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	if err := r.install(c, func(o *Options) { o.Reinstall = true; o.Token = "fce_new" }); err != nil {
		t.Fatalf("%v\n%s", err, r.out)
	}
	if c.enrols.Load() != 2 || c.removed.Load() != 1 {
		t.Fatalf("enrols %d removed %d", c.enrols.Load(), c.removed.Load())
	}
	if !r.svc.active || len(r.env.L.Residue(r.users)) != 6 {
		t.Fatalf("not reinstalled: %v", r.env.L.Residue(r.users))
	}
}

func TestUpgradeSwapsTheProgramKeepsStateAndRestartsTheService(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	idBefore, _ := os.ReadFile(filepath.Join(r.env.L.StateDir, "identity.json"))
	credBefore, _ := os.ReadFile(filepath.Join(r.env.L.StateDir, "credential"))
	os.WriteFile(r.self, []byte("#!/bin/sh\necho NEW VERSION\n"), 0o755)

	if err := r.install(c, func(o *Options) { o.Upgrade = true }); err != nil {
		t.Fatalf("%v\n%s", err, r.out)
	}
	if b, _ := os.ReadFile(r.env.L.BinPath); !strings.Contains(string(b), "NEW VERSION") {
		t.Fatal("program not replaced")
	}
	idAfter, _ := os.ReadFile(filepath.Join(r.env.L.StateDir, "identity.json"))
	credAfter, _ := os.ReadFile(filepath.Join(r.env.L.StateDir, "credential"))
	if !bytes.Equal(idBefore, idAfter) || !bytes.Equal(credBefore, credAfter) {
		t.Fatal("identity or credential changed")
	}
	if r.svc.restarts != 1 || c.enrols.Load() != 1 {
		t.Fatalf("restarts %d enrols %d", r.svc.restarts, c.enrols.Load())
	}
	if _, err := os.Stat(r.env.L.BinPath + ".old"); err == nil {
		t.Fatal("backup left behind")
	}
}

func TestUpgradeWithMissingSourceKeepsThePreviousVersion(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	before, _ := os.ReadFile(r.env.L.BinPath)
	err := r.install(c, func(o *Options) { o.Upgrade = true; o.SelfPath = filepath.Join(r.root, "missing") })
	after, _ := os.ReadFile(r.env.L.BinPath)
	if err == nil || !bytes.Equal(before, after) {
		t.Fatalf("err %v, program changed", err)
	}
}

func TestStatusJSONIsNotRequiredForInstallSummary(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.env.HeartbeatWait = 0
	if err := r.install(c); err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	b, _ := os.ReadFile(filepath.Join(r.env.L.StateDir, "config.json"))
	if json.Unmarshal(b, &v) != nil || v["version"] != float64(1) {
		t.Fatal("config not stored")
	}
}

// ---- US-023: console-requested removal ----

func TestMaintenanceUnitsAreRootOwnedFixedActionAndWatchOneFile(t *testing.T) {
	l := DefaultLayout()
	path, svc := string(l.MaintPath()), string(l.MaintService())
	for _, want := range []string{"PathExists=/var/lib/fleetagent/decommission.request", "Unit=fleetagent-maint.service", "WantedBy=multi-user.target"} {
		if !strings.Contains(path, want) {
			t.Errorf("path unit lacks %q", want)
		}
	}
	for _, want := range []string{"Type=oneshot", "User=root",
		"ExecStart=/usr/local/bin/fleetagent maintenance decommission --dir /var/lib/fleetagent --bin /usr/local/bin/fleetagent --unit /etc/systemd/system/fleetagent.service"} {
		if !strings.Contains(svc, want) {
			t.Errorf("service unit lacks %q", want)
		}
	}
	if strings.Contains(svc, "[Install]") {
		t.Error("the maintenance service must not be enabled on its own; only the path unit starts it")
	}
	if !strings.Contains(string(l.Unit()), "User=fleetagent") {
		t.Error("the agent itself stays unprivileged")
	}
}

func TestInstallWritesTheMaintenanceUnitsAndUninstallRemovesThem(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	if err := r.install(c); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{r.env.L.MaintPathUnit, r.env.L.MaintServiceUnit} {
		if b, err := os.ReadFile(p); err != nil || len(b) == 0 {
			t.Fatalf("%s: %v", p, err)
		}
	}
	if _, err := r.env.Uninstall(context.Background()); err != nil {
		t.Fatal(err)
	}
	if tr := r.tree(); len(tr) != 0 {
		t.Fatalf("files remain: %v", tr)
	}
}

func TestUninstallTellsTheConsoleLastAndReportsItsOwnVerification(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	if _, err := r.env.Uninstall(context.Background()); err != nil {
		t.Fatal(err)
	}
	var got api_report
	json.Unmarshal([]byte(c.removedBody.Load().(string)), &got)
	if !got.Verified || len(got.Residue) != 0 {
		t.Fatalf("report %+v", got)
	}

	// With something left behind the report says so, and still reaches the console.
	r2, c2 := newRig(t), newConsole(t)
	r2.install(c2)
	os.WriteFile(filepath.Join(r2.env.L.StateDir, "not-ours.txt"), []byte("x"), 0o600)
	if _, err := r2.env.Uninstall(context.Background()); err == nil {
		t.Fatal("expected an error for the leftover")
	}
	var got2 api_report
	json.Unmarshal([]byte(c2.removedBody.Load().(string)), &got2)
	if got2.Verified || len(got2.Residue) != 1 || got2.Residue[0] != r2.env.L.StateDir {
		t.Fatalf("report %+v", got2)
	}
}

type api_report struct {
	Verified bool     `json:"verified"`
	Residue  []string `json:"residue"`
}

func TestMaintenanceActsOnlyOnARequestFromTheAgent(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	before := snapshotTree(t, r.root)

	// No request file: refuses, changes nothing, and does not tell the console anything.
	if err := r.env.MaintenanceDecommission(context.Background()); err == nil {
		t.Fatal("expected a refusal")
	}
	if after := snapshotTree(t, r.root); after != before || c.removed.Load() != 0 {
		t.Fatal("changed something without a request")
	}
	// A request that is a link, not a file, is refused as well.
	target := filepath.Join(r.root, "elsewhere")
	os.WriteFile(target, []byte("keep"), 0o600)
	os.Symlink(target, r.env.L.RequestPath())
	if err := r.env.MaintenanceDecommission(context.Background()); err == nil {
		t.Fatal("a link must not count as a request")
	}
	os.Remove(r.env.L.RequestPath())

	// A real request: the whole agent goes, the request file with it, and the console is told.
	os.WriteFile(r.env.L.RequestPath(), []byte("decommission 7\n"), 0o600)
	if err := r.env.MaintenanceDecommission(context.Background()); err != nil {
		t.Fatalf("%v\n%s", err, r.out)
	}
	if left := r.env.L.Residue(r.users); len(left) != 0 {
		t.Fatalf("left: %v", left)
	}
	if c.removed.Load() != 1 {
		t.Fatal("console not told")
	}
	if b, err := os.ReadFile(target); err != nil || string(b) != "keep" {
		t.Fatal("touched a file outside the agent")
	}
}

func TestUninstallNeverFollowsLinksThePlantedInTheStateDirectory(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	victim := filepath.Join(r.root, "victim")
	os.MkdirAll(victim, 0o755)
	os.WriteFile(filepath.Join(victim, "agent.log"), []byte("precious"), 0o600)
	logs := filepath.Join(r.env.L.StateDir, "logs")
	os.RemoveAll(logs)
	os.Symlink(victim, logs) // what a compromised agent account could do

	r.env.Uninstall(context.Background())
	if b, err := os.ReadFile(filepath.Join(victim, "agent.log")); err != nil || string(b) != "precious" {
		t.Fatal("followed a link out of the state directory")
	}

	// The state directory itself replaced by a link: only the link goes.
	r2, c2 := newRig(t), newConsole(t)
	r2.install(c2)
	victim2 := filepath.Join(r2.root, "victim2")
	os.MkdirAll(victim2, 0o755)
	os.WriteFile(filepath.Join(victim2, "credential"), []byte("precious"), 0o600)
	os.RemoveAll(r2.env.L.StateDir)
	os.Symlink(victim2, r2.env.L.StateDir)
	r2.env.Uninstall(context.Background())
	if b, err := os.ReadFile(filepath.Join(victim2, "credential")); err != nil || string(b) != "precious" {
		t.Fatal("followed the state directory link")
	}
}

func TestRequestDecommissionerWritesAPrivateRequestAndWaitsToBeStopped(t *testing.T) {
	dir := t.TempDir()
	l := Layout{StateDir: dir}
	d := RequestDecommissioner{L: l, Wait: 5 * time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { done <- d.Decommission(ctx, "42") }()
	time.Sleep(100 * time.Millisecond)
	fi, err := os.Stat(l.RequestPath())
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("request file: %v %v", err, fi)
	}
	cancel() // the helper stopped the service
	if err := <-done; err == nil {
		t.Fatal("expected the context error")
	}

	// Nothing stops it: it gives up, says why, and takes its request back so it cannot fire later.
	d2 := RequestDecommissioner{L: l, Wait: 150 * time.Millisecond}
	err = d2.Decommission(context.Background(), "43")
	if err == nil || !strings.Contains(err.Error(), "did not remove the agent") {
		t.Fatalf("%v", err)
	}
	if _, serr := os.Stat(l.RequestPath()); serr == nil {
		t.Fatal("request file left behind")
	}
}

func TestDirectDecommissionerRemovesEverything(t *testing.T) {
	r, c := newRig(t), newConsole(t)
	r.install(c)
	if err := (DirectDecommissioner{Env: r.env}).Decommission(context.Background(), "1"); err != nil {
		t.Fatal(err)
	}
	if left := r.env.L.Residue(r.users); len(left) != 0 {
		t.Fatalf("left: %v", left)
	}
}
