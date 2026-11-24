package collect

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The parsers below take text and return values. They are platform-neutral on purpose: the macOS
// formats are exercised by fixture tests on any machine, and only verified live on a real Mac.

type cpuSample struct{ total, idle uint64 }

// parseProcStat reads the aggregate "cpu" line of /proc/stat.
func parseProcStat(s string) (cpuSample, error) {
	for _, line := range strings.Split(s, "\n") {
		f := fields(line)
		if len(f) < 5 || f[0] != "cpu" {
			continue
		}
		var vals []uint64
		for _, x := range f[1:] {
			n, err := strconv.ParseUint(x, 10, 64)
			if err != nil {
				return cpuSample{}, err
			}
			vals = append(vals, n)
		}
		var total uint64
		// user nice system idle iowait irq softirq steal; guest time is already inside user.
		for i := 0; i < len(vals) && i < 8; i++ {
			total += vals[i]
		}
		idle := vals[3]
		if len(vals) > 4 {
			idle += vals[4]
		}
		return cpuSample{total: total, idle: idle}, nil
	}
	return cpuSample{}, errors.New("no cpu line in /proc/stat")
}

// cpuPercent is busy time between two samples, or nil when the interval is empty.
func cpuPercent(a, b cpuSample) *float64 {
	dt := float64(b.total) - float64(a.total)
	di := float64(b.idle) - float64(a.idle)
	if dt <= 0 {
		return nil
	}
	return f64(clampPct(100 * (1 - di/dt)))
}

func parseLoadavg(s string) (*[3]float64, error) {
	f := fields(s)
	if len(f) < 3 {
		return nil, errors.New("short loadavg")
	}
	var out [3]float64
	for i := 0; i < 3; i++ {
		v, err := strconv.ParseFloat(f[i], 64)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return &out, nil
}

// parseMeminfo returns used and total bytes; used = MemTotal - MemAvailable.
func parseMeminfo(s string) (used, total int64, err error) {
	var tot, avail int64 = -1, -1
	for _, line := range strings.Split(s, "\n") {
		f := fields(line)
		if len(f) < 2 {
			continue
		}
		v, perr := strconv.ParseInt(f[1], 10, 64)
		if perr != nil {
			continue
		}
		switch f[0] {
		case "MemTotal:":
			tot = v * 1024
		case "MemAvailable:":
			avail = v * 1024
		}
	}
	if tot < 0 || avail < 0 {
		return 0, 0, errors.New("meminfo lacks MemTotal or MemAvailable")
	}
	return tot - avail, tot, nil
}

func parseUptimeSeconds(s string) (int64, error) {
	f := fields(s)
	if len(f) < 1 {
		return 0, errors.New("empty uptime")
	}
	v, err := strconv.ParseFloat(f[0], 64)
	return int64(v), err
}

func parseOSRelease(s string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			out[k] = strings.Trim(v, `"'`)
		}
	}
	return out
}

var bootSecRe = regexp.MustCompile(`sec\s*=\s*(\d+)`)

// parseBoottime reads `sysctl -n kern.boottime` on macOS: "{ sec = 1700000000, usec = 0 } ...".
func parseBoottime(s string) (int64, error) {
	m := bootSecRe.FindStringSubmatch(s)
	if m == nil {
		return 0, errors.New("unrecognised kern.boottime")
	}
	return strconv.ParseInt(m[1], 10, 64)
}

// parseSysctlLoad reads `sysctl -n vm.loadavg` on macOS: "{ 1.23 1.45 1.56 }".
func parseSysctlLoad(s string) (*[3]float64, error) {
	return parseLoadavg(strings.NewReplacer("{", " ", "}", " ").Replace(s))
}

var (
	pageSizeRe = regexp.MustCompile(`page size of (\d+) bytes`)
	vmLineRe   = regexp.MustCompile(`^(Pages [A-Za-z ]+?|Pages occupied by compressor):\s+(\d+)\.?`)
)

// parseVMStat estimates used memory on macOS as active + wired + compressor pages.
func parseVMStat(s string) (usedBytes int64, err error) {
	page := int64(0)
	if m := pageSizeRe.FindStringSubmatch(s); m != nil {
		page, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if page == 0 {
		return 0, errors.New("vm_stat page size not found")
	}
	pages := map[string]int64{}
	for _, line := range strings.Split(s, "\n") {
		if m := vmLineRe.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			n, _ := strconv.ParseInt(m[2], 10, 64)
			pages[m[1]] = n
		}
	}
	active, okA := pages["Pages active"]
	wired, okW := pages["Pages wired down"]
	if !okA || !okW {
		return 0, errors.New("vm_stat lacks active or wired pages")
	}
	return (active + wired + pages["Pages occupied by compressor"]) * page, nil
}

var topIdleRe = regexp.MustCompile(`CPU usage:.*?([\d.]+)%\s*idle`)

// parseTopCPU reads the last "CPU usage" line of `top -l 2 -n 0` on macOS (the second sample is the
// interval measurement; the first is since boot) and returns busy percent.
func parseTopCPU(s string) (*float64, error) {
	var last []string
	for _, line := range strings.Split(s, "\n") {
		if m := topIdleRe.FindStringSubmatch(line); m != nil {
			last = m
		}
	}
	if last == nil {
		return nil, errors.New("no CPU usage line in top output")
	}
	idle, err := strconv.ParseFloat(last[1], 64)
	if err != nil {
		return nil, fmt.Errorf("bad idle value: %w", err)
	}
	return f64(clampPct(100 - idle)), nil
}
