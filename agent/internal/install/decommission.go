package install

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"
)

// DirectDecommissioner removes the agent in-process. It is used when the agent already runs with the rights
// to do so (as root). The unprivileged service uses RequestDecommissioner instead.
type DirectDecommissioner struct{ Env *Env }

func (d DirectDecommissioner) Decommission(ctx context.Context, commandID string) error {
	rep, err := d.Env.Uninstall(ctx)
	if err != nil {
		return fmt.Errorf("could not remove everything: %w", err)
	}
	_ = rep
	return nil
}

// RequestDecommissioner asks the root-owned maintenance unit to do the removal. The agent only drops a
// request file in its own state directory; a root-owned systemd path unit sees it and runs one fixed
// action. The agent then waits to be stopped. If nothing happens within Wait, it says so and carries on.
type RequestDecommissioner struct {
	L    Layout
	Wait time.Duration
}

func (r RequestDecommissioner) Decommission(ctx context.Context, commandID string) error {
	f, err := os.OpenFile(r.L.RequestPath(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("could not write the removal request: %w", err)
	}
	fmt.Fprintf(f, "decommission %s\n", commandID) // informational; the helper reads nothing from it
	f.Close()

	wait := r.Wait
	if wait == 0 {
		wait = 2 * time.Minute
	}
	select {
	case <-ctx.Done():
		return ctx.Err() // the helper stopped this service: removal is under way
	case <-time.After(wait):
		os.Remove(r.L.RequestPath())
		return errors.New("the maintenance helper did not remove the agent within " + wait.String())
	}
}
