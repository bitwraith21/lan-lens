package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

func validIP(address string) bool {
	ip := net.ParseIP(address)
	return ip != nil && ip.To4() != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())
}

func addresses() []string {
	found := []string{}
	if conn, err := net.Dial("udp4", "192.0.2.1:9"); err == nil {
		addr := conn.LocalAddr().(*net.UDPAddr).IP.String()
		conn.Close()
		if validIP(addr) && !net.ParseIP(addr).IsLoopback() {
			found = append(found, addr)
		}
	}
	all, _ := net.InterfaceAddrs()
	for _, a := range all {
		ip, _, _ := net.ParseCIDR(a.String())
		if ip != nil && !ip.IsLoopback() && validIP(ip.String()) && !slices.Contains(found, ip.String()) {
			found = append(found, ip.String())
		}
	}
	return found
}

func serial() *big.Int { return new(big.Int).SetBytes(append([]byte{1}, randBytes(16)...)) }

type authority struct {
	root *x509.Certificate
	key  *ecdsa.PrivateKey
}

// The local trust identity stays on its original host.
func loadAuthority(dir string) (*authority, error) {
	path := filepath.Join(dir, "local-identity.pem")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		allowed := []*net.IPNet{}
		for _, block := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"} {
			_, network, _ := net.ParseCIDR(block)
			allowed = append(allowed, network)
		}
		root := x509.Certificate{PermittedDNSDomainsCritical: true, PermittedDNSDomains: []string{"localhost"}, PermittedIPRanges: allowed, SerialNumber: serial(), Subject: pkix.Name{CommonName: "LAN Lens Local Camera CA"},
			NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(5, 0, 0),
			IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
		cert, err := x509.CreateCertificate(rand.Reader, &root, &root, &key.PublicKey, key)
		if err != nil {
			return nil, err
		}
		private, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			return nil, err
		}
		data = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})
		data = append(data, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: private})...)
		if err = writeAtomic(path, data); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	a := new(authority)
	cert, rest := pem.Decode(data)
	key, _ := pem.Decode(rest)
	if cert == nil || key == nil {
		return nil, errors.New("invalid local TLS identity")
	}
	if a.root, err = x509.ParseCertificate(cert.Bytes); err != nil {
		return nil, err
	}
	if a.key, err = x509.ParseECPrivateKey(key.Bytes); err != nil {
		return nil, err
	}
	if time.Until(a.root.NotAfter) < time.Hour {
		return nil, errors.New("local TLS identity has expired")
	}

	return a, nil
}

func (a *authority) leaf(lan []string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	ips := []net.IP{net.IPv4(127, 0, 0, 1)}
	for _, address := range lan {
		ips = append(ips, net.ParseIP(address))
	}
	leaf := x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "LAN Lens Camera Pairing"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(0, 0, 7),
		IPAddresses: ips, DNSNames: []string{"localhost"},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, &leaf, a.root, &key.PublicKey, a.key)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: parsed}, nil
}

func serverTLS(a *authority, custom func() *hostTLS) (*tls.Config, error) {
	lan := addresses()
	cert, err := a.leaf(lan)
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	return &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if identity := custom(); identity != nil && strings.EqualFold(hello.ServerName, identity.settings.Hostname) {
			return &identity.certificate, nil
		}
		mu.Lock()
		defer mu.Unlock()
		current := addresses()
		if !slices.Equal(lan, current) || time.Until(cert.Leaf.NotAfter) < 24*time.Hour {
			next, err := a.leaf(current)
			if err != nil {
				return nil, err
			}
			cert, lan = next, current
		}
		return cert, nil
	}}, nil
}
