//go:build linux

package collect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Collector struct{ prev *cpuSample }

func New() *Collector { return &Collector{} }

// Platform returns the Snapshot "os" value, or an error on a machine the agent does not support.
func Platform() (osName, version string, err error) {
	b, rerr := os.ReadFile("/etc/os-release")
	if rerr != nil {
		return "", "", errors.New("cannot read /etc/os-release")
	}
	r := parseOSRelease(string(b))
	if r["ID"] != "ubuntu" {
		return "", "", errors.New("unsupported operating system: only Ubuntu 24.04 and macOS are supported")
	}
	return "ubuntu", r["VERSION_ID"], nil
}

func readFile(p string) (string, error) {
	b, err := os.ReadFile(p)
	return string(b), err
}

func (c *Collector) sampleCPU() (cpuSample, bool) {
	s, err := readFile("/proc/stat")
	if err != nil {
		return cpuSample{}, false
	}
	cs, err := parseProcStat(s)
	return cs, err == nil
}

func (c *Collector) Collect(ctx context.Context, volumes []string) Host {
	if len(volumes) == 0 {
		volumes = DefaultVolumes
	}
	osName, ver, _ := Platform()
	h := Host{Hostname: hostname(), OS: osName, OSVersion: ver, Disks: []Disk{}, Addresses: ipv4Addresses()}

	// CPU is a delta between two samples. The first heartbeat takes a short second sample so it has a value.
	cur, ok := c.sampleCPU()
	if ok {
		prev := c.prev
		if prev == nil {
			select {
			case <-time.After(250 * time.Millisecond):
			case <-ctx.Done():
			}
			next, ok2 := c.sampleCPU()
			if ok2 {
				h.CPUPct = cpuPercent(cur, next)
				cur = next
			}
		} else {
			h.CPUPct = cpuPercent(*prev, cur)
		}
		c.prev = &cur
	}

	if s, err := readFile("/proc/loadavg"); err == nil {
		h.Load, _ = parseLoadavg(s)
	}
	if s, err := readFile("/proc/meminfo"); err == nil {
		if used, total, err := parseMeminfo(s); err == nil {
			h.MemUsedBytes, h.MemTotalBytes = i64(used), i64(total)
		}
	}
	if s, err := readFile("/proc/uptime"); err == nil {
		h.UptimeS, _ = parseUptimeSeconds(s)
	}
	for _, v := range volumes {
		var st syscall.Statfs_t
		if err := syscall.Statfs(v, &st); err != nil {
			continue
		}
		total := int64(st.Blocks) * int64(st.Bsize)
		h.Disks = append(h.Disks, Disk{Mount: v, TotalBytes: total, UsedBytes: total - int64(st.Bfree)*int64(st.Bsize)})
	}
	h.TemperatureC = hottestThermalZone()
	return h
}

// hottestThermalZone returns the highest thermal-zone reading in °C, or nil if the machine exposes none.
func hottestThermalZone() *float64 {
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	var best *float64
	for _, z := range zones {
		b, err := os.ReadFile(z)
		if err != nil {
			continue
		}
		milli, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
		if err != nil {
			continue
		}
		if c := milli / 1000; best == nil || c > *best {
			best = f64(c)
		}
	}
	return best
}
