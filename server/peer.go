package main

import (
	"net"
	"net/http"
	"strings"
	"time"
)

const pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func shortPairingCode() string {
	code := randBytes(6)
	for i, b := range code {
		code[i] = pairingAlphabet[int(b)&31]
	}
	return string(code)
}

type attemptWindow struct {
	count int
	until time.Time
}

func (a *app) send(c *client, m message) bool {
	if len(c.queue) >= 64 {
		return false
	}
	c.queue = append(c.queue, m)
	return true
}
func (a *app) drop(id string) {
	c := a.clients[id]
	if c == nil {
		return
	}
	delete(a.clients, id)
	if c.role == "camera" {
		a.cancelMicrophoneCommands(id)
	}
	for _, peer := range a.clients {
		if peer.slotID == c.slotID && peer.role != c.role {
			a.send(peer, message{Kind: "gone", Peer: id})
		}
	}
}
func (a *app) revoke(slotID, role, reason string) {
	for key, t := range a.invitations {
		if !t.used && t.slotID == slotID && (role == "" || t.role == role) {
			delete(a.invitations, key)
		}
	}
	for key, t := range a.grants {
		if t.slotID == slotID && (role == "" || t.role == role) {
			delete(a.grants, key)
		}
	}
	for id, c := range a.clients {
		if c.slotID == slotID && (role == "" || c.role == role) {
			if c.role == "camera" && reason != "" {
				if a.revokedCameras == nil {
					a.revokedCameras = make(map[string]revokedCamera)
				}
				a.revokedCameras[id] = revokedCamera{reason: reason, until: time.Now().Add(time.Minute)}
			}
			a.drop(id)
		}
	}
}
func (a *app) prune() {
	now := time.Now()
	for key, task := range a.phoneCommands {
		if now.After(task.until.Add(time.Minute)) {
			delete(a.phoneCommands, key)
		}
	}
	for id, camera := range a.revokedCameras {
		if now.After(camera.until) {
			delete(a.revokedCameras, id)
		}
	}
	for ip, window := range a.pairingFailures {
		if now.After(window.until) {
			delete(a.pairingFailures, ip)
		}
	}
	if now.After(a.allPairingFailures.until) {
		a.allPairingFailures = attemptWindow{}
	}
	for key, t := range a.invitations {
		if now.After(t.until) {
			delete(a.invitations, key)
		}
	}
	for key, t := range a.grants {
		if now.After(t.until) {
			delete(a.grants, key)
		}
	}
	for id, c := range a.clients {
		_, valid := a.grants[c.grant]
		if now.Sub(c.seen) > lease || (c.grant != "" && !valid) {
			a.drop(id)
		}
	}
}

