package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestSharedPairingRejectsReplayAndActiveCamera(t *testing.T) {
	s := newSlot("Main camera")
	a := &app{cfg: settings{Version: 1, LANAddress: "127.0.0.1", Slots: []slot{s}}, admin: randomID(24),
		invitations: map[string]invitation{}, grants: map[string]grant{}, clients: map[string]*client{}}
	post := func(local bool, endpoint, auth string, request map[string]string, code int) map[string]any {
		t.Helper()
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		host := "https://127.0.0.1:" + lanPort
		if local {
			host = localURL
		}
		r := httptest.NewRequest("POST", host+endpoint, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+auth)
		w := httptest.NewRecorder()
		a.handler(local).ServeHTTP(w, r)
		if w.Code != code {
			t.Fatalf("%s got %d, want %d: %s", request["action"], w.Code, code, w.Body.String())
		}
		var response map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	pair := func() string {
		t.Helper()
		response := post(true, "/api/admin", a.admin, map[string]string{"action": "pair", "id": s.ID, "role": "camera"}, 200)
		u, err := url.Parse(response["url"].(string))
		if err != nil {
			t.Fatal(err)
		}
		return strings.SplitN(u.Fragment, ".", 2)[1]
	}
	enroll := func(ticket string, code int) map[string]any {
		return post(false, "/api/session", "", map[string]string{"action": "enroll", "id": s.ID, "role": "camera", "key": ticket}, code)
	}
	initial := pair()
	if pair() != initial {
		t.Fatal("a second dashboard replaced the open pairing code")
	}
	credential := enroll(initial, 200)["key"].(string)
	joined := post(false, "/api/session", "", map[string]string{"action": "join", "id": s.ID, "role": "camera", "key": credential}, 200)
	client := joined["client"].(string)
	if err := enroll(initial, 401)["error"].(string); !strings.Contains(err, "already scanned") {
		t.Fatal(err)
	}
	if err := enroll("unknown", 401)["error"].(string); !strings.Contains(err, "expired") {
		t.Fatal(err)
	}
	next := pair()
	if next == initial {
		t.Fatal("pairing reused a consumed code")
	}
	if err := enroll(next, 409)["error"].(string); !strings.Contains(err, "already active") {
		t.Fatal(err)
	}
	post(false, "/api/session", client, map[string]string{"action": "poll"}, 200)
	post(false, "/api/session", client, map[string]string{"action": "leave"}, 200)
	enroll(next, 200)
	post(false, "/api/session", "", map[string]string{"action": "join", "id": s.ID, "role": "camera", "key": credential}, 401)
}
