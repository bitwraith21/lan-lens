package main

import (
	"crypto/sha256"
	"encoding/hex"
	"html/template"
	"net"
	"net/http"
	"slices"
	"strings"

	"github.com/skip2/go-qrcode"
)

const trustPort = "48642"

var trustPage = template.Must(template.New("trust").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAN Lens certificate</title><style>
body{font:1rem system-ui;color:#edf1f7;background:#11151d;margin:0}
main{max-width:32rem;margin:auto;padding:24px}
code{display:block;overflow-wrap:anywhere;padding:12px;background:#252d38;border-radius:8px}
a{display:inline-block;padding:10px 14px;border-radius:8px;background:#93edca;color:#10201a;font-weight:650}
</style></head><body><main>
<h1>LAN Lens certificate</h1>
<p>Use this download if your host uses the LAN Lens local certificate. If your host uses HTTPS your phone already trusts, you can go straight to the camera link.</p>
<p>Compare the SHA-256 fingerprint with the one shown in the OBS dock before installing.</p>
<code>{{.Fingerprint}}</code>
<p><a href="/ca">Download CA certificate</a></p>
<p>On Android, search Settings for <strong>Install CA certificate</strong>. On iPhone, open the downloaded certificate in Settings and enable full trust in General → About → Certificate Trust Settings.</p>
<p><a href="{{.Camera}}">Open camera over HTTPS</a></p>
<p>Open this after installing the CA. If Chrome still shows an X or a certificate error, tap the address-bar warning to see the exact error. Enter the camera code from the OBS dock after the connection is trusted.</p>
</main></body></html>`))

func (a *app) trustFingerprint() string {
	hash := sha256.Sum256(a.authority.root.Raw)
	value := strings.ToUpper(hex.EncodeToString(hash[:]))
	groups := make([]string, 0, len(value)/4)
	for len(value) > 0 {
		groups = append(groups, value[:4])
		value = value[4:]
	}
	return strings.Join(groups, " ")
}

func (a *app) downloadCertificate(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="LAN-Lens-Local-CA.cer"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(a.authority.root.Raw)
}

func (a *app) trustHandler(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	remote, _, _ := net.SplitHostPort(r.RemoteAddr)
	if err != nil || port != trustPort || !validIP(remote) ||
		(host != "127.0.0.1" && !slices.Contains(addresses(), host)) {
		http.Error(w, "invalid host", http.StatusBadRequest)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	if r.Method != "GET" {
		http.NotFound(w, r)
		return
	}
	switch r.URL.Path {
	case "/":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		trustPage.Execute(w, struct{ Fingerprint, Camera string }{
			a.trustFingerprint(), "https://" + net.JoinHostPort(host, lanPort) + "/c",
		})
	case "/ca":
		a.downloadCertificate(w)
	default:
		http.NotFound(w, r)
	}
}

func (a *app) trustURL() string {
	if a.customHTTPS.Load() != nil || !a.trustAvailable {
		return ""
	}
	host := a.lanAddress()
	if !validIP(host) || net.ParseIP(host).IsLoopback() {
		return ""
	}
	return "http://" + net.JoinHostPort(host, trustPort) + "/"
}

func (a *app) phoneTrustQR(w http.ResponseWriter) {
	url := a.trustURL()
	if url == "" {
		fail(w, 409, "No phone certificate link is available.")
		return
	}
	image, err := qrcode.Encode(url, qrcode.Medium, 256)
	if err != nil {
		fail(w, 500, "QR encoding failed")
		return
	}
	reply(w, map[string]any{"url": url, "image": image, "fingerprint": a.trustFingerprint()})
}
