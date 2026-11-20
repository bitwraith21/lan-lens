package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type hostTLSSettings struct {
	Hostname    string
	Certificate string
	Key         string
}

type hostTLS struct {
	settings    hostTLSSettings
	certificate tls.Certificate
}

var dnsName = regexp.MustCompile("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")

func loadHostTLS(settings hostTLSSettings) (*hostTLS, error) {
	settings.Hostname = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(settings.Hostname), "."))
	settings.Certificate = strings.TrimSpace(settings.Certificate)
	settings.Key = strings.TrimSpace(settings.Key)
	if len(settings.Hostname) > 253 || !dnsName.MatchString(settings.Hostname) || net.ParseIP(settings.Hostname) != nil {
		return nil, errors.New("Enter the certificate’s DNS hostname, without https:// or a port.")
	}
	if !filepath.IsAbs(settings.Certificate) || !filepath.IsAbs(settings.Key) {
		return nil, errors.New("Enter full file paths for the PEM certificate chain and private key.")
	}
	cert, err := tls.LoadX509KeyPair(settings.Certificate, settings.Key)
	if err != nil {
		return nil, errors.New("Could not load the PEM certificate chain and its matching private key.")
	}
	if err := cert.Leaf.VerifyHostname(settings.Hostname); err != nil {
		return nil, errors.New("The certificate does not cover that hostname.")
	}
	now := time.Now()
	if now.Before(cert.Leaf.NotBefore) || !now.Before(cert.Leaf.NotAfter) {
		return nil, errors.New("The certificate is outside its validity period.")
	}
	return &hostTLS{settings: settings, certificate: cert}, nil
}

func (a *app) loadCustomHTTPS() {
	data, err := os.ReadFile(filepath.Join(filepath.Dir(a.path), "https.json"))
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err == nil {
		var settings hostTLSSettings
		if err = json.Unmarshal(data, &settings); err == nil {
			var custom *hostTLS
			if custom, err = loadHostTLS(settings); err == nil {
				a.customHTTPS.Store(custom)
				return
			}
		}
	}
	log.Print("Custom HTTPS unavailable. Using the LAN Lens certificate: ", err)
}

func (a *app) applyCustomHTTPS(w http.ResponseWriter, settings *hostTLSSettings) {
	path := filepath.Join(filepath.Dir(a.path), "https.json")
	a.mu.Lock()
	defer a.mu.Unlock()
	if settings == nil {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			fail(w, 500, "Could not remove the custom HTTPS settings.")
			return
		}
		a.customHTTPS.Store(nil)
		reply(w, map[string]bool{"ok": true})
		return
	}
	custom, err := loadHostTLS(*settings)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	data, err := json.Marshal(custom.settings)
	if err != nil || writeAtomic(path, data) != nil {
		fail(w, 500, "Could not save the custom HTTPS settings.")
		return
	}
	a.customHTTPS.Store(custom)
	reply(w, map[string]bool{"ok": true})
}
