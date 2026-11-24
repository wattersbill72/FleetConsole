// Package state holds everything the agent keeps on disk: identity, credential, applied
// configuration, and the Snapshot sequence counter. Files are readable only by the agent's account.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	fileIdentity   = "identity.json"
	fileCredential = "credential"
	fileConfig     = "config.json"
	fileSeq        = "seq"
)

// DefaultDir is where the agent keeps its state unless told otherwise.
func DefaultDir() string {
	if v := os.Getenv("FLEETAGENT_DIR"); v != "" {
		return v
	}
	if runtime.GOOS == "darwin" {
		return "/usr/local/var/fleetagent"
	}
	return "/var/lib/fleetagent"
}

// Identity is the node's permanent identity and where it reports. Hostname is deliberately not part of it.
type Identity struct {
	NodeID     string `json:"node_id"`
	ConsoleURL string `json:"console_url"`
	FarmID     string `json:"farm_id"`
	FarmName   string `json:"farm_name"`
}

// Config is the part of Desired Config v1 this agent version understands. Unknown fields are ignored
// so an older agent keeps running against a newer console.
type Config struct {
	Version            int      `json:"version"`
	HeartbeatIntervalS int      `json:"heartbeat_interval_s"`
	Intermittent       bool     `json:"intermittent"`
	DiskVolumes        []string `json:"disk_volumes"`
}

var ErrNotEnrolled = errors.New("this machine is not enrolled")

type Store struct{ Dir string }

func New(dir string) *Store { return &Store{Dir: dir} }

func (s *Store) path(name string) string { return filepath.Join(s.Dir, name) }

// Enrolled reports whether an identity exists.
func (s *Store) Enrolled() bool {
	_, err := os.Stat(s.path(fileIdentity))
	return err == nil
}

// SaveEnrolment writes identity, credential and initial config. It refuses to overwrite an existing enrolment.
func (s *Store) SaveEnrolment(id Identity, credential string, rawConfig []byte) error {
	if s.Enrolled() {
		return errors.New("already enrolled; remove the agent before enrolling again")
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(s.Dir, 0o700); err != nil {
		return err
	}
	idJSON, _ := json.MarshalIndent(id, "", "  ")
	// Credential first, identity last: identity is the "enrolled" marker, so a crash mid-write leaves a
	// machine that can enrol again, never a half-enrolled one.
	if err := s.write(fileCredential, []byte(credential)); err != nil {
		return err
	}
	if err := s.write(fileConfig, rawConfig); err != nil {
		return err
	}
	if err := s.write(fileSeq, []byte("0")); err != nil {
		return err
	}
	return s.write(fileIdentity, idJSON)
}

// write replaces a file atomically with mode 0600.
func (s *Store) write(name string, data []byte) error {
	tmp, err := os.CreateTemp(s.Dir, ".tmp-"+name+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path(name))
}

// CheckPermissions fails if the directory or any state file is accessible to group or others.
func (s *Store) CheckPermissions() error {
	st, err := os.Stat(s.Dir)
	if err != nil {
		return err
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s is accessible to other users (mode %04o); expected 0700", s.Dir, st.Mode().Perm())
	}
	for _, f := range []string{fileCredential, fileIdentity, fileConfig, fileSeq} {
		st, err := os.Stat(s.path(f))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if st.Mode().Perm()&0o077 != 0 {
			return fmt.Errorf("%s is accessible to other users (mode %04o); expected 0600", s.path(f), st.Mode().Perm())
		}
	}
	return nil
}

func (s *Store) LoadIdentity() (Identity, error) {
	var id Identity
	b, err := os.ReadFile(s.path(fileIdentity))
	if errors.Is(err, os.ErrNotExist) {
		return id, ErrNotEnrolled
	}
	if err != nil {
		return id, err
	}
	if err := json.Unmarshal(b, &id); err != nil {
		return id, fmt.Errorf("identity file is corrupt: %w", err)
	}
	return id, nil
}

func (s *Store) LoadCredential() (string, error) {
	b, err := os.ReadFile(s.path(fileCredential))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func (s *Store) LoadConfig() (Config, error) {
	cfg := Config{HeartbeatIntervalS: 60}
	b, err := os.ReadFile(s.path(fileConfig))
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, fmt.Errorf("config file is corrupt: %w", err)
	}
	if cfg.HeartbeatIntervalS < 30 || cfg.HeartbeatIntervalS > 300 {
		cfg.HeartbeatIntervalS = 60
	}
	return cfg, nil
}

// NextSeq returns the next Snapshot sequence number, persisting it before use so numbers never repeat
// across restarts or reboots.
func (s *Store) NextSeq() (int64, error) {
	cur, err := s.readSeq()
	if err != nil {
		return 0, err
	}
	return cur + 1, s.write(fileSeq, []byte(strconv.FormatInt(cur+1, 10)))
}

// AdvanceSeqTo moves the counter forward (never back) so the next number is greater than n.
func (s *Store) AdvanceSeqTo(n int64) error {
	cur, err := s.readSeq()
	if err != nil {
		return err
	}
	if n <= cur {
		return nil
	}
	return s.write(fileSeq, []byte(strconv.FormatInt(n, 10)))
}

func (s *Store) readSeq() (int64, error) {
	b, err := os.ReadFile(s.path(fileSeq))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil || n < 0 {
		return 0, errors.New("sequence file is corrupt")
	}
	return n, nil
}
