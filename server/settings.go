package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type cameraPrefs struct {
	Facing     string  `json:"facing"`
	Framing    string  `json:"framing,omitempty"`
	Portrait   bool    `json:"portrait"`
	Muted      bool    `json:"muted,omitempty"`
	Eco        bool    `json:"eco"`
	Zoom       float64 `json:"zoom"`
	Resolution int     `json:"resolution,omitempty"`
}

type slot struct {
	ID        string      `json:"id"`
	Label     string      `json:"label"`
	ViewerKey string      `json:"viewerKey"`
	Rotation  int         `json:"rotation"`
	Camera    cameraPrefs `json:"camera"`
}

type settings struct {
	Version    int             `json:"version"`
	LANAddress string          `json:"lanAddress"`
	Slots      []slot          `json:"slots"`
	Accordions map[string]bool `json:"accordions,omitempty"`
}

var (
	idPattern   = regexp.MustCompile("^[A-Za-z0-9_-]{12}$")
	keyPattern  = regexp.MustCompile("^[A-Za-z0-9_-]{32}$")
	uuidPattern = regexp.MustCompile("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
)

func randomID(n int) string {
	return base64.RawURLEncoding.EncodeToString(randBytes(n))
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func accordionKey(section, id string) bool {
	return ((section == "trust" || section == "https") && id == "") ||
		(idPattern.MatchString(id) && (section == "setup" || section == "sources" || section == "controls" || section == "resolution"))
}

func validResolution(value int) bool {
	return value == 0 || value == 360 || value == 540 || value == 720 || value == 1080
}

func validPrefs(c cameraPrefs) bool {
	return (c.Framing == "" || c.Framing == "auto" || c.Framing == "crop") && validResolution(c.Resolution) && (c.Facing == "user" || c.Facing == "environment") && c.Zoom >= 0 && c.Zoom <= 100
}

func readSettings(in io.Reader) (settings, error) {
	var cfg settings
	dec := json.NewDecoder(io.LimitReader(in, 256*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return cfg, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return cfg, errors.New("unexpected data after settings")
	}
	if cfg.Version != 1 || len(cfg.Slots) > 32 || (cfg.LANAddress != "" && !validIP(cfg.LANAddress)) {
		return cfg, errors.New("unsupported settings version, address or feed count")
	}
	ids := map[string]bool{}
	for _, s := range cfg.Slots {
		if !idPattern.MatchString(s.ID) || !keyPattern.MatchString(s.ViewerKey) || ids[s.ID] ||
			strings.TrimSpace(s.Label) == "" || len(s.Label) > 100 || s.Rotation < 0 || s.Rotation >= 360 || s.Rotation%90 != 0 || !validPrefs(s.Camera) {
			return cfg, errors.New("invalid or duplicate feed in settings file")
		}
		ids[s.ID] = true
	}
	// Accept exports from versions that included the OBS statistics panel.
	delete(cfg.Accordions, "obs-stats:")
	for key := range cfg.Accordions {
		section, id, ok := strings.Cut(key, ":")
		if !ok || !accordionKey(section, id) || (id != "" && !ids[id]) {
			return cfg, errors.New("invalid dashboard section")
		}
	}
	if cfg.Slots == nil {
		cfg.Slots = []slot{}
	}
	return cfg, nil
}

func loadSettings(path string) (settings, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return settings{Version: 1, Slots: []slot{newSlot("Camera 1")}}, nil
	}
	if err != nil {
		return settings{}, err
	}
	defer f.Close()
	return readSettings(f)
}

func newSlot(label string) slot {
	return slot{ID: randomID(9), Label: label, ViewerKey: randomID(24), Camera: cameraPrefs{Facing: "environment", Portrait: true, Framing: "auto"}}
}

func writeAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".lan-lens-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func saveSettings(path string, cfg settings) error {
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(b, '\n'))
}

var errPickerCanceled = errors.New("file picker cancelled")

func loadBrowserAccess(dir string) (string, error) {
	path := filepath.Join(dir, "browser-access-token")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key := randomID(24)
		return key, writeAtomic(path, []byte(key))
	}
	if err != nil {
		return "", err
	}
	key := string(data)
	if !keyPattern.MatchString(key) {
		return "", errors.New("invalid browser credential file")
	}
	return key, nil
}
