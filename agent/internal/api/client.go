// Package api talks to the console. All traffic is outbound HTTPS (loopback http is allowed for tests only).
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	base      string
	http      *http.Client
	userAgent string
}

func New(consoleURL, version string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(consoleURL, "/"))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid console address %q", consoleURL)
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname())) {
		return nil, errors.New("console address must be https")
	}
	return &Client{
		base:      u.String(),
		http:      &http.Client{Timeout: 20 * time.Second},
		userAgent: "fleetagent/" + version,
	}, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Error is a refusal from the console, with the machine code and human message it sent.
type Error struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *Error) Error() string { return e.Message }

type EnrolRequest struct {
	Token        string `json:"token"`
	OS           string `json:"os"`
	Hostname     string `json:"hostname"`
	OSVersion    string `json:"os_version"`
	AgentVersion string `json:"agent_version"`
}

type EnrolResponse struct {
	NodeID     string                    `json:"node_id"`
	Credential string                    `json:"credential"`
	Farm       struct{ ID, Name string } `json:"farm"`
	Config     json.RawMessage           `json:"config"`
}

func (c *Client) Enrol(ctx context.Context, r EnrolRequest) (*EnrolResponse, error) {
	body, _ := json.Marshal(r)
	resp, err := c.do(ctx, "/api/enrol", "", body)
	if err != nil {
		return nil, err
	}
	var out EnrolResponse
	if err := json.Unmarshal(resp, &out); err != nil {
		return nil, fmt.Errorf("unreadable enrol response: %w", err)
	}
	return &out, nil
}

type SnapshotResponse struct {
	OK                   bool              `json:"ok"`
	Duplicate            bool              `json:"duplicate"`
	LastSeq              int64             `json:"last_seq"`
	DesiredConfigVersion int               `json:"desired_config_version"`
	Commands             []json.RawMessage `json:"commands"`
}

func (c *Client) SendSnapshot(ctx context.Context, credential string, snapshot []byte) (*SnapshotResponse, error) {
	resp, err := c.do(ctx, "/api/ingest/snapshot", credential, snapshot)
	if err != nil {
		return nil, err
	}
	var out SnapshotResponse
	if err := json.Unmarshal(resp, &out); err != nil {
		return nil, fmt.Errorf("unreadable heartbeat response: %w", err)
	}
	return &out, nil
}

func (c *Client) do(ctx context.Context, path, bearer string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return data, nil
	}
	e := &Error{Status: resp.StatusCode, Message: fmt.Sprintf("console returned HTTP %d", resp.StatusCode)}
	var parsed struct{ Code, Error string }
	if json.Unmarshal(data, &parsed) == nil {
		e.Code = parsed.Code
		if parsed.Error != "" {
			e.Message = parsed.Error
		}
	}
	if secs, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && secs > 0 {
		e.RetryAfter = time.Duration(secs) * time.Second
	}
	return nil, e
}

// Ping checks that the console accepts this credential, without storing anything.
func (c *Client) Ping(ctx context.Context, credential string) error {
	_, err := c.do(ctx, "/api/ingest/ping", credential, []byte("{}"))
	return err
}

// NotifyRemoved tells the console this node has been removed from the machine, so it is marked
// removed and its credentials are revoked. Best effort by design: removal never depends on it.
func (c *Client) NotifyRemoved(ctx context.Context, credential string) error {
	_, err := c.do(ctx, "/api/ingest/removed", credential, []byte("{}"))
	return err
}

// Host returns the console's host:port, for the connectivity test.
func (c *Client) Host() (host, port string) {
	u, _ := url.Parse(c.base)
	host, port = u.Hostname(), u.Port()
	if port == "" {
		port = "443"
		if u.Scheme == "http" {
			port = "80"
		}
	}
	return host, port
}
