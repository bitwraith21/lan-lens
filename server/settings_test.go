package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPortableSettingsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	original := settings{Version: 1, LANAddress: "192.168.1.42", Slots: []slot{newSlot("Studio camera"), newSlot("Remote camera")}}
	original.Slots[0].Rotation = 270
	original.Slots[0].Camera = cameraPrefs{Facing: "user", Portrait: true, Eco: true, Zoom: 2.5, Resolution: 540}
	export := filepath.Join(dir, "export.json")
	if err := saveSettings(export, original); err != nil {
		t.Fatal(err)
	}
	imported, err := loadImport(export)
	if err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(dir, "active.json")
	if err = saveSettings(active, settings{Version: 1, Slots: []slot{newSlot("Old feed")}}); err != nil {
		t.Fatal(err)
	}
	if err = saveSettings(active, imported); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadSettings(active)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original, loaded) {
		t.Fatal("migration changed preferences or viewer links")
	}
}

func TestRejectInvalidImport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wrong.json")
	for _, file := range []string{
		`{"version":0,"slots":[]}`,
		`{"version":1,"lanAddress":"8.8.8.8","slots":[]}`,
		`{"version":1,"slots":[]} {}`,
		strings.Repeat(" ", 256*1024+1),
	} {
		if err := os.WriteFile(path, []byte(file), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadImport(path); err == nil {
			t.Fatal("invalid import was accepted")
		}
	}
}

func TestRetiredOBSAccordionStillImports(t *testing.T) {
	cfg, err := readSettings(strings.NewReader(`{"version":1,"slots":[],"accordions":{"obs-stats:":true,"trust:":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Accordions["obs-stats:"]; ok || !cfg.Accordions["trust:"] {
		t.Fatalf("unexpected accordion settings: %v", cfg.Accordions)
	}
}
