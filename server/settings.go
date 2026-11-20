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
	Facing   string  `json:"facing"`
	Portrait bool    `json:"portrait"`
	Eco      bool    `json:"eco"`
	Zoom     float64 `json:"zoom"`
}

type slot struct {
	ID        string      `json:"id"`
	Label     string      `json:"label"`
	ViewerKey string      `json:"viewerKey"`
	Rotation  int         `json:"rotation"`
	Camera    cameraPrefs `json:"camera"`
}

type settings struct {
	Version    int    `json:"version"`
	LANAddress string `json:"lanAddress"`
	Slots      []slot `json:"slots"`
}

var (
	idPattern  = regexp.MustCompile("^[A-Za-z0-9_-]{12}$")
	keyPattern = regexp.MustCompile("^[A-Za-z0-9_-]{32}$")
)

func randomID(n int) string {
	return base64.RawURLEncoding.EncodeToString(randBytes(n))
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func validPrefs(c cameraPrefs) bool {
	return (c.Facing == "user" || c.Facing == "environment") && c.Zoom >= 0 && c.Zoom <= 100
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
	return slot{ID: randomID(9), Label: label, ViewerKey: randomID(24), Camera: cameraPrefs{Facing: "environment"}}
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
