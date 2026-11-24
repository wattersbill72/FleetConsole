// Package cli implements the local diagnostic commands an operator runs at a node's terminal.
package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"fleetconsole/agent/internal/api"
	"fleetconsole/agent/internal/collect"
	"fleetconsole/agent/internal/install"
	"fleetconsole/agent/internal/runner"
	"fleetconsole/agent/internal/state"
)

type Env struct {
	Install *install.Env
	Version string
	Out     io.Writer
}

func (e *Env) store() *state.Store { return state.New(e.Install.L.StateDir) }

func (e *Env) say(format string, a ...any) { fmt.Fprintf(e.Out, format+"\n", a...) }

func permHint(err error) error {
	if errors.Is(err, os.ErrPermission) {
		return errors.New("permission denied: the agent's files are private to its own account; run with sudo")
	}
	return err
}

// Status prints what the agent knows about itself.
func (e *Env) Status() error {
	st := e.store()
	id, err := st.LoadIdentity()
	if errors.Is(err, state.ErrNotEnrolled) {
		e.say("Agent version:  %s", e.Version)
		e.say("Not enrolled on this machine.")
		return nil
	}
	if err != nil {
		return permHint(err)
	}
	active, enabled := e.Install.Svc.Status()
	e.say("Agent version:        %s", e.Version)
	e.say("Node identity:        %s", id.NodeID)
	e.say("Farm:                 %s", id.FarmName)
	e.say("Console:              %s", id.ConsoleURL)
	e.say("Service:              %s (starts at boot: %v)", active, enabled)
	s, serr := st.ReadStatus()
	if serr != nil {
		e.say("Last heartbeat:       none recorded yet")
		e.say("Config version:       unknown")
		e.say("Buffer depth:         0")
		e.say("Last error:           none recorded")
		return nil
	}
	e.say("Last heartbeat:       %s", orNone(s.LastSuccess, "none yet"))
	e.say("Applied config:       version %d", s.ConfigVersion)
	e.say("Buffer depth:         %d", s.BufferDepth)
	if s.LastError != "" {
		e.say("Last error:           %s (%s)", s.LastError, s.LastErrorAt)
	} else {
		e.say("Last error:           none")
	}
	return nil
}

func orNone(v, none string) string {
	if v == "" {
		return none
	}
	return v
}

var secretKey = regexp.MustCompile(`(?i)token|secret|password|passwd|credential|key`)

// maskSecrets replaces the value of any secret-looking key, at any depth.
func maskSecrets(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, x := range t {
			if secretKey.MatchString(k) {
				out[k] = "********"
			} else {
				out[k] = maskSecrets(x)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = maskSecrets(x)
		}
		return out
	}
	return v
}

// Config prints the applied configuration with secrets masked. The credential is never shown.
func (e *Env) Config() error {
	raw, err := e.store().RawConfig()
	if errors.Is(err, os.ErrNotExist) {
		return state.ErrNotEnrolled
	}
	if err != nil {
		return permHint(err)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return fmt.Errorf("config file is corrupt: %w", err)
	}
	out, _ := json.MarshalIndent(maskSecrets(v), "", "  ")
	e.say("%s", out)
	return nil
}

// Check is one line of a test or self-check.
type Check struct {
	Name   string
	OK     bool
	Detail string
	Skip   bool
}

func (e *Env) print(checks []Check) bool {
	ok := true
	for _, c := range checks {
		mark := "PASS"
		switch {
		case c.Skip:
			mark = "SKIP"
		case !c.OK:
			mark = "FAIL"
			ok = false
		}
		e.say("  [%s] %-26s %s", mark, c.Name, c.Detail)
	}
	return ok
}

// Test walks the path a heartbeat takes, reporting each step separately.
func (e *Env) Test(ctx context.Context) error {
	st := e.store()
	id, err := st.LoadIdentity()
	if err != nil {
		return permHint(err)
	}
	cred, err := st.LoadCredential()
	if err != nil {
		return permHint(err)
	}
	client, err := api.New(id.ConsoleURL, e.Version)
	if err != nil {
		return err
	}
	host, port := client.Host()
	var checks []Check
	failed := false
	step := func(name string, run func() (string, error)) {
		if failed {
			checks = append(checks, Check{Name: name, Skip: true, Detail: "not attempted"})
			return
		}
		detail, err := run()
		if err != nil {
			failed = true
			checks = append(checks, Check{Name: name, Detail: err.Error()})
			return
		}
		checks = append(checks, Check{Name: name, OK: true, Detail: detail})
	}

	step("Name resolution", func() (string, error) {
		addrs, err := net.DefaultResolver.LookupHost(ctx, host)
		if err != nil {
			return "", fmt.Errorf("cannot resolve %s: %v", host, err)
		}
		return fmt.Sprintf("%s -> %s", host, strings.Join(addrs, ", ")), nil
	})
	step("Console reachable", func() (string, error) {
		d := net.Dialer{Timeout: 8 * time.Second}
		c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
		if err != nil {
			return "", fmt.Errorf("cannot connect to %s:%s: %v", host, port, err)
		}
		c.Close()
		return fmt.Sprintf("connected to %s:%s", host, port), nil
	})
	step("Credential accepted", func() (string, error) {
		if err := client.Ping(ctx, cred); err != nil {
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status == 401 {
				return "", errors.New("the console rejected this credential (node removed or credential revoked)")
			}
			return "", err
		}
		return "console accepted the credential", nil
	})
	step("Snapshot accepted", func() (string, error) {
		r := &runner.Runner{Store: st, Client: client, Collector: collect.New(), Version: e.Version, Log: nopLogger()}
		resp, err := r.Once(ctx)
		if err != nil {
			return "", errors.New(runner.Describe(err))
		}
		return fmt.Sprintf("heartbeat stored (last_seq %d)", resp.LastSeq), nil
	})

	e.say("Connectivity test for %s", id.ConsoleURL)
	if !e.print(checks) {
		return errors.New("connectivity test failed")
	}
	e.say("All steps passed.")
	return nil
}

