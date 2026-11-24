//go:build !linux && !darwin

package collect

import (
	"context"
	"errors"
)

type Collector struct{}

func New() *Collector { return &Collector{} }

func Platform() (string, string, error) {
	return "", "", errors.New("unsupported operating system: only Ubuntu 24.04 and macOS are supported")
}

func (c *Collector) Collect(ctx context.Context, volumes []string) Host {
	return Host{Hostname: hostname(), Disks: []Disk{}, Addresses: []string{}}
}
