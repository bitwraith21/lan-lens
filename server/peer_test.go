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
		if u.Path != "/c" || len(u.Fragment) != 6 || strings.Trim(u.Fragment, pairingAlphabet) != "" {
			t.Fatalf("invalid short pairing link: %s", u)
		}
		return u.Fragment
	}
	enroll := func(ticket string, code int) map[string]any {
		return post(false, "/api/session", "", map[string]string{"action": "enroll", "role": "camera", "key": ticket}, code)
	}
	initial := pair()
	if pair() != initial {
		t.Fatal("a second dashboard replaced the open pairing code")
	}
	enrolled := enroll(strings.ToLower(initial), 200)
	if enrolled["id"] != s.ID {
		t.Fatal("short code did not resolve the feed")
	}
	credential := enrolled["key"].(string)
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
	post(false, "/api/session", "", map[string]string{"action": "inspect", "id": s.ID, "role": "camera", "key": credential}, 200)
	post(false, "/api/session", client, map[string]string{"action": "poll"}, 200)
	post(false, "/api/session", client, map[string]string{"action": "leave"}, 200)
	enroll(next, 200)
	for i := 0; i < 7; i++ {
		enroll("wrong", 401)
	}
	enroll("wrong", 429)
	post(false, "/api/session", "", map[string]string{"action": "join", "id": s.ID, "role": "camera", "key": credential}, 401)
}

func TestMicrophoneCommandEndsWithItsConnection(t *testing.T) {
	const grantKey = "phone"
	first := &client{role: "camera", slotID: "feed", grant: grantKey, connection: 1}
	first.reportMicrophone(&microphoneStatus{Available: true, Revision: 1})
	a := &app{clients: map[string]*client{"first": first}, grants: map[string]grant{grantKey: {}}}

	w := httptest.NewRecorder()
	a.queuePhoneCommand(w, "feed", "set-microphone", "true", first.connection)
	if w.Code != 200 || len(first.queue) != 1 {
		t.Fatalf("microphone command not queued: %d %s", w.Code, w.Body)
	}
	request := first.queue[0].Request
	a.drop("first")
	select {
	case <-a.phoneCommands[request].ready:
	default:
		t.Fatal("disconnect left the command pending")
	}
	if a.phoneCommands[request].result.Success {
		t.Fatal("disconnect marked the microphone command successful")
	}

	second := &client{role: "camera", slotID: "feed", grant: grantKey, connection: 2}
	second.reportMicrophone(&microphoneStatus{Available: true, Revision: 1})
	a.clients["second"] = second
	w = httptest.NewRecorder()
	a.acceptPhoneFeedback(w, grantKey, request, "late reply", true, &microphoneStatus{Available: true, Muted: true, Revision: 2})
	if w.Code != 200 || a.phoneCommands[request].result.Success || second.mic.Muted {
		t.Fatal("a reply from the old command changed the replacement session")
	}
	w = httptest.NewRecorder()
	a.queuePhoneCommand(w, "feed", "set-microphone", "true", first.connection)
	if w.Code != 409 || len(second.queue) != 0 {
		t.Fatalf("stale command reached the replacement session: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	a.queuePhoneCommand(w, "feed", "set-microphone", "true", second.connection)
	if w.Code != 200 || len(second.queue) != 1 {
		t.Fatalf("replacement session did not accept a command: %d %s", w.Code, w.Body)
	}
}

func TestMicrophoneTelemetryRejectsOlderSamples(t *testing.T) {
	c := &client{}
	c.reportMicrophone(&microphoneStatus{Available: true, Muted: true, Revision: 3})
	c.reportMicrophone(&microphoneStatus{Available: true, Revision: 2})
	if !c.mic.Muted {
		t.Fatal("an older sample replaced the current microphone status")
	}
	c.reportMicrophone(&microphoneStatus{Available: true, Interrupted: true, Revision: 4})
	if !c.mic.Interrupted || c.mic.Muted {
		t.Fatal("the latest camera status was not applied")
	}
}