func (a *app) session(w http.ResponseWriter, r *http.Request, local bool) {
	var q struct {
		Action, ID, Role, Key, Peer, Kind, Value string
		Camera                                   cameraPrefs
		Width, Height                            int
		Request, Result                          string
		Success, Microphone                      bool
		Mic                                      *microphoneStatus
	}
	if !decode(w, r, &q) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.prune()
	if q.Action == "feedback" && !local {
		a.acceptPhoneFeedback(w, auth(r), q.Request, q.Result, q.Success, q.Mic)
		return
	}
	if q.Action == "enroll" {
		if local {
			fail(w, 401, "Open the pairing link on the phone or display.")
			return
		}
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		limit := a.pairingFailures[ip]
		if limit.count >= 8 || a.allPairingFailures.count >= 40 {
			fail(w, 429, "Too many invalid pairing attempts. Try again in a minute.")
			return
		}
		code := strings.ToUpper(q.Key)
		t, ok := a.invitations[code]
		if !ok || (q.ID != "" && t.slotID != q.ID) || t.role != q.Role || a.index(t.slotID) < 0 {
			until := time.Now().Add(time.Minute)
			if a.pairingFailures == nil {
				a.pairingFailures = make(map[string]attemptWindow)
			}
			if limit.count == 0 {
				limit.until = until
			}
			limit.count++
			a.pairingFailures[ip] = limit
			if a.allPairingFailures.count == 0 {
				a.allPairingFailures.until = until
			}
			a.allPairingFailures.count++
			fail(w, 401, "This pairing code expired or was cancelled. Ask for a new link.")
			return
		}
		q.ID = t.slotID
		if t.used {
			fail(w, 401, "This QR code was already scanned. Open LAN Lens and scan a new code.")
			return
		}
		if q.Role == "camera" {
			for _, c := range a.clients {
				if c.slotID == q.ID && c.role == "camera" {
					fail(w, 409, "A camera is already active on this feed. Stop or unpair it in LAN Lens before connecting another camera.")
					return
				}
			}
		}
		if len(a.grants) >= 256 {
			fail(w, 429, "Too many paired devices")
			return
		}
		if q.Role == "camera" {
			a.revoke(q.ID, "camera", "")
		}
		t.used = true
		a.invitations[code] = t
		key := randomID(24)
		t.until = time.Now().Add(24 * time.Hour)
		a.grants[key] = grant{t}
		s := a.cfg.Slots[a.index(q.ID)]
		reply(w, map[string]any{"key": key, "id": s.ID, "label": s.Label, "camera": s.Camera})
		return
	}
	if q.Action == "join" || q.Action == "inspect" {
		idx := a.index(q.ID)
		if idx < 0 {
			fail(w, 404, "Feed no longer exists")
			return
		}
		s := a.cfg.Slots[idx]
		grantKey := ""
		if !(local && q.Role == "view" && same(s.ViewerKey, q.Key)) {
			g, ok := a.grants[q.Key]
			if local || !ok || g.role != q.Role || g.slotID != q.ID {
				fail(w, 401, "Scan a new pairing code")
				return
			}
			grantKey = q.Key
		}
		if q.Action == "inspect" {
			reply(w, map[string]any{"label": s.Label, "camera": s.Camera})
			return
		}
		if len(a.clients) >= 128 {
			fail(w, 429, "Too many active camera and display sessions")
			return
		}
		id := randomID(24)
		c := &client{slotID: q.ID, role: q.Role, grant: grantKey, seen: time.Now()}
		if c.role == "camera" {
			a.nextCameraConnection++
			c.connection = a.nextCameraConnection
			c.mic = microphoneStatus{Available: q.Microphone, Muted: s.Camera.Muted}
			c.reportMicrophone(q.Mic)
			for old, v := range a.clients {
				if v.slotID == q.ID && v.role == "camera" {
					a.drop(old)
				}
			}
		}
		a.clients[id] = c
		for pid, peer := range a.clients {
			if peer.slotID != q.ID || peer.role == c.role {
				continue
			}
			if c.role == "camera" {
				a.send(c, message{Kind: "viewer", Peer: pid})
			} else {
				a.send(peer, message{Kind: "viewer", Peer: id})
			}
		}
		reply(w, map[string]any{"client": id, "label": s.Label, "rotation": s.Rotation, "camera": s.Camera})
		return
	}
	id := auth(r)
	c := a.clients[id]
	if revoked, ok := a.revokedCameras[id]; ok && !local && q.Action == "poll" {
		fail(w, 410, revoked.reason)
		return
	}
	if c == nil || local != (c.grant == "") {
		fail(w, 401, "Session expired")
		return
	}
	c.seen = time.Now()
	idx := a.index(c.slotID)
	if idx < 0 {
		fail(w, 404, "Feed no longer exists")
		return
	}
	s := a.cfg.Slots[idx]
	switch q.Action {
	case "poll":
		if c.role == "camera" {
			c.reportMicrophone(q.Mic)
		}
		now := time.Now()
		queue := []message{}
		for _, msg := range c.queue {
			task := a.phoneCommands[msg.Request]
			if msg.Request == "" || (task != nil && !task.finished && now.Before(task.until)) {
				queue = append(queue, msg)
			}
		}
		c.queue = nil
		reply(w, map[string]any{"messages": queue, "rotation": s.Rotation, "label": s.Label})
		return
	case "signal":
		target := a.clients[q.Peer]
		if target == nil || target.slotID != c.slotID || target.role == c.role {
			fail(w, 409, "Peer left")
			return
		}
		if !((c.role == "camera" && q.Kind == "offer") || (c.role == "view" && q.Kind == "answer")) || len(q.Value) == 0 || len(q.Value) > 65535 {
			fail(w, 400, "Invalid WebRTC description")
			return
		}
		a.send(target, message{Kind: q.Kind, Peer: id, Value: q.Value})
	case "dimensions":
		if c.role != "view" || q.Width < 0 || q.Height < 0 || q.Width > 16384 || q.Height > 16384 {
			fail(w, 400, "Invalid display dimensions")
			return
		}
		c.frameWidth, c.frameHeight = q.Width, q.Height
	case "prefs":
		if c.role != "camera" || !validPrefs(q.Camera) {
			fail(w, 400, "Invalid camera settings")
			return
		}
		if !c.liveMic {
			c.mic = microphoneStatus{Available: q.Microphone, Muted: q.Camera.Muted}
		}
		if s.Camera == q.Camera {
			break
		}
		cfg := a.cfg
		cfg.Slots = append([]slot(nil), cfg.Slots...)
		cfg.Slots[idx].Camera = q.Camera
		if err := a.save(cfg); err != nil {
			fail(w, 500, err.Error())
			return
		}
	case "leave":
		a.drop(id)
	default:
		fail(w, 400, "Unknown action")
		return
	}
	reply(w, map[string]bool{"ok": true})
}
