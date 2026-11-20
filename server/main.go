package main

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/skip2/go-qrcode"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const localAddr = "127.0.0.1:48640"
const lanPort = "48641"
const localURL = "http://" + localAddr
const lease = 12 * time.Second

//go:embed web/*
var assets embed.FS

type invitation struct {
	slotID, role string
	until        time.Time
	used         bool
}
type grant struct{ invitation }

type message struct {
	Kind  string `json:"kind"`
	Peer  string `json:"peer,omitempty"`
	Value string `json:"value,omitempty"`
}
type client struct {
	slotID, role, grant string
	seen                time.Time
	queue               []message
}
type app struct {
	mu                         sync.Mutex
	dialog                     sync.Mutex
	cfg                        settings
	path, admin, browserAccess string
	authority                  *authority
	addresses                  []string
	invitations                map[string]invitation
	grants                     map[string]grant
	clients                    map[string]*client
}

func main() {
	dir := flag.String("config", "", "OBS plugin settings directory")
	flag.Parse()

	if *dir == "" {
		log.Fatal("missing --config")
	}
	if err := os.MkdirAll(*dir, 0700); err != nil {
		log.Fatal(err)
	}
	if f, err := os.OpenFile(filepath.Join(*dir, "server.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600); err == nil {
		defer f.Close()
		log.SetOutput(f)
	}
	if err := run(*dir); err != nil {
		fmt.Println("ERROR Check LAN Lens server.log in the OBS plugin configuration folder.")
		log.Print(err)
		os.Exit(1)
	}
}

func run(dir string) error {
	a := &app{path: filepath.Join(dir, "settings.json"), admin: randomID(24), addresses: addresses(),
		invitations: map[string]invitation{}, grants: map[string]grant{}, clients: map[string]*client{}}
	var err error
	if a.cfg, err = loadSettings(a.path); err != nil {
		return err
	}
	if err = saveSettings(a.path, a.cfg); err != nil {
		return err
	}
	if a.authority, err = loadAuthority(dir); err != nil {
		return err
	}
	if a.browserAccess, err = loadBrowserAccess(dir); err != nil {
		return fmt.Errorf("browser access: %w", err)
	}
	local, err := net.Listen("tcp4", localAddr)
	if err != nil {
		return fmt.Errorf("dashboard: %w", err)
	}
	defer local.Close()
	lan, err := net.Listen("tcp4", "0.0.0.0:"+lanPort)
	if err != nil {
		return fmt.Errorf("pairing server: %w", err)
	}
	defer lan.Close()
	tlsConfig, err := serverTLS(a.authority)
	if err != nil {
		return err
	}
	server := func(local bool) *http.Server {
		return &http.Server{Handler: a.handler(local), ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout: 10 * time.Second, WriteTimeout: 8 * time.Minute, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 12 << 10}
	}
	tokenPath := filepath.Join(dir, "dashboard-token")
	if err := writeAtomic(tokenPath, []byte(a.admin)); err != nil {
		return err
	}
	defer os.Remove(tokenPath)
	stopped := make(chan error, 3)
	go func() { io.Copy(io.Discard, os.Stdin); stopped <- nil }()
	go func() { stopped <- server(true).Serve(local) }()
	public := server(false)
	public.TLSConfig = tlsConfig
	go func() { stopped <- public.ServeTLS(lan, "", "") }()
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		for range ticker.C {
			a.mu.Lock()
			a.prune()
			a.mu.Unlock()
		}
	}()
	fmt.Println("READY")
	return <-stopped
}

func (a *app) handler(local bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.hostOK(local, r.Host) {
			http.Error(w, "invalid host", 400)
			return
		}
		origin := "https://" + r.Host
		if local {
			origin = localURL
		}
		if incoming := r.Header.Get("Origin"); incoming != "" && incoming != origin {
			http.Error(w, "invalid origin", 403)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
		switch r.URL.Path {
		case "/api/health":
			if local && r.Method == "GET" {
				reply(w, map[string]bool{"ready": true})
				return
			}
		case "/api/browser-access":
			if local && r.Method == "POST" {
				if !same(auth(r), a.admin) {
					fail(w, http.StatusUnauthorized, "Open the browser again from the LAN Lens dock.")
					return
				}
				reply(w, map[string]string{"credential": a.browserAccess})
				return
			}
		case "/api/admin":
			if local && r.Method == "POST" {
				key := auth(r)
				if !same(key, a.admin) && !same(key, a.browserAccess) {
					fail(w, http.StatusUnauthorized, "Open the browser from the LAN Lens dock.")
					return
				}
				a.manage(w, r)
				return
			}
		case "/api/session":
			if r.Method == "POST" {
				a.session(w, r, local)
				return
			}
		case "/ca":
			if local && r.Method == "GET" {
				w.Header().Set("Content-Type", "application/x-x509-ca-cert")
				w.Header().Set("Content-Disposition", `attachment; filename="LAN-Lens-Local-CA.cer"`)
				w.Write(a.authority.root.Raw)
				return
			}
		default:
			if r.Method == "GET" {
				file := map[string]string{"/camera": "camera.html", "/view": "view.html", "/style.css": "style.css", "/client.js": "client.js"}
				if local {
					file["/"] = "dashboard.html"
					file["/dashboard.js"] = "dashboard.js"
				}
				if name := file[r.URL.Path]; name != "" {
					data, err := assets.ReadFile("web/" + name)
					if err != nil {
						http.NotFound(w, r)
						return
					}
					http.ServeContent(w, r, name, time.Time{}, strings.NewReader(string(data)))
					return
				}
			}
		}
		http.NotFound(w, r)
	})
}

