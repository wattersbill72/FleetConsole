package collect

import "testing"

func TestProcStatAndCPUPercent(t *testing.T) {
	a, err := parseProcStat("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1 1\n")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := parseProcStat("cpu  200 0 200 750 150 0 0 0 0 0\n")
	// delta: total 300 (100+100+50+50), idle 100 -> busy 66.7%
	p := cpuPercent(a, b)
	if p == nil || *p < 66.6 || *p > 66.7 {
		t.Fatalf("got %v", p)
	}
	if cpuPercent(a, a) != nil {
		t.Fatal("an empty interval must be unavailable, not 0")
	}
	if _, err := parseProcStat("garbage"); err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadavgMeminfoUptime(t *testing.T) {
	l, err := parseLoadavg("0.52 0.41 0.30 1/345 6789\n")
	if err != nil || l[0] != 0.52 || l[2] != 0.30 {
		t.Fatalf("%v %v", l, err)
	}
	used, total, err := parseMeminfo("MemTotal:       16000000 kB\nMemFree: 1 kB\nMemAvailable:    4000000 kB\n")
	if err != nil || total != 16000000*1024 || used != 12000000*1024 {
		t.Fatalf("%d %d %v", used, total, err)
	}
	if _, _, err := parseMeminfo("MemTotal: 1 kB\n"); err == nil {
		t.Fatal("missing MemAvailable must be an error")
	}
	if u, err := parseUptimeSeconds("12345.67 9999.0\n"); err != nil || u != 12345 {
		t.Fatalf("%d %v", u, err)
	}
}

func TestOSRelease(t *testing.T) {
	r := parseOSRelease("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\n")
	if r["ID"] != "ubuntu" || r["VERSION_ID"] != "24.04" {
		t.Fatalf("%v", r)
	}
}

// macOS formats. These fixtures reflect the documented output of the tools; they are verified live
// on a real Mac during the R1 acceptance run.
func TestMacOSBoottimeLoad(t *testing.T) {
	if s, err := parseBoottime("{ sec = 1700000000, usec = 123456 } Tue Nov 14 22:13:20 2023\n"); err != nil || s != 1700000000 {
		t.Fatalf("%d %v", s, err)
	}
	l, err := parseSysctlLoad("{ 1.23 1.45 1.56 }\n")
	if err != nil || l[0] != 1.23 || l[1] != 1.45 || l[2] != 1.56 {
		t.Fatalf("%v %v", l, err)
	}
}

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                          150000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         80000.
Pages purgeable:                          20000.
Pages occupied by compressor:             40000.
`

func TestMacOSVMStat(t *testing.T) {
	used, err := parseVMStat(vmStat)
	want := int64(200000+80000+40000) * 16384
	if err != nil || used != want {
		t.Fatalf("got %d want %d (%v)", used, want, err)
	}
	if _, err := parseVMStat("nonsense"); err == nil {
		t.Fatal("expected error")
	}
}

func TestMacOSTopUsesTheSecondSample(t *testing.T) {
	out := `Processes: 400 total
CPU usage: 30.00% user, 20.00% sys, 50.00% idle
Processes: 400 total
CPU usage: 5.26% user, 9.21% sys, 85.53% idle
`
	p, err := parseTopCPU(out)
	if err != nil || p == nil || *p < 14.46 || *p > 14.48 {
		t.Fatalf("%v %v", p, err)
	}
	if _, err := parseTopCPU("nothing useful"); err == nil {
		t.Fatal("expected error")
	}
}
