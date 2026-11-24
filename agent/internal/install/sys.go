package install

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
)

// Services drives the operating system's service manager. Writing the unit file is the installer's job.
type Services interface {
	Reload() error
	EnableNow() error  // enable at boot and start now
	DisableNow() error // stop and disable; succeeds if the service is already gone
	Restart() error
	Status() (active string, enabled bool)
}

// Users manages the dedicated service account.
type Users interface {
	Exists(name string) bool
	Ensure(name string) (created bool, err error)
	Remove(name string) error
	// ChownAll hands a directory tree to the account.
	ChownAll(root, name string) error
}

// ---- systemd ----

type Systemd struct{}

func sctl(args ...string) (string, error) {
	out, err := exec.Command("systemctl", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (Systemd) Reload() error {
	if out, err := sctl("daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %s", out)
	}
	return nil
}

func (Systemd) EnableNow() error {
	if out, err := sctl("enable", "--now", ServiceName+".service"); err != nil {
		return fmt.Errorf("systemctl enable --now: %s", out)
	}
	return nil
}

func (Systemd) DisableNow() error {
	// "not loaded" and "does not exist" are fine: the goal is that it is gone.
	sctl("disable", "--now", ServiceName+".service")
	return nil
}

func (Systemd) Restart() error {
	if out, err := sctl("restart", ServiceName+".service"); err != nil {
		return fmt.Errorf("systemctl restart: %s", out)
	}
	return nil
}

func (Systemd) Status() (string, bool) {
	active, _ := sctl("is-active", ServiceName+".service")
	enabled, _ := sctl("is-enabled", ServiceName+".service")
	if active == "" {
		active = "unknown"
	}
	return active, enabled == "enabled"
}

// NoServices is used with --no-service (containers, packaging, tests): nothing is registered.
type NoServices struct{}

func (NoServices) Reload() error          { return nil }
func (NoServices) EnableNow() error       { return nil }
func (NoServices) DisableNow() error      { return nil }
func (NoServices) Restart() error         { return nil }
func (NoServices) Status() (string, bool) { return "not managed", false }

// ---- accounts ----

type SystemUsers struct{}

func (SystemUsers) Exists(name string) bool {
	_, err := user.Lookup(name)
	return err == nil
}

func (u SystemUsers) Ensure(name string) (bool, error) {
	if u.Exists(name) {
		return false, nil
	}
	out, err := exec.Command("useradd", "--system", "--user-group", "--no-create-home",
		"--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", name).CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("useradd %s: %s", name, strings.TrimSpace(string(out)))
	}
	return true, nil
}

func (u SystemUsers) Remove(name string) error {
	if !u.Exists(name) {
		return nil
	}
	if out, err := exec.Command("userdel", name).CombinedOutput(); err != nil {
		return fmt.Errorf("userdel %s: %s", name, strings.TrimSpace(string(out)))
	}
	return nil
}

func (SystemUsers) ChownAll(root, name string) error {
	usr, err := user.Lookup(name)
	if err != nil {
		return err
	}
	uid, _ := strconv.Atoi(usr.Uid)
	gid, _ := strconv.Atoi(usr.Gid)
	return filepath.Walk(root, func(p string, _ os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, uid, gid)
	})
}

// NoUsers is used with --no-user: the agent runs as whoever starts it.
type NoUsers struct{}

func (NoUsers) Exists(string) bool            { return false }
func (NoUsers) Ensure(string) (bool, error)   { return false, nil }
func (NoUsers) Remove(string) error           { return nil }
func (NoUsers) ChownAll(string, string) error { return nil }
