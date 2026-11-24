package install

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fleetconsole/agent/internal/api"
	"fleetconsole/agent/internal/collect"
	"fleetconsole/agent/internal/state"
)

type Env struct {
	L             Layout
	Svc           Services
	Users         Users
	Out           io.Writer
	Version       string
	HeartbeatWait time.Duration // how long to wait for the first heartbeat before summarising; 0 skips
}

type Options struct {
	ConsoleURL string
	Token      string
	SelfPath   string // the binary to install
	Upgrade    bool   // replace binary and unit on an existing installation, keeping identity
	Reinstall  bool   // remove the existing installation and enrol again
}

func (e *Env) say(format string, a ...any) { fmt.Fprintf(e.Out, format+"\n", a...) }

// Installed reports whether any part of the agent is present.
func (e *Env) Installed() bool { return len(e.L.Residue(e.Users)) > 0 }

// Install puts the agent on this machine, enrols it, and starts it. A failure at any step undoes
// what this run did, so a failed install leaves nothing behind.
func (e *Env) Install(ctx context.Context, o Options) (err error) {
	if e.Installed() {
		switch {
		case o.Reinstall:
			e.say("Removing the existing installation first.")
			if _, uerr := e.Uninstall(ctx); uerr != nil {
				return fmt.Errorf("could not remove the existing installation: %w", uerr)
			}
		case o.Upgrade:
			return e.upgrade(ctx, o)
		default:
			e.reportExisting()
			return nil
		}
	}

	osName, osVersion, perr := collect.Platform()
	if perr != nil {
		return perr
	}
	if osName == "macos" {
		return errors.New("installing on macOS is not available yet (US-012)")
	}
	if !strings.HasPrefix(osVersion, "24.04") {
		e.say("Note: this agent is built and tested for Ubuntu 24.04; this machine runs %s.", osVersion)
	}
	if o.ConsoleURL == "" || o.Token == "" {
		return errors.New("a console address and an enrolment token are required")
	}
	// Validate the address before touching the machine.
	client, cerr := api.New(o.ConsoleURL, e.Version)
	if cerr != nil {
		return cerr
	}

	var undo []func()
	defer func() {
		if err == nil {
			return
		}
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i]()
		}
		e.say("Install failed: %v", err)
		if left := e.L.Residue(e.Users); len(left) == 0 {
			e.say("Nothing was left behind on this machine.")
		} else {
			e.say("Could not remove everything. Left behind: %s", strings.Join(left, ", "))
		}
	}()

	e.say("Installing the agent.")

	// 1. program
	if err = copyExecutable(o.SelfPath, e.L.BinPath); err != nil {
		return fmt.Errorf("installing the program: %w", err)
	}
	undo = append(undo, func() { os.Remove(e.L.BinPath) })

	// 2. service account
	created, uerr := e.Users.Ensure(e.L.User)
	if uerr != nil {
		return uerr
	}
	if created {
		undo = append(undo, func() { e.Users.Remove(e.L.User) })
	}

	// 3. enrol: this consumes the token, so it comes after everything that can fail cheaply
	if err = os.MkdirAll(e.L.StateDir, 0o700); err != nil {
		return err
	}
	undo = append(undo, func() { removeStateDir(e.L.StateDir) })
	host, _ := os.Hostname()
	ectx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, eerr := client.Enrol(ectx, api.EnrolRequest{
		Token: o.Token, OS: osName, Hostname: host, OSVersion: osVersion, AgentVersion: e.Version,
	})
	if eerr != nil {
		return eerr
	}
	id := state.Identity{NodeID: resp.NodeID, ConsoleURL: o.ConsoleURL, FarmID: resp.Farm.ID, FarmName: resp.Farm.Name}
	st := state.New(e.L.StateDir)
	if err = st.SaveEnrolment(id, resp.Credential, resp.Config); err != nil {
		return err
	}
	// From here the console knows this node. If a later step fails, tell it, so no orphan stays pending.
	undo = append(undo, func() { e.notifyRemoved(st, client) })

	// 4. private to the service account
	if err = os.MkdirAll(filepath.Join(e.L.StateDir, "logs"), 0o700); err != nil {
		return err
	}
	if err = e.Users.ChownAll(e.L.StateDir, e.L.User); err != nil {
		return fmt.Errorf("handing the state directory to %s: %w", e.L.User, err)
	}

	// 5. service
	if err = os.WriteFile(e.L.UnitPath, e.L.Unit(), 0o644); err != nil {
		return fmt.Errorf("writing the service unit: %w", err)
	}
	undo = append(undo, func() { os.Remove(e.L.UnitPath); e.Svc.Reload() })
	if err = e.Svc.Reload(); err != nil {
		return err
	}
	undo = append(undo, func() { e.Svc.DisableNow() })
	if err = e.Svc.EnableNow(); err != nil {
		return err
	}

	e.summary(id, e.firstHeartbeat(st))
	return nil
}

