package state

import (
	"os"
	"path/filepath"
	"testing"
)

func enrolled(t *testing.T) *Store {
	t.Helper()
	s := New(filepath.Join(t.TempDir(), "state"))
	err := s.SaveEnrolment(Identity{NodeID: "n1", ConsoleURL: "https://c", FarmID: "f", FarmName: "home"}, "fcn_secret", []byte(`{"version":1,"heartbeat_interval_s":120,"intermittent":true,"future_field":1}`))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestEnrolmentIsPrivateAndRoundTrips(t *testing.T) {
	s := enrolled(t)
	if err := s.CheckPermissions(); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(s.Dir)
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %o", st.Mode().Perm())
	}
	for _, f := range []string{"credential", "identity.json", "config.json", "seq"} {
		fi, err := os.Stat(filepath.Join(s.Dir, f))
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", f, err, fi.Mode())
		}
	}
	id, err := s.LoadIdentity()
	if err != nil || id.NodeID != "n1" || id.FarmName != "home" {
		t.Fatalf("%+v %v", id, err)
	}
	if c, _ := s.LoadCredential(); c != "fcn_secret" {
		t.Fatal("credential")
	}
	cfg, err := s.LoadConfig()
	if err != nil || cfg.HeartbeatIntervalS != 120 || !cfg.Intermittent || cfg.Version != 1 {
		t.Fatalf("%+v %v", cfg, err)
	}
}

func TestSecondEnrolmentIsRefusedAndChangesNothing(t *testing.T) {
	s := enrolled(t)
	if err := s.SaveEnrolment(Identity{NodeID: "other"}, "fcn_other", []byte(`{}`)); err == nil {
		t.Fatal("expected refusal")
	}
	id, _ := s.LoadIdentity()
	if c, _ := s.LoadCredential(); id.NodeID != "n1" || c != "fcn_secret" {
		t.Fatal("state was modified")
	}
}

func TestNotEnrolled(t *testing.T) {
	s := New(t.TempDir())
	if s.Enrolled() {
		t.Fatal("should not be enrolled")
	}
	if _, err := s.LoadIdentity(); err != ErrNotEnrolled {
		t.Fatalf("got %v", err)
	}
}

func TestInsecurePermissionsAreDetected(t *testing.T) {
	s := enrolled(t)
	if err := os.Chmod(filepath.Join(s.Dir, "credential"), 0o644); err != nil {
		t.Fatal(err)
	}
	if s.CheckPermissions() == nil {
		t.Fatal("world-readable credential must fail the check")
	}
	os.Chmod(filepath.Join(s.Dir, "credential"), 0o600)
	os.Chmod(s.Dir, 0o755)
	if s.CheckPermissions() == nil {
		t.Fatal("open directory must fail the check")
	}
}

func TestSequenceSurvivesRestartAndNeverGoesBack(t *testing.T) {
	s := enrolled(t)
	for want := int64(1); want <= 3; want++ {
		got, err := s.NextSeq()
		if err != nil || got != want {
			t.Fatalf("got %d want %d (%v)", got, want, err)
		}
	}
	again := New(s.Dir) // a new process reading the same directory
	if got, _ := again.NextSeq(); got != 4 {
		t.Fatalf("after restart got %d", got)
	}
	if err := again.AdvanceSeqTo(100); err != nil {
		t.Fatal(err)
	}
	if got, _ := again.NextSeq(); got != 101 {
		t.Fatalf("after advance got %d", got)
	}
	again.AdvanceSeqTo(5) // must not go back
	if got, _ := again.NextSeq(); got != 102 {
		t.Fatalf("after backwards advance got %d", got)
	}
}

func TestCorruptSequenceIsAnErrorNotAReset(t *testing.T) {
	s := enrolled(t)
	os.WriteFile(filepath.Join(s.Dir, "seq"), []byte("banana"), 0o600)
	if _, err := s.NextSeq(); err == nil {
		t.Fatal("a corrupt counter must not silently restart at 1")
	}
}

func TestConfigIntervalOutOfRangeFallsBackToDefault(t *testing.T) {
	s := enrolled(t)
	os.WriteFile(filepath.Join(s.Dir, "config.json"), []byte(`{"version":2,"heartbeat_interval_s":5}`), 0o600)
	cfg, _ := s.LoadConfig()
	if cfg.HeartbeatIntervalS != 60 {
		t.Fatalf("got %d", cfg.HeartbeatIntervalS)
	}
}