// Selfcheck validates the installation and its permissions. Any failure is an error (non-zero exit).
func (e *Env) Selfcheck() error {
	l := e.Install.L
	var checks []Check
	add := func(name string, err error, ok string) {
		if err != nil {
			checks = append(checks, Check{Name: name, Detail: err.Error()})
		} else {
			checks = append(checks, Check{Name: name, OK: true, Detail: ok})
		}
	}

	add("Program installed", fileErr(l.BinPath, 0o022, true), l.BinPath)
	add("Service unit present", unitErr(l.UnitPath, l.Unit()), l.UnitPath)
	add("Maintenance trigger present", unitErr(l.MaintPathUnit, l.MaintPath()), l.MaintPathUnit)
	add("Maintenance unit present", unitErr(l.MaintServiceUnit, l.MaintService()), l.MaintServiceUnit)
	if l.UnitPath != "" {
		active, enabled := e.Install.Svc.Status()
		switch {
		case active == "not managed":
			checks = append(checks, Check{Name: "Service running", Skip: true, Detail: "not managed by a service manager"})
		case active != "active":
			checks = append(checks, Check{Name: "Service running", Detail: "state is " + active})
		case !enabled:
			checks = append(checks, Check{Name: "Service starts at boot", Detail: "not enabled"})
		default:
			checks = append(checks, Check{Name: "Service running", OK: true, Detail: "active, enabled at boot"})
		}
	}
	st := e.store()
	add("State files private", st.CheckPermissions(), l.StateDir+" (0700, files 0600)")
	if l.User != "" && e.Install.Users.Exists(l.User) {
		add("State owned by service user", ownerErr(l.StateDir, l.User), l.User)
	}
	id, err := st.LoadIdentity()
	add("Identity readable", err, id.NodeID)
	if err == nil {
		cred, cerr := st.LoadCredential()
		if cerr == nil && !strings.HasPrefix(cred, "fcn_") {
			cerr = errors.New("credential file does not look like a node credential")
		}
		add("Credential present", cerr, "present (not shown)")
		_, cfgErr := st.LoadConfig()
		add("Configuration valid", cfgErr, "readable")
	}

	e.say("Self-check")
	if !e.print(checks) {
		return errors.New("self-check failed")
	}
	e.say("All checks passed.")
	return nil
}

func fileErr(p string, badBits os.FileMode, wantExec bool) error {
	fi, err := os.Stat(p)
	if err != nil {
		return fmt.Errorf("%s is missing", p)
	}
	if fi.Mode().Perm()&badBits != 0 {
		return fmt.Errorf("%s is writable by others (mode %04o)", p, fi.Mode().Perm())
	}
	if wantExec && fi.Mode().Perm()&0o100 == 0 {
		return fmt.Errorf("%s is not executable", p)
	}
	return nil
}

func unitErr(path string, want []byte) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("%s is missing", path)
	}
	if sha256.Sum256(b) != sha256.Sum256(want) {
		return fmt.Errorf("%s differs from what this agent version installs (edited or from another version)", path)
	}
	return nil
}

func ownerErr(dir, name string) error {
	u, err := user.Lookup(name)
	if err != nil {
		return err
	}
	uid, _ := strconv.Atoi(u.Uid)
	fi, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if sys, ok := fi.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != uid {
		return fmt.Errorf("%s is owned by uid %d, expected %s", dir, sys.Uid, name)
	}
	return nil
}

// Help lists every command.
func Help() string {
	cmds := [][2]string{
		{"enrol --console <url>", "enrol this machine (the installer does this for you)"},
		{"run [--once]", "run the agent (the service does this)"},
		{"install --console <url>", "install, enrol and start the agent; --upgrade, --reinstall"},
		{"uninstall", "remove the agent completely; works offline; safe to run twice"},
		{"status", "show version, identity, service state, last heartbeat, config, buffer, last error"},
		{"test", "step-by-step connectivity test: DNS, reach, credential, snapshot"},
		{"config", "show the applied configuration with secrets masked"},
		{"selfcheck", "validate installation integrity and permissions; non-zero on failure"},
		{"maintenance decommission", "run by the service manager when the console removes this node; not for hand use"},
		{"version", "print the agent version"},
		{"help", "this list"},
	}
	var b bytes.Buffer
	b.WriteString("fleetagent - Fleet Console Edge Agent\n\nCommands:\n")
	for _, c := range cmds {
		fmt.Fprintf(&b, "  fleetagent %-26s %s\n", c[0], c[1])
	}
	b.WriteString("\nCommon flags: --dir <state dir>. Commands that read agent files need sudo.\n")
	b.WriteString("The enrolment token may be given in FLEETAGENT_TOKEN to keep it out of the process list.\n")
	return b.String()
}
