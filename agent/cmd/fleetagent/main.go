// fleetagent is the Fleet Console Edge Agent.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"fleetconsole/agent/internal/api"
	"fleetconsole/agent/internal/collect"
	"fleetconsole/agent/internal/runner"
	"fleetconsole/agent/internal/state"
)

// Set at build time: -ldflags "-X main.version=1.2.3"
var version = "0.1.0-dev"

const usage = `fleetagent - Fleet Console Edge Agent

Usage:
  fleetagent enrol --console <url> [--token <token>] [--dir <state dir>]
  fleetagent run   [--once] [--dir <state dir>]
  fleetagent version

The enrolment token may also be given in FLEETAGENT_TOKEN, which keeps it out of the process list.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "enrol":
		err = cmdEnrol(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:])
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
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

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	dir := fs.String("dir", state.DefaultDir(), "state directory")
	once := fs.Bool("once", false, "send one heartbeat and exit")
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
	r := &runner.Runner{
		Store: st, Client: cl, Collector: collect.New(), Version: version,
		Log: log.New(os.Stderr, "fleetagent: ", log.LstdFlags|log.LUTC),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *once {
		resp, err := r.Once(ctx)
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
