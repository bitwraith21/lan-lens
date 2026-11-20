package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type obsBinding struct {
	Name   string `json:"name"`
	UUID   string `json:"uuid"`
	Scenes []struct {
		Name string `json:"name"`
	} `json:"scenes"`
}

func (a *app) obsSources() (map[string][]obsBinding, []obsBinding) {
	bindings := make(map[string][]obsBinding)
	vacant := []obsBinding{}
	if a.path == "" {
		return bindings, vacant
	}
	if time.Since(a.lastSnapshot) >= time.Second {
		fmt.Println("SNAPSHOT")
		a.lastSnapshot = time.Now()
	}
	file, err := os.Open(filepath.Join(filepath.Dir(a.path), "obs-bindings.json"))
	if err != nil {
		return bindings, vacant
	}
	defer file.Close()
	var snapshot struct {
		Bindings []struct {
			obsBinding
			ID  string `json:"id"`
			Key string `json:"key"`
		} `json:"bindings"`
	}
	if json.NewDecoder(file).Decode(&snapshot) != nil {
		return bindings, vacant
	}
	for _, entry := range snapshot.Bindings {
		if entry.ID == "" && uuidPattern.MatchString(entry.UUID) {
			vacant = append(vacant, entry.obsBinding)
		} else if idx := a.index(entry.ID); idx >= 0 && same(entry.Key, a.cfg.Slots[idx].ViewerKey) {
			bindings[entry.ID] = append(bindings[entry.ID], entry.obsBinding)
		}
	}
	return bindings, vacant
}

func (a *app) addToOBS(w http.ResponseWriter, r *http.Request, id, source string) {
	a.mu.Lock()
	idx := a.index(id)
	if idx < 0 {
		a.mu.Unlock()
		fail(w, 404, "Feed not found")
		return
	}
	s := a.cfg.Slots[idx]
	request := randomID(9)
	path := filepath.Join(filepath.Dir(a.path), "obs-add-"+request+".txt")
	if source == "" {
		fmt.Printf("ADD %s %s %s\n", s.ID, s.ViewerKey, request)
	} else {
		fmt.Printf("BIND %s %s %s %s\n", s.ID, s.ViewerKey, request, source)
	}
	a.mu.Unlock()

	timer := time.NewTimer(4 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(40 * time.Millisecond)
	defer ticker.Stop()
	defer os.Remove(path)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-timer.C:
			fail(w, 504, "OBS did not confirm the source change. Check the controller before retrying.")
			return
		case <-ticker.C:
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			switch string(data) {
			case "added":
				reply(w, map[string]string{"message": "Feed added to the selected scene."})
			case "already-present":
				reply(w, map[string]string{"message": "This feed is already in the selected scene."})
			case "bound":
				reply(w, map[string]string{"message": "Existing OBS source linked in all its scenes."})
			case "occupied":
				fail(w, 409, "That source is no longer vacant. Choose another source.")
			case "feed-bound":
				fail(w, 409, "This feed already has an OBS source.")
			case "no-scene":
				fail(w, 409, "Select a scene in OBS first.")
			default:
				fail(w, 409, "OBS could not add the feed to the selected scene.")
			}
			return
		}
	}
}

func requestUnbind(s slot) {
	fmt.Printf("UNBIND %s %s\n", s.ID, s.ViewerKey)
}
