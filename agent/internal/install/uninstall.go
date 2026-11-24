package install

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fleetconsole/agent/internal/api"
	"fleetconsole/agent/internal/state"
)

// Report says what an uninstall did, for the summary and for tests.
type Report struct {
	NothingInstalled bool
	Console          string // "notified", "unreachable: ...", "already removed", "not enrolled"
	Removed          []string
	Left             []string
}

// agentFiles are the only entries removed from the state directory. Anything else found there is
// not ours and is left alone, which is why the directory itself is removed only if it ends up empty.
var agentFiles = []string{"identity.json", "credential", "config.json", "seq", "status.json", RequestFile}

// Uninstall removes the agent completely and works with no network. Running it twice is safe.
//
// Order: read what is needed to tell the console, remove everything, verify, then tell the console with the
// result of the verification. The credential is held in memory for that last step only.
func (e *Env) Uninstall(ctx context.Context) (Report, error) {
	var r Report
	if !e.Installed() {
		r.NothingInstalled = true
		e.say("Nothing is installed. Nothing to remove.")
		return r, nil
	}

	r.Console = "not enrolled"
	var client *api.Client
	var cred string
	st := state.New(e.L.StateDir)
	if id, err := st.LoadIdentity(); err == nil {
		if c, err := api.New(id.ConsoleURL, e.Version); err == nil {
			client = c
			cred, _ = st.LoadCredential()
		} else {
			r.Console = "unreachable: " + err.Error()
		}
	}

	e.Svc.DisableNow()
	for _, u := range []string{e.L.UnitPath, e.L.MaintPathUnit, e.L.MaintServiceUnit} {
		if u != "" && remove(u) {
			r.Removed = append(r.Removed, u)
		}
	}
	e.Svc.Reload()
	if remove(e.L.BinPath) {
		r.Removed = append(r.Removed, e.L.BinPath)
	}
	r.Removed = append(r.Removed, removeStateDir(e.L.StateDir)...)
	if e.L.User != "" && e.Users.Exists(e.L.User) {
		if err := e.Users.Remove(e.L.User); err == nil {
			r.Removed = append(r.Removed, "user "+e.L.User)
		}
	}

	r.Left = e.L.Residue(e.Users)
	if client != nil {
		r.Console = e.notifyRemoved(cred, client, api.RemovalReport{Verified: len(r.Left) == 0, Residue: r.Left})
	}
	e.say("Removed:")
	for _, p := range r.Removed {
		e.say("  %s", p)
	}
	e.say("Console: %s", r.Console)
	if len(r.Left) > 0 {
		e.say("NOT removed: %s", strings.Join(r.Left, ", "))
		return r, fmt.Errorf("%d item(s) could not be removed", len(r.Left))
	}
	e.say("Verified: nothing of the agent remains on this machine.")
	if strings.HasPrefix(r.Console, "unreachable") || r.Console == "no credential to present" {
		e.say("The console could not be told. Mark this node removed in the console, which also revokes its credential.")
	}
	return r, nil
}

// MaintenanceDecommission is what the root-owned maintenance service runs. It acts only if the agent left a
// request file (a regular file, not a link) and reads nothing from it.
func (e *Env) MaintenanceDecommission(ctx context.Context) error {
	fi, err := os.Lstat(e.L.RequestPath())
	if err != nil || !fi.Mode().IsRegular() {
		return errors.New("no decommission request from the agent; nothing was changed")
	}
	_, err = e.Uninstall(ctx)
	return err
}

func remove(p string) bool {
	if err := os.Remove(p); err == nil {
		return true
	}
	return false
}

// removeStateDir deletes the agent's own files and logs, then the directory if nothing else is in it.
func removeStateDir(dir string) []string {
	var done []string
	// This can run as root against a directory the unprivileged agent controls. Never follow a link it planted:
	// if the directory itself is a link, remove the link and nothing behind it.
	if fi, err := os.Lstat(dir); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		if remove(dir) {
			done = append(done, dir)
		}
		return done
	}
	for _, f := range agentFiles {
		if remove(filepath.Join(dir, f)) {
			done = append(done, filepath.Join(dir, f))
		}
	}
	if ents, err := os.ReadDir(dir); err == nil {
		for _, en := range ents {
			if strings.HasPrefix(en.Name(), ".tmp-") && !en.IsDir() && remove(filepath.Join(dir, en.Name())) {
				done = append(done, filepath.Join(dir, en.Name()))
			}
		}
	}
	logs := filepath.Join(dir, "logs")
	if fi, err := os.Lstat(logs); err == nil && fi.Mode()&os.ModeSymlink == 0 {
		for _, f := range []string{"agent.log", "agent.log.1"} {
			if remove(filepath.Join(logs, f)) {
				done = append(done, filepath.Join(logs, f))
			}
		}
	}
	remove(logs) // a link is removed as a link; a directory only if empty
	if remove(dir) {
		done = append(done, dir)
	}
	return done
}

// notifyRemoved tells the console this node is gone. It returns a short description of the outcome.
func (e *Env) notifyRemoved(cred string, client *api.Client, report api.RemovalReport) string {
	if cred == "" {
		return "no credential to present"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := client.NotifyRemoved(ctx, cred, report)
	var apiErr *api.Error
	switch {
	case err == nil:
		return "notified"
	case errors.As(err, &apiErr) && apiErr.Status == 401:
		return "already removed or credential revoked"
	default:
		return "unreachable: " + err.Error()
	}
}
