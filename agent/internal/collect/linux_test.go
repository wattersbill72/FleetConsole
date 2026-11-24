//go:build linux

package collect

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestLiveCollectOnThisMachine(t *testing.T) {
	if _, _, err := Platform(); err != nil {
		t.Skip("not Ubuntu:", err)
	}
	c := New()
	h := c.Collect(context.Background(), nil)
	if h.OS != "ubuntu" || h.OSVersion == "" || h.Hostname == "" {
		t.Fatalf("%+v", h)
	}
	if h.CPUPct == nil || *h.CPUPct < 0 || *h.CPUPct > 100 {
		t.Fatalf("cpu %v", h.CPUPct)
	}
	if h.Load == nil || h.MemTotalBytes == nil || *h.MemTotalBytes <= 0 || *h.MemUsedBytes <= 0 || *h.MemUsedBytes > *h.MemTotalBytes {
		t.Fatalf("load/mem %+v", h)
	}
	if h.UptimeS <= 0 {
		t.Fatalf("uptime %d", h.UptimeS)
	}
	if len(h.Disks) != 1 || h.Disks[0].Mount != "/" || h.Disks[0].TotalBytes <= 0 || h.Disks[0].UsedBytes > h.Disks[0].TotalBytes {
		t.Fatalf("disks %+v", h.Disks)
	}
	// Second call uses the stored sample. /proc/stat ticks every 10 ms, so leave a real interval between calls.
	time.Sleep(300 * time.Millisecond)
	if h2 := c.Collect(context.Background(), []string{"/", "/definitely/not/a/mount"}); h2.CPUPct == nil || len(h2.Disks) != 1 {
		t.Fatalf("second collect %+v", h2)
	}
}

func TestUnavailableVitalsMarshalAsNullNotZero(t *testing.T) {
	b, _ := json.Marshal(Host{Hostname: "h", OS: "macos", OSVersion: "15", Disks: []Disk{}, Addresses: []string{}})
	s := string(b)
	for _, want := range []string{`"cpu_pct":null`, `"load":null`, `"mem_used_bytes":null`, `"temperature_c":null`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %s in %s", want, s)
		}
	}
}
