// Package collect reads host vitals. A value the platform does not expose is nil, never zero.
package collect

import (
	"net"
	"os"
	"sort"
	"strings"
)

type Disk struct {
	Mount      string `json:"mount"`
	UsedBytes  int64  `json:"used_bytes"`
	TotalBytes int64  `json:"total_bytes"`
}

// Host is the Snapshot v1 "host" group. Pointer fields marshal to JSON null when unavailable.
type Host struct {
	Hostname      string      `json:"hostname"`
	OS            string      `json:"os"`
	OSVersion     string      `json:"os_version"`
	UptimeS       int64       `json:"uptime_s"`
	CPUPct        *float64    `json:"cpu_pct"`
	Load          *[3]float64 `json:"load"`
	MemUsedBytes  *int64      `json:"mem_used_bytes"`
	MemTotalBytes *int64      `json:"mem_total_bytes"`
	Disks         []Disk      `json:"disks"`
	Addresses     []string    `json:"addresses"`
	TemperatureC  *float64    `json:"temperature_c"`
}

func f64(v float64) *float64 { return &v }
func i64(v int64) *int64     { return &v }

// DefaultVolumes is what is reported when Desired Config names no volumes.
var DefaultVolumes = []string{"/"}

func hostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown"
	}
	return h
}

// ipv4Addresses lists non-loopback, non-link-local IPv4 addresses of interfaces that are up.
func ipv4Addresses() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return []string{}
	}
	seen := map[string]bool{}
	out := []string{}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || ip.IsLinkLocalUnicast() || seen[ip.String()] {
				continue
			}
			seen[ip.String()] = true
			out = append(out, ip.String())
		}
	}
	sort.Strings(out)
	if len(out) > 16 {
		out = out[:16]
	}
	return out
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func fields(s string) []string { return strings.Fields(s) }
