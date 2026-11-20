package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserAccessSurvivesNewInstance(t *testing.T) {
	dir := t.TempDir()
	firstKey, err := loadBrowserAccess(dir)
	if err != nil {
		t.Fatal(err)
	}
	local := &app{admin: randomID(24), browserAccess: firstKey}
	request := func(a *app, onHost bool, path, key string, want int) *httptest.ResponseRecorder {
		t.Helper()
		base := "https://127.0.0.1:" + lanPort
		if onHost {
			base = localURL
		}
		req := httptest.NewRequest("POST", base+path, strings.NewReader(`{"action":"state"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		resp := httptest.NewRecorder()
		a.handler(onHost).ServeHTTP(resp, req)
		if resp.Code != want {
			t.Fatalf("%s returned %d, want %d", path, resp.Code, want)
		}
		return resp
	}
	request(local, true, "/api/admin", "", 401)
	request(local, true, "/api/browser-access", firstKey, 401)
	request(local, false, "/api/browser-access", local.admin, 404)
	resp := request(local, true, "/api/browser-access", local.admin, 200)
	var pair struct{ Credential string }
	if err := json.Unmarshal(resp.Body.Bytes(), &pair); err != nil || pair.Credential != firstKey {
		t.Fatal("authorized launch did not grant browser access")
	}
	nextKey, err := loadBrowserAccess(dir)
	if err != nil {
		t.Fatal(err)
	}
	restarted := &app{admin: randomID(24), browserAccess: nextKey}
	request(restarted, true, "/api/admin", local.admin, 401)
	request(restarted, true, "/api/admin", pair.Credential, 200)
	request(restarted, false, "/api/admin", pair.Credential, 404)
}
