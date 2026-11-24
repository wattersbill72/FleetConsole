package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOnlyHTTPSExceptLoopback(t *testing.T) {
	for _, u := range []string{"http://console.example.com", "ftp://x", "console.example.com", ""} {
		if _, err := New(u, "t"); err == nil {
			t.Errorf("%q should be refused", u)
		}
	}
	for _, u := range []string{"https://console.example.com", "http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"} {
		if _, err := New(u, "t"); err != nil {
			t.Errorf("%q should be accepted: %v", u, err)
		}
	}
}

func TestRefusalsCarryCodeMessageAndRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/enrol":
			w.WriteHeader(410)
			w.Write([]byte(`{"code":"token_used","error":"This enrolment token has already been used."}`))
		default:
			w.Header().Set("Retry-After", "17")
			w.WriteHeader(429)
			w.Write([]byte(`{"error":"Rate limit exceeded"}`))
		}
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "t")

	_, err := c.Enrol(context.Background(), EnrolRequest{Token: "x"})
	e, ok := err.(*Error)
	if !ok || e.Status != 410 || e.Code != "token_used" || e.Message != "This enrolment token has already been used." {
		t.Fatalf("%#v", err)
	}
	_, err = c.SendSnapshot(context.Background(), "fcn_x", []byte(`{}`))
	e, ok = err.(*Error)
	if !ok || e.Status != 429 || e.RetryAfter != 17*time.Second {
		t.Fatalf("%#v", err)
	}
}

func TestBearerIsSentOnlyOnIngest(t *testing.T) {
	var enrolAuth, ingestAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/enrol" {
			enrolAuth = r.Header.Get("Authorization")
			w.WriteHeader(201)
			w.Write([]byte(`{"node_id":"n","credential":"fcn_c","farm":{"ID":"f","Name":"home"},"config":{"version":1}}`))
			return
		}
		ingestAuth = r.Header.Get("Authorization")
		w.Write([]byte(`{"ok":true,"last_seq":1,"desired_config_version":1,"commands":[]}`))
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "t")
	if _, err := c.Enrol(context.Background(), EnrolRequest{Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SendSnapshot(context.Background(), "fcn_c", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if enrolAuth != "" || ingestAuth != "Bearer fcn_c" {
		t.Fatalf("enrol=%q ingest=%q", enrolAuth, ingestAuth)
	}
}
