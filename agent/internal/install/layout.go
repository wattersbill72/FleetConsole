// Package install owns the machine-level lifecycle: install, upgrade, uninstall and the checks that
// prove each of them. Everything that touches the system goes through Layout, Services and Users, so
// the logic is tested against a temporary directory and fakes, and only the thin real
// implementations (systemctl, useradd) need a real machine.
package install

import (
	"fmt"
	"os"
	"path/filepath"

	"fleetconsole/agent/internal/state"
)

const (
	ServiceName      = "fleetagent"
	ServiceUser      = "fleetagent"
	MaintServiceName = "fleetagent-maint.service"
	MaintPathName    = "fleetagent-maint.path"
	RequestFile      = "decommission.request"
)

// Layout is every path the agent owns. Uninstall removes exactly these and nothing else.
type Layout struct {
	BinPath          string
	StateDir         string
	UnitPath         string
	MaintPathUnit    string // watches for the agent's request and starts the maintenance service
	MaintServiceUnit string // runs as root and does one fixed thing
	User             string
}

// DeriveMaint places the two maintenance units beside the main unit.
func (l *Layout) DeriveMaint() {
	dir := filepath.Dir(l.UnitPath)
	l.MaintPathUnit = filepath.Join(dir, MaintPathName)
	l.MaintServiceUnit = filepath.Join(dir, MaintServiceName)
}

func (l Layout) RequestPath() string { return filepath.Join(l.StateDir, RequestFile) }

func DefaultLayout() Layout {
	l := Layout{
		BinPath:  "/usr/local/bin/fleetagent",
		StateDir: state.DefaultDir(),
		UnitPath: "/etc/systemd/system/fleetagent.service",
		User:     ServiceUser,
	}
	l.DeriveMaint()
	return l
}

func (l Layout) LogPath() string { return filepath.Join(l.StateDir, "logs", "agent.log") }

// Unit renders the systemd unit. The agent logs to its own file under the state directory, so removing
// the state directory removes the logs; the unit sends stdout and stderr nowhere.
func (l Layout) Unit() []byte {
	return []byte(fmt.Sprintf(`[Unit]
Description=Fleet Console Edge Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%[1]s
Group=%[1]s
ExecStart=%[2]s run --dir %[3]s --log %[4]s
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=%[3]s
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
`, l.User, l.BinPath, l.StateDir, l.LogPath()))
}

// MaintPath renders the unit that watches for the agent's decommission request. It is root-owned and reacts
// to one file, so the unprivileged agent can ask for removal without being able to do anything else as root.
func (l Layout) MaintPath() []byte {
	return []byte(fmt.Sprintf(`[Unit]
Description=Fleet Console agent maintenance trigger

[Path]
PathExists=%s
Unit=%s

[Install]
WantedBy=multi-user.target
`, l.RequestPath(), MaintServiceName))
}

// MaintService renders the root-run unit. It does exactly one thing, remove the agent, and only if the
// request file exists. It trusts nothing in that file.
func (l Layout) MaintService() []byte {
	return []byte(fmt.Sprintf(`[Unit]
Description=Fleet Console agent maintenance (runs as root, one fixed action)

[Service]
Type=oneshot
User=root
ExecStart=%[1]s maintenance decommission --dir %[2]s --bin %[1]s --unit %[3]s
`, l.BinPath, l.StateDir, l.UnitPath))
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// Residue lists everything of the agent that is still on the machine.
func (l Layout) Residue(u Users) []string {
	var out []string
	for _, p := range []string{l.BinPath, l.UnitPath, l.MaintPathUnit, l.MaintServiceUnit, l.StateDir} {
		if exists(p) {
			out = append(out, p)
		}
	}
	if l.User != "" && u != nil && u.Exists(l.User) {
		out = append(out, "user "+l.User)
	}
	return out
}
