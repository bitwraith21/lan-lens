"use strict";

const cacheName = "lanlens-camera-v12";
const shell = ["/c", "/style.css", "/ui.js", "/optics.js", "/client.js", "/camera.webmanifest",
  "/camera-192.png", "/camera-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName)
    .then(cache => Promise.allSettled(shell.map(path => cache.add(path))))
    .then(() => self.skipWaiting()));

});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith("lanlens-camera-") && name !== cacheName).map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = url.pathname === "/camera" ? "/c" : url.pathname;
  if (shell.includes(path)) event.respondWith(fetch(event.request).catch(async () =>
    (await (await caches.open(cacheName)).match(path)) || Response.error()));
});
