// fleetagent is the Fleet Console Edge Agent.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"fleetconsole/agent/internal/api"
	"fleetconsole/agent/internal/cli"
	"fleetconsole/agent/internal/collect"
	"fleetconsole/agent/internal/install"
	"fleetconsole/agent/internal/logfile"
	"fleetconsole/agent/internal/runner"
	"fleetconsole/agent/internal/state"
)

// Set at build time: -ldflags "-X main.version=1.2.3"
var version = "0.1.0-dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, cli.Help())
		os.Exit(2)
	}
	var err error
	args := os.Args[2:]
	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "enrol":
		err = cmdEnrol(args)
	case "run":
		err = cmdRun(args)
	case "install":
		err = cmdInstall(args)
	case "uninstall":
		err = cmdUninstall(args)
	case "maintenance":
		err = cmdMaintenance(args)
	case "status":
		err = withCLI(args, func(e *cli.Env) error { return e.Status() })
	case "config":
		err = withCLI(args, func(e *cli.Env) error { return e.Config() })
	case "selfcheck":
		err = withCLI(args, func(e *cli.Env) error { return e.Selfcheck() })
	case "test":
		err = withCLI(args, func(e *cli.Env) error { return e.Test(context.Background()) })
	case "-h", "--help", "help":
		fmt.Print(cli.Help())
	default:
		fmt.Fprint(os.Stderr, cli.Help())
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// layoutFlags registers the flags that move the agent's paths. They exist for containers, packaging and
// tests; a normal install never uses them.
type layoutFlags struct {
	dir, bin, unit    *string
	noService, noUser *bool
}

func addLayoutFlags(fs *flag.FlagSet) layoutFlags {
	d := install.DefaultLayout()
	return layoutFlags{
		dir:       fs.String("dir", d.StateDir, "state directory"),
		bin:       fs.String("bin", d.BinPath, "where the program is installed"),
		unit:      fs.String("unit", d.UnitPath, "service unit path"),
		noService: fs.Bool("no-service", false, "do not register or manage a system service"),
		noUser:    fs.Bool("no-user", false, "do not create a service account; run as the invoking user"),
	}
}

func (f layoutFlags) env(out io.Writer) *install.Env {
	l := install.DefaultLayout()
	l.StateDir, l.BinPath, l.UnitPath = *f.dir, *f.bin, *f.unit
	l.DeriveMaint()
	e := &install.Env{L: l, Svc: install.Systemd{}, Users: install.SystemUsers{}, Out: out, Version: version, HeartbeatWait: 30 * time.Second}
	if *f.noService {
		e.Svc = install.NoServices{}
		e.HeartbeatWait = 0
	}
	if *f.noUser {
		e.Users = install.NoUsers{}
		e.L.User = ""
	}
	return e
}

func withCLI(args []string, fn func(*cli.Env) error) error {
	fs := flag.NewFlagSet("cmd", flag.ExitOnError)
	lf := addLayoutFlags(fs)
	fs.Parse(args)
	return fn(&cli.Env{Install: lf.env(os.Stdout), Version: version, Out: os.Stdout})
}

func requireRoot(lf layoutFlags) error {
	if os.Geteuid() != 0 && !*lf.noService && !*lf.noUser {
		return fmt.Errorf("this needs root; run it with sudo")
	}
	return nil
}

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	lf := addLayoutFlags(fs)
	console := fs.String("console", "", "console address, https://...")
	token := fs.String("token", os.Getenv("FLEETAGENT_TOKEN"), "enrolment token")
	upgrade := fs.Bool("upgrade", false, "replace the program on an existing installation, keeping identity and configuration")
	reinstall := fs.Bool("reinstall", false, "remove the existing installation and enrol again (needs a new token)")
	fs.Parse(args)
	if err := requireRoot(lf); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	e := lf.env(os.Stdout)
	err = e.Install(context.Background(), install.Options{
		ConsoleURL: *console, Token: *token, SelfPath: self, Upgrade: *upgrade, Reinstall: *reinstall,
	})
	if err != nil {
		os.Exit(1) // the installer has already said what failed and what it undid
	}
	return nil
}

func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	lf := addLayoutFlags(fs)
	fs.Parse(args)
	if err := requireRoot(lf); err != nil {
		return err
	}
	_, err := lf.env(os.Stdout).Uninstall(context.Background())
	return err
}