func (a *app) hostOK(local bool, host string) bool {
	if local {
		return host == localAddr
	}
	address, port, err := net.SplitHostPort(host)
	return err == nil && port == lanPort && (address == "127.0.0.1" || address == "localhost" ||
		(validIP(address) && slices.Contains(addresses(), address)))
}

func auth(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}
func same(a, b string) bool { return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, err string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": err})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Header.Get("Content-Type") != "application/json" {
		fail(w, 415, "Expected JSON")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		fail(w, 400, "Invalid request")
		return false
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		fail(w, 400, "Invalid request")
		return false
	}
	return true
}
func (a *app) index(id string) int {
	return slices.IndexFunc(a.cfg.Slots, func(s slot) bool { return s.ID == id })
}

func (a *app) lanAddress() string {
	if slices.Contains(a.addresses, a.cfg.LANAddress) || a.cfg.LANAddress == "127.0.0.1" {
		return a.cfg.LANAddress
	}
	if len(a.addresses) > 0 {
		return a.addresses[0]
	}
	return ""
}

func (a *app) save(cfg settings) error {
	if err := saveSettings(a.path, cfg); err != nil {
		log.Print(err)
		return errors.New("Could not save settings")
	}
	a.cfg = cfg
	return nil
}

func (a *app) manage(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Action, ID, Label, Address, Role, Command string
		Rotation                                  int
	}
	if !decode(w, r, &q) {
		return
	}
	if q.Action == "import" || q.Action == "export" || q.Action == "certificate" {
		a.fileAction(w, q.Action)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.prune()
	a.addresses = addresses()
	idx := a.index(q.ID)
	cfg := a.cfg
	cfg.Slots = slices.Clone(cfg.Slots)
	switch q.Action {
	case "state":
		type feed struct {
			slot
			Online bool `json:"online"`
			Views  int  `json:"views"`
		}
		feeds := []feed{}
		for _, s := range cfg.Slots {
			f := feed{slot: s}
			for _, c := range a.clients {
				if c.slotID == s.ID {
					if c.role == "camera" {
						f.Online = true
					} else {
						f.Views++
					}
				}
			}
			feeds = append(feeds, f)
		}
		reply(w, map[string]any{"feeds": feeds, "addresses": a.addresses, "address": a.lanAddress(), "preferredAddress": cfg.LANAddress})
		return
	case "address":
		if q.Address != "" && q.Address != "127.0.0.1" && !slices.Contains(a.addresses, q.Address) {
			fail(w, 400, "Choose a local IPv4 address")
			return
		}
		cfg.LANAddress = q.Address
	case "create", "rename":
		label := strings.TrimSpace(q.Label)
		if label == "" || len(label) > 100 {
			fail(w, 400, "Enter a feed name of 1–100 bytes")
			return
		}
		if q.Action == "create" {
			if len(cfg.Slots) >= 32 {
				fail(w, 409, "Maximum of 32 feeds")
				return
			}
			cfg.Slots = append(cfg.Slots, newSlot(label))
		} else if idx >= 0 {
			cfg.Slots[idx].Label = label
		} else {
			fail(w, 404, "Feed not found")
			return
		}
	default:
		if idx < 0 {
			fail(w, 404, "Feed not found")
			return
		}
		s := cfg.Slots[idx]
		switch q.Action {
		case "delete":
			cfg.Slots = slices.Delete(cfg.Slots, idx, idx+1)
		case "rotate":
			if q.Rotation != 90 && q.Rotation != -90 {
				fail(w, 400, "Invalid rotation")
				return
			}
			cfg.Slots[idx].Rotation = (s.Rotation + q.Rotation + 360) % 360
		case "addToOBS":
			fmt.Printf("ADD %s %s\n", s.ID, s.ViewerKey)
			reply(w, map[string]bool{"ok": true})
			return
		case "command":
			switch q.Command {
			case "identify", "reload-view", "ask-reset", "reload-camera":
			default:
				fail(w, 400, "Invalid command")
				return
			}
			for _, c := range a.clients {
				camera := q.Command == "ask-reset" || q.Command == "reload-camera"
				if c.slotID == s.ID && (c.role == "camera") == camera {
					a.send(c, message{Kind: q.Command})
				}
			}
			reply(w, map[string]bool{"ok": true})
			return
		case "pair":
			address := a.lanAddress()
			if address == "" {
				fail(w, 409, "No LAN IPv4 address found. Connect to the network and restart OBS.")
				return
			}
			if q.Role != "camera" && q.Role != "view" {
				fail(w, 400, "Invalid pairing role")
				return
			}
			var key string
			var ticket invitation
			for candidate, t := range a.invitations {
				if t.slotID == s.ID && t.role == q.Role && !t.used {
					key, ticket = candidate, t
					break
				}
			}
			if key == "" {
				if len(a.invitations) >= 256 {
					fail(w, 429, "Too many recent pairing codes")
					return
				}
				key = randomID(24)
				ticket = invitation{slotID: s.ID, role: q.Role, until: time.Now().Add(5 * time.Minute)}
				a.invitations[key] = ticket
			}
			url := "https://" + net.JoinHostPort(address, lanPort) + "/" + q.Role + "#" + s.ID + "." + key
			png, err := qrcode.Encode(url, qrcode.Medium, 320)
			if err != nil {
				fail(w, 500, "QR encoding failed")
				return
			}
			reply(w, map[string]any{"url": url, "image": png, "expiresAt": ticket.until.UnixMilli()})
			return
		case "disconnect":
			a.revoke(s.ID, "camera")
			reply(w, map[string]bool{"ok": true})
			return
		default:
			fail(w, 400, "Unknown action")
			return
		}
	}
	if err := a.save(cfg); err != nil {
		fail(w, 500, err.Error())
		return
	}
	if q.Action == "delete" {
		a.revoke(q.ID, "")
	}
	reply(w, map[string]bool{"ok": true})
}

