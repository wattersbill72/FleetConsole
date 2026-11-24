package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRotatesAtTheCapAndKeepsOneBackup(t *testing.T) {
	p := filepath.Join(t.TempDir(), "logs", "agent.log")
	w, err := New(p, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	line := strings.Repeat("x", 39) + "\n" // 40 bytes
	for i := 0; i < 10; i++ {
		if _, err := w.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	entries, _ := os.ReadDir(filepath.Dir(p))
	if len(entries) != 2 {
		t.Fatalf("want agent.log and agent.log.1, got %v", entries)
	}
	for _, e := range entries {
		fi, _ := e.Info()
		if fi.Size() > 100 || fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s size %d mode %o", e.Name(), fi.Size(), fi.Mode().Perm())
		}
	}
	if st, _ := os.Stat(filepath.Dir(p)); st.Mode().Perm() != 0o700 {
		t.Fatalf("log dir mode %o", st.Mode().Perm())
	}
}
