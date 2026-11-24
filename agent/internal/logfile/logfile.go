// Package logfile is a size-capped rotating log writer. The agent owns its log so that uninstalling
// it can remove every trace; nothing is left behind in a system journal's care.
package logfile

import (
	"os"
	"path/filepath"
	"sync"
)

const DefaultMaxBytes = 1 << 20 // 1 MiB per file, one rotated copy: 2 MiB ceiling

type Writer struct {
	path string
	max  int64

	mu   sync.Mutex
	f    *os.File
	size int64
}

func New(path string, maxBytes int64) (*Writer, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	w := &Writer{path: path, max: maxBytes}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *Writer) open() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	w.f, w.size = f, st.Size()
	return nil
}

func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.size+int64(len(p)) > w.max {
		w.f.Close()
		if err := os.Rename(w.path, w.path+".1"); err != nil {
			return 0, err
		}
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Close()
}