func cmdEnrol(args []string) error {
	fs := flag.NewFlagSet("enrol", flag.ExitOnError)
	console := fs.String("console", "", "console address, https://...")
	token := fs.String("token", os.Getenv("FLEETAGENT_TOKEN"), "enrolment token")
	dir := fs.String("dir", state.DefaultDir(), "state directory")
	fs.Parse(args)
	if *console == "" || *token == "" {
		return fmt.Errorf("--console and a token (--token or FLEETAGENT_TOKEN) are required")
	}

	st := state.New(*dir)
	if st.Enrolled() {
		id, _ := st.LoadIdentity()
		return fmt.Errorf("this machine is already enrolled as node %s; remove the agent first to enrol again", id.NodeID)
	}
	osName, osVersion, err := collect.Platform()
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	cl, err := api.New(*console, version)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := cl.Enrol(ctx, api.EnrolRequest{
		Token: *token, OS: osName, Hostname: host, OSVersion: osVersion, AgentVersion: version,
	})
	if err != nil {
		return err
	}
	id := state.Identity{NodeID: resp.NodeID, ConsoleURL: *console, FarmID: resp.Farm.ID, FarmName: resp.Farm.Name}
	if err := st.SaveEnrolment(id, resp.Credential, resp.Config); err != nil {
		return err
	}
	fmt.Printf("Enrolled. node %s, farm %s, console %s\n", id.NodeID, id.FarmName, id.ConsoleURL)
	return nil
}

func cmdMaintenance(args []string) error {
	if len(args) < 1 || args[0] != "decommission" {
		return fmt.Errorf("usage: fleetagent maintenance decommission (run by the service manager, not by hand)")
	}
	fs := flag.NewFlagSet("maintenance", flag.ExitOnError)
	lf := addLayoutFlags(fs)
	fs.Parse(args[1:])
	if err := requireRoot(lf); err != nil {
		return err
	}
	return lf.env(os.Stdout).MaintenanceDecommission(context.Background())
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	lf := addLayoutFlags(fs)
	dir := lf.dir
	once := fs.Bool("once", false, "send one heartbeat and exit")
	logPath := fs.String("log", "", "write the log to this file (rotating) instead of stderr")
	fs.Parse(args)

	st := state.New(*dir)
	id, err := st.LoadIdentity()
	if err != nil {
		return err
	}
	if err := st.CheckPermissions(); err != nil {
		return fmt.Errorf("refusing to run: %w", err)
	}
	cl, err := api.New(id.ConsoleURL, version)
	if err != nil {
		return err
	}
	var logOut io.Writer = os.Stderr
	if *logPath != "" {
		lw, err := logfile.New(*logPath, logfile.DefaultMaxBytes)
		if err != nil {
			return err
		}
		defer lw.Close()
		logOut = lw
	}
	logger := log.New(logOut, "fleetagent: ", log.LstdFlags|log.LUTC)
	r := &runner.Runner{
		Store: st, Client: cl, Collector: collect.New(), Version: version, Log: logger,
	}
	// Running with the rights to remove itself: do it in-process. As the unprivileged service: ask the
	// root-owned maintenance unit (DEC-006).
	var summary io.Writer = logOut // the log, which removal then deletes along with everything else
	if *once {
		summary = os.Stdout
	}
	ienv := lf.env(summary)
	if os.Geteuid() == 0 {
		r.Decommission = install.DirectDecommissioner{Env: ienv}
	} else {
		r.Decommission = install.RequestDecommissioner{L: ienv.L}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *once {
		resp, err := r.OnceRecorded(ctx)
		if errors.Is(err, runner.ErrDecommissioned) {
			fmt.Println("The console asked this agent to remove itself, and it has.")
			return nil
		}
		if err != nil {
			return fmt.Errorf("%s", runner.Describe(err))
		}
		fmt.Printf("heartbeat accepted (last_seq %d, duplicate %v)\n", resp.LastSeq, resp.Duplicate)
		return nil
	}
	r.Log.Printf("started, version %s, node %s, console %s", version, id.NodeID, id.ConsoleURL)
	err = r.Run(ctx)
	r.Log.Printf("stopped")
	return err
}
