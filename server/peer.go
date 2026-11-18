package main

import (
	"net/http"
	"time"
)

func (a *app) send(c *client, m message) {
	if len(c.queue) < 64 {
		c.queue = append(c.queue, m)
	}
}
func (a *app) drop(id string) {
	c := a.clients[id]
	if c == nil {
		return
	}
	delete(a.clients, id)
	for _, peer := range a.clients {
		if peer.slotID == c.slotID && peer.role != c.role {
			a.send(peer, message{Kind: "gone", Peer: id})
		}
	}
}
func (a *app) revoke(slotID, role string) {
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
			a.drop(id)
		}
	}
}
func (a *app) prune() {
	now := time.Now()
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
	}
	if !decode(w, r, &q) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.prune()
	if q.Action == "enroll" {
		t, ok := a.invitations[q.Key]
		if local || !ok || t.slotID != q.ID || t.role != q.Role {
			fail(w, 401, "This QR code expired or was cancelled. Open LAN Lens and scan a new code.")
			return
		}
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
			a.revoke(q.ID, "camera")
		}
		t.used = true
		a.invitations[q.Key] = t
		key := randomID(24)
		t.until = time.Now().Add(24 * time.Hour)
		a.grants[key] = grant{t}
		s := a.cfg.Slots[a.index(q.ID)]
		reply(w, map[string]any{"key": key, "label": s.Label, "camera": s.Camera})
		return
	}
	if q.Action == "join" {
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
		if len(a.clients) >= 128 {
			fail(w, 429, "Too many active camera and display sessions")
			return
		}
		id := randomID(24)
		c := &client{slotID: q.ID, role: q.Role, grant: grantKey, seen: time.Now()}
		if c.role == "camera" {
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
		queue := c.queue
		if queue == nil {
			queue = []message{}
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
	case "prefs":
		if c.role != "camera" || !validPrefs(q.Camera) {
			fail(w, 400, "Invalid camera settings")
			return
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
