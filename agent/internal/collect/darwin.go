//go:build darwin

package collect

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Collector struct{}

func New() *Collector { return &Collector{} }

func run(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return string(out), err
}

// Platform returns "macos" and the product version.
func Platform() (osName, version string, err error) {
	out, err := run(context.Background(), "sw_vers", "-productVersion")
	if err != nil {
		return "", "", errors.New("cannot determine macOS version")
	}
	return "macos", strings.TrimSpace(out), nil
}

// Collect reads vitals with the system's own tools. Anything that fails stays nil: unavailable, not zero.
func (c *Collector) Collect(ctx context.Context, volumes []string) Host {
	if len(volumes) == 0 {
		volumes = DefaultVolumes
	}
	osName, ver, _ := Platform()
	h := Host{Hostname: hostname(), OS: osName, OSVersion: ver, Disks: []Disk{}, Addresses: ipv4Addresses()}

	if out, err := run(ctx, "sysctl", "-n", "kern.boottime"); err == nil {
		if boot, err := parseBoottime(out); err == nil {
			h.UptimeS = time.Now().Unix() - boot
		}
	}
	if out, err := run(ctx, "sysctl", "-n", "vm.loadavg"); err == nil {
		h.Load, _ = parseSysctlLoad(out)
	}
	if out, err := run(ctx, "sysctl", "-n", "hw.memsize"); err == nil {
		if total, err := strconv.ParseInt(strings.TrimSpace(out), 10, 64); err == nil {
			h.MemTotalBytes = i64(total)
			if vm, err := run(ctx, "vm_stat"); err == nil {
				if used, err := parseVMStat(vm); err == nil {
					h.MemUsedBytes = i64(used)
				}
			}
		}
	}
	// Two samples one second apart; the second is the measured interval.
	if out, err := run(ctx, "top", "-l", "2", "-s", "1", "-n", "0"); err == nil {
		h.CPUPct, _ = parseTopCPU(out)
	}
	for _, v := range volumes {
		var st syscall.Statfs_t
		if err := syscall.Statfs(v, &st); err != nil {
			continue
		}
		total := int64(st.Blocks) * int64(st.Bsize)
		h.Disks = append(h.Disks, Disk{Mount: v, TotalBytes: total, UsedBytes: total - int64(st.Bfree)*int64(st.Bsize)})
	}
	// macOS exposes no temperature without privileged tooling: unavailable.
	return h
}
