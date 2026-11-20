package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCustomHTTPSUsesMatchingHostnameAndRestoresLocalFallback(t *testing.T) {
	dir := t.TempDir()
	a := &app{path: filepath.Join(dir, "settings.json")}
	authority, err := loadAuthority(dir)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: serial(),
		DNSNames: []string{"camera.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: privateKey}), 0600); err != nil {
		t.Fatal(err)
	}
	settings := &hostTLSSettings{Hostname: "Wrong.Example.com", Certificate: certPath, Key: keyPath}
	w := httptest.NewRecorder()
	a.applyCustomHTTPS(w, settings)
	if w.Code != 400 {
		t.Fatalf("hostname mismatch accepted: %s", w.Body)
	}

	settings.Hostname = "Camera.Example.com"
	w = httptest.NewRecorder()
	a.applyCustomHTTPS(w, settings)
	if w.Code != 200 {
		t.Fatalf("custom certificate not saved: %s", w.Body)
	}
	restarted := &app{path: a.path}
	restarted.loadCustomHTTPS()
	if hostname := restarted.lanAddress(); hostname != "camera.example.com" {
		t.Fatalf("unexpected pairing hostname after restart: %s", hostname)
	}
	config, err := serverTLS(authority, restarted.customHTTPS.Load)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := config.GetCertificate(&tls.ClientHelloInfo{ServerName: "camera.example.com"})
	if err != nil || cert.Leaf.VerifyHostname("camera.example.com") != nil {
		t.Fatalf("wrong certificate selected for DNS name: %v", err)
	}
	fallback, err := config.GetCertificate(&tls.ClientHelloInfo{})
	if err != nil || fallback.Leaf.VerifyHostname("127.0.0.1") != nil {
		t.Fatalf("local IP certificate lost: %v", err)
	}
	if !restarted.hostOK(false, "camera.example.com:"+lanPort) || restarted.hostOK(false, "other.example.com:"+lanPort) {
		t.Fatal("custom host allowlist incorrect")
	}
	w = httptest.NewRecorder()
	restarted.applyCustomHTTPS(w, nil)
	if w.Code != 200 || restarted.hostOK(false, "camera.example.com:"+lanPort) {
		t.Fatal("local certificate fallback not restored")
	}
}