func (a *app) fileAction(w http.ResponseWriter, action string) {
	if !a.dialog.TryLock() {
		fail(w, 409, "A file picker is already open")
		return
	}
	defer a.dialog.Unlock()
	certificate := action == "certificate"
	export := action != "import"
	title, filename, ext := "Import LAN Lens settings", "", "json"
	if certificate {
		title, filename, ext = "Save LAN Lens trust certificate", "LAN-Lens-Local-CA.cer", "cer"
	} else if export {
		title, filename = "Export LAN Lens settings", "LAN-Lens-settings.json"
	}
	path, err := chooseFile(export, title, filename, ext)
	if errors.Is(err, errPickerCanceled) {
		reply(w, map[string]bool{"cancelled": true})
		return
	}
	if err != nil {
		fail(w, 500, "Could not select a file: "+err.Error())
		return
	}
	if export {
		if !strings.EqualFold(filepath.Ext(path), "."+ext) {
			fail(w, 400, "Choose a file name ending in ."+ext)
			return
		}
		if filepath.Clean(path) == filepath.Clean(a.path) {
			fail(w, 400, "Choose a destination outside the active settings file.")
			return
		}
		if certificate {
			err = writeAtomic(path, a.authority.root.Raw)
		} else {
			a.mu.Lock()
			err = saveSettings(path, a.cfg)
			a.mu.Unlock()
		}
		if err != nil {
			fail(w, 500, "Could not write the selected file: "+err.Error())
			return
		}
		if err = reveal(path); err != nil {
			reply(w, map[string]any{"path": path, "revealed": false})
			return
		}
		reply(w, map[string]any{"path": path, "revealed": true})
		return
	}
	cfg, err := loadImport(path)
	if err != nil {
		fail(w, 400, "Could not import settings: "+err.Error())
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err = a.save(cfg); err != nil {
		fail(w, 500, err.Error())
		return
	}
	clear(a.clients)
	clear(a.invitations)
	clear(a.grants)
	reply(w, map[string]any{"path": path})
}

func loadImport(path string) (settings, error) {
	f, err := os.Open(path)
	if err != nil {
		return settings{}, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return settings{}, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > 256*1024 {
		return settings{}, errors.New("settings must be a regular file no larger than 256 KB")
	}
	return readSettings(f)
}