// firstHeartbeat waits briefly for the service's first heartbeat and says what happened.
func (e *Env) firstHeartbeat(st *state.Store) string {
	deadline := time.Now().Add(e.HeartbeatWait)
	for {
		if s, err := st.ReadStatus(); err == nil {
			if s.LastSuccess != "" {
				return "accepted by the console"
			}
			if s.LastError != "" && time.Now().After(deadline) {
				return "not accepted yet: " + s.LastError
			}
		}
		if !time.Now().Before(deadline) {
			return "not seen yet; run `sudo fleetagent status` in a minute"
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func (e *Env) summary(id state.Identity, hb string) {
	active, enabled := e.Svc.Status()
	e.say("")
	e.say("Installed.")
	e.say("  Node identity:   %s", id.NodeID)
	e.say("  Farm:            %s", id.FarmName)
	e.say("  Console:         %s", id.ConsoleURL)
	e.say("  Service:         %s (starts at boot: %v)", active, enabled)
	e.say("  First heartbeat: %s", hb)
	e.say("  Check it:        sudo fleetagent status")
	e.say("  Remove it:       sudo fleetagent uninstall")
}

func (e *Env) reportExisting() {
	st := state.New(e.L.StateDir)
	e.say("The agent is already installed. Nothing was changed.")
	if id, err := st.LoadIdentity(); err == nil {
		active, _ := e.Svc.Status()
		e.say("  Node identity: %s", id.NodeID)
		e.say("  Farm:          %s", id.FarmName)
		e.say("  Console:       %s", id.ConsoleURL)
		e.say("  Service:       %s", active)
	} else {
		e.say("  It looks partly installed: %s", strings.Join(e.L.Residue(e.Users), ", "))
	}
	e.say("  To update the program:   fleetagent install --upgrade")
	e.say("  To enrol from scratch:   fleetagent install --reinstall (needs a new token)")
	e.say("  To remove it:            sudo fleetagent uninstall")
}

// upgrade swaps the program and unit, keeping identity, credential, configuration and sequence.
func (e *Env) upgrade(ctx context.Context, o Options) error {
	if !state.New(e.L.StateDir).Enrolled() {
		return errors.New("nothing to upgrade: the agent is not enrolled; use --reinstall")
	}
	backup := e.L.BinPath + ".old"
	if err := os.Rename(e.L.BinPath, backup); err != nil {
		return fmt.Errorf("preparing upgrade: %w", err)
	}
	restore := func() { os.Rename(backup, e.L.BinPath) }
	if err := copyExecutable(o.SelfPath, e.L.BinPath); err != nil {
		restore()
		return fmt.Errorf("upgrade failed, previous version kept: %w", err)
	}
	oldUnit, _ := os.ReadFile(e.L.UnitPath)
	if err := os.WriteFile(e.L.UnitPath, e.L.Unit(), 0o644); err != nil {
		os.Remove(e.L.BinPath)
		restore()
		return fmt.Errorf("upgrade failed, previous version kept: %w", err)
	}
	if err := e.Svc.Reload(); err == nil {
		err = e.Svc.Restart()
		if err != nil {
			os.Remove(e.L.BinPath)
			restore()
			os.WriteFile(e.L.UnitPath, oldUnit, 0o644)
			e.Svc.Reload()
			e.Svc.Restart()
			return fmt.Errorf("upgrade failed, previous version restored: %w", err)
		}
	}
	os.Remove(backup)
	e.say("Upgraded to %s. Identity, credential, configuration and sequence were kept.", e.Version)
	return nil
}

func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".fleetagent-new-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}
