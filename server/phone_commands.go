package main

import (
	"net/http"
	"strings"
	"time"
)

type microphoneStatus struct {
	Revision    uint64 `json:"revision"`
	Available   bool   `json:"available"`
	Muted       bool   `json:"muted"`
	Interrupted bool   `json:"interrupted,omitempty"`
}

func (c *client) reportMicrophone(status *microphoneStatus) {
	if status != nil && (!c.liveMic || status.Revision > c.mic.Revision) {
		c.mic = *status
		c.liveMic = true
	}
}

type liveMicrophoneStatus struct {
	microphoneStatus
	Connection uint64 `json:"connection"`
}

type phoneFeedback struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type phoneCommand struct {
	grant             string
	microphoneSession string
	finished          bool
	until             time.Time
	ready             chan struct{}
	result            phoneFeedback
}

type revokedCamera struct {
	reason string
	until  time.Time
}

// Call with the application lock held. The phone may confirm the command
// after reconnecting with the same pairing key.
func (task *phoneCommand) complete(result phoneFeedback) {
	if task.finished {
		return
	}
	task.result = result
	task.finished = true
	close(task.ready)
}

func (a *app) cancelMicrophoneCommands(session string) {
	for _, task := range a.phoneCommands {
		if task.microphoneSession == session {
			task.complete(phoneFeedback{Message: "The phone disconnected before confirming the microphone change."})
		}
	}
}

func (a *app) queuePhoneCommand(w http.ResponseWriter, id, kind, value string, connection uint64) {
	if len(a.phoneCommands) >= 128 {
		fail(w, 429, "Too many phone commands. Try again shortly.")
		return
	}
	for session, c := range a.clients {
		if c.slotID != id || c.role != "camera" {
			continue
		}
		microphoneSession := ""
		if kind == "set-microphone" {
			if connection != 0 && c.connection != connection {
				fail(w, 409, "The phone just reconnected. Use its current microphone button.")
				return
			}
			if !c.mic.Available {
				fail(w, 409, "This phone has no active microphone in LAN Lens.")
				return
			}
			microphoneSession = session
		}
		key := randomID(18)
		if !a.send(c, message{Kind: kind, Value: value, Request: key}) {
			fail(w, 409, "The phone is busy. Try again shortly.")
			return
		}
		if a.phoneCommands == nil {
			a.phoneCommands = make(map[string]*phoneCommand)
		}
		timeout := 18 * time.Second
		if kind == "ask-reset" {
			timeout = 45 * time.Second
		}
		a.phoneCommands[key] = &phoneCommand{grant: c.grant, microphoneSession: microphoneSession, until: time.Now().Add(timeout), ready: make(chan struct{})}
		reply(w, map[string]string{"request": key})
		return
	}
	fail(w, 409, "No available recipient. Start the phone camera first.")
}

func (a *app) acceptPhoneFeedback(w http.ResponseWriter, grantKey, request, message string, success bool, mic *microphoneStatus) {
	task := a.phoneCommands[request]
	if task == nil || !same(task.grant, grantKey) {
		fail(w, 404, "Phone command expired.")
		return
	}
	if _, valid := a.grants[grantKey]; !valid {
		fail(w, 401, "Scan a new pairing code")
		return
	}
	if time.Now().After(task.until) {
		fail(w, 410, "Phone command expired.")
		return
	}
	message = strings.TrimSpace(message)
	if len(message) == 0 || len(message) > 512 {
		fail(w, 400, "Invalid phone confirmation.")
		return
	}
	if !task.finished && task.microphoneSession != "" {
		if c := a.clients[task.microphoneSession]; c != nil {
			c.reportMicrophone(mic)
		}
	}
	task.complete(phoneFeedback{Success: success, Message: message})
	reply(w, map[string]bool{"ok": true})
}

func (a *app) phoneCommandResult(w http.ResponseWriter, r *http.Request, request string) {
	a.mu.Lock()
	task := a.phoneCommands[request]
	a.mu.Unlock()
	if task == nil {
		fail(w, 404, "Phone command expired.")
		return
	}
	select {
	case <-task.ready:
		reply(w, task.result)
		return
	default:
	}
	timer := time.NewTimer(time.Until(task.until))
	defer timer.Stop()
	select {
	case <-task.ready:
		reply(w, task.result)
	case <-r.Context().Done():
	case <-timer.C:
		fail(w, 504, "The phone did not confirm the command.")
	}
}
