"use strict";
const byId = id => document.getElementById(id);
const role = document.body.dataset.role;
const camera = role === "camera";
const remote = location.protocol === "https:";
const video = byId("media");
const [feed, invitation] = location.hash.slice(1).split(".");
const savedKey = "lanlens:" + role + ":" + feed;
const peers = new Map();
let credential = remote ? sessionStorage.getItem(savedKey) : invitation;
let session = "";
let stream;
let inputStream;
let zoomControl;
let cycle = 0;
let wakeLock;
let light = false;
let rotation = 0;
let zoomTimer;
let badgeTimer;
let prefs = {facing: "environment", portrait: false, eco: false, zoom: 0};

function status(text, error = false) {
  byId("status").textContent = text;
  byId("status").dataset.error = error;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(action, fields = {}, id = session) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch("/api/session", {
      method: "POST",
      headers: {"Content-Type": "application/json", Authorization: "Bearer " + id},
      body: JSON.stringify({action, ...fields}),
      signal: controller.signal
    });
  } catch {
    throw Error("Could not reach LAN Lens. Check that OBS is open and both devices are on the same network.");
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json();
  if (!response.ok) throw Object.assign(Error(body.error), {code: response.status});
  return body;
}

function clearPeer(id) {
  const pc = peers.get(id);
  if (!pc) return;
  peers.delete(id);
  pc.close();
  if (!camera && peers.size === 0) {
    video.srcObject = null;
    byId("overlay").hidden = false;
    byId("play").hidden = true;
    status("Waiting for camera…");
  }
}

function peer(id) {
  clearPeer(id);
  const pc = new RTCPeerConnection({iceServers: []});
  peers.set(id, pc);
  pc.onconnectionstatechange = () => {
    if (peers.get(id) !== pc) return;
    if (pc.connectionState === "failed") {
      clearPeer(id);
      if (!camera) retryViewer();
    }
    if (camera) cameraStatus();
  };
  return pc;
}

function cameraStatus() {
  if (!stream) return;
  const connected = [...peers.values()].filter(p => p.connectionState === "connected").length;
  status(connected ? "Live · " + connected + (connected === 1 ? " viewer" : " viewers") : "Camera on · waiting for a viewer");
}

function gather(pc) {
  return new Promise(resolve => {
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    function done() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    const timer = setTimeout(done, 2500);
    pc.addEventListener("icegatheringstatechange", check);
    check();
  });
}

async function signal(kind, id, pc) {
  const origin = session;
  await gather(pc);
  if (session !== origin || peers.get(id) !== pc || !pc.localDescription) return;
  await api("signal", {kind, peer: id, value: pc.localDescription.sdp}, origin);
}

function applyRotation(value) {
  rotation = value;
  const quarterTurn = value % 180 !== 0;
  video.style.width = (quarterTurn ? innerHeight : innerWidth) + "px";
  video.style.height = (quarterTurn ? innerWidth : innerHeight) + "px";
  video.style.transform = "translate(-50%, -50%) rotate(" + value + "deg)";
}

async function showVideo() {
  try {
    await video.play();
    byId("overlay").hidden = true;
  } catch {
    status("Camera connected");
    byId("play").hidden = false;
  }
}

async function handle(msg, label) {
  const id = msg.peer;
  switch (msg.kind) {
    case "gone":
      clearPeer(id);
      if (camera) cameraStatus();
      break;
    case "viewer": {
      if (!stream) break;
      const pc = peer(id);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      await pc.setLocalDescription(await pc.createOffer());
      await signal("offer", id, pc);
      break;
    }
    case "offer": {
      const pc = peer(id);
      pc.ontrack = event => {
        if (peers.get(id) !== pc) return;
        if (event.streams[0]) video.srcObject = event.streams[0];
        showVideo();
      };
      await pc.setRemoteDescription({type: "offer", sdp: msg.value});
      await pc.setLocalDescription(await pc.createAnswer());
      await signal("answer", id, pc);
      break;
    }
    case "answer": {
      const pc = peers.get(id);
      if (pc?.signalingState === "have-local-offer") await pc.setRemoteDescription({type: "answer", sdp: msg.value});
      break;
    }
    case "identify":
      byId("identify").textContent = label;
      byId("identify").hidden = false;
      clearTimeout(badgeTimer);
      badgeTimer = setTimeout(() => { byId("identify").hidden = true; }, 2500);
      break;
    case "ask-reset":
      if (confirm("OBS requested a camera restart. Restart now?")) await restartCapture();
      break;
    case "reload-camera":
      await restartCapture();
      break;
    case "reload-view":
      await retryViewer();
      break;
  }
}

async function connect(token) {
  while (cycle === token) {
    try {
      if (!session) {
        const joined = await api("join", {id: feed, role, key: credential}, "");
        if (token !== cycle) {api("leave", {}, joined.client).catch(() => {}); return;}
        session = joined.client;
        if (camera) {
          byId("label").textContent = joined.label;
          cameraStatus();
          writePrefs();
        } else {
          document.title = joined.label + " · LAN Lens";
          applyRotation(joined.rotation);
          status("Waiting for camera…");
        }
      }
      const data = await api("poll");
      if (token !== cycle) return;
      if (!camera && rotation !== data.rotation) applyRotation(data.rotation);
      if (camera) byId("label").textContent = data.label;
      for (const message of data.messages) {
        handle(message, data.label).catch(err => {
          if (err.code === 409 || err.code === 401) return;
          if (token === cycle) status("Connection: " + err.message);
        });
      }
      await delay(600);
    } catch (err) {
      if (token !== cycle) return;
      const wasJoined = Boolean(session);
      session = "";
      for (const id of peers.keys()) clearPeer(id);
      if ((err.code === 401 || err.code === 404) && !wasJoined) {
        if (remote) sessionStorage.removeItem(savedKey);
        if (camera) {
          stopCapture();
          byId("start").disabled = true;
        }
        status(err.message);
        return;
      }
      status("Reconnecting…");
      await delay(900);
    }
  }
}

function endSession() {
  cycle++;
  const previous = session;
  session = "";
  for (const id of peers.keys()) clearPeer(id);
  return previous ? api("leave", {}, previous).catch(() => {}) : Promise.resolve();
}

async function retryViewer() {
  await endSession();
  connect(cycle);
}

function syncControls() {
  byId("facing").value = prefs.facing;
  byId("portrait").checked = prefs.portrait;
  byId("eco").checked = prefs.eco;
  byId("preview").hidden = prefs.eco;
  document.body.dataset.portrait = prefs.portrait;
}

function writePrefs() {
  if (session) api("prefs", {camera: prefs}).catch(err => status(err.message));
}

async function devices() {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
  const picker = byId("camera");
  const old = picker.value;
  picker.replaceChildren(new Option("Automatic lens", ""));
  inputs.forEach((d, i) => picker.add(new Option(d.label || "Camera " + (i + 1), d.deviceId)));
  if (inputs.some(d => d.deviceId === old)) picker.value = old;
}

async function cameraZoom(input, track, caps) {
  const hardware = caps.zoom;
  if (hardware && Number.isFinite(hardware.min) && hardware.max > hardware.min) {
    const apply = value => track.applyConstraints({advanced: [{zoom: value}]});
    const value = Math.min(hardware.max, Math.max(hardware.min, prefs.zoom || track.getSettings().zoom || 1));
    try {
      await apply(value);
      return {media: input, min: hardware.min, max: hardware.max, step: hardware.step || .1, value, apply};
    } catch {
      // The browser may advertise zoom that the selected lens cannot apply.
    }
  }

  const canvas = document.createElement("canvas");
  if (!canvas.captureStream) return null;
  const context = canvas.getContext("2d", {alpha: false});
  if (!context) return null;
  const source = document.createElement("video");
  source.muted = source.playsInline = true;
  source.className = "zoom-capture";
  source.setAttribute("aria-hidden", "true");
  document.body.append(source);
  source.srcObject = new MediaStream([track]);

  let output;
  let scheduled;
  const frameCallbacks = Boolean(source.requestVideoFrameCallback);
  const value = Math.min(4, Math.max(1, prefs.zoom || 1));
  let magnification = value;
  function draw() {
    const width = source.videoWidth;
    const height = source.videoHeight;
    if (width && height) {
      const scale = Math.min(1, 1280 / Math.max(width, height));
      const frameWidth = Math.max(2, Math.floor(width * scale / 2) * 2);
      const frameHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
      if (canvas.width !== frameWidth) canvas.width = frameWidth;
      if (canvas.height !== frameHeight) canvas.height = frameHeight;
      const w = width / magnification;
      const h = height / magnification;
      context.drawImage(source, (width - w) / 2, (height - h) / 2, w, h, 0, 0, frameWidth, frameHeight);
    }
  }
  function schedule() {
    if (frameCallbacks) scheduled = source.requestVideoFrameCallback(update);
    else scheduled = setTimeout(update, 33);
  }
  function update() {
    draw();
    schedule();
  }
  function close() {
    if (frameCallbacks && scheduled !== undefined) source.cancelVideoFrameCallback(scheduled);
    else clearTimeout(scheduled);
    output?.stop();
    source.pause();
    source.srcObject = null;
    source.remove();
  }
  try {
    await source.play();
    draw();
    [output] = canvas.captureStream(30).getVideoTracks();
    if (!output) throw Error("Canvas capture unavailable");
    schedule();
    return {media: new MediaStream([output, ...input.getAudioTracks()]), min: 1, max: 4, step: .05, value,
      apply(next) { magnification = next; draw(); }, close};
  } catch {
    close();
    return null;
  }
}

async function applyZoom(value) {
  const controls = zoomControl;
  if (!controls) return;
  const slider = byId("zoom");
  slider.value = Math.min(controls.max, Math.max(controls.min, value));
  controls.pending = Number(slider.value);
  byId("zoom-value").textContent = controls.pending.toFixed(1) + "×";
  if (controls.busy) return;
  controls.busy = true;
  try {
    while (zoomControl === controls && controls.pending !== undefined) {
      const next = controls.pending;
      controls.pending = undefined;
      await controls.apply(next);
      if (zoomControl !== controls) break;
      prefs.zoom = next;
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(writePrefs, 350);
    }
  } catch (err) {
    if (zoomControl === controls) status("Zoom: " + err.message);
  } finally {
    controls.busy = false;
  }
}

function enablePinch() {
  const touches = new Map();
  let start = null;
  function distance() {
    const [a, b] = touches.values();
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
  video.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch" || !zoomControl) return;
    video.setPointerCapture(event.pointerId);
    touches.set(event.pointerId, event);
    start = touches.size === 2 ? {distance: distance(), zoom: Number(byId("zoom").value)} : null;
  });
  video.addEventListener("pointermove", event => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, event);
    if (start?.distance) applyZoom(start.zoom * distance() / start.distance);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    video.addEventListener(type, event => {
      if (touches.delete(event.pointerId)) start = null;
    });
  }
}

async function startCapture() {
  byId("start").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error("Camera access requires HTTPS with a trusted certificate.");
    const id = byId("camera").value;
    const videoConstraints = {
      ...(id ? {deviceId: {exact: id}} : {facingMode: {ideal: prefs.facing}}),
      width: {ideal: prefs.portrait ? 720 : 1280},
      height: {ideal: prefs.portrait ? 1280 : 720},
      frameRate: {ideal: 30, max: 30}
    };
    try { inputStream = await navigator.mediaDevices.getUserMedia({video: videoConstraints, audio: true}); }
    catch (err) {
      if (!["NotAllowedError", "NotFoundError", "NotReadableError"].includes(err.name)) throw err;
      inputStream = await navigator.mediaDevices.getUserMedia({video: videoConstraints});
    }
    const track = inputStream.getVideoTracks()[0];
    track.onended = () => { stopCapture(); status("Camera disconnected"); };
    const caps = track.getCapabilities?.() || {};
    zoomControl = await cameraZoom(inputStream, track, caps);
    stream = zoomControl?.media || inputStream;
    video.srcObject = stream;
    byId("stop").disabled = false;
    byId("zoom-row").hidden = !zoomControl;
    byId("torch").hidden = !caps.torch;
    byId("torch").textContent = "Turn light on";
    light = false;
    if (zoomControl) {
      const slider = byId("zoom");
      slider.min = zoomControl.min;
      slider.max = zoomControl.max;
      slider.step = zoomControl.step;
      slider.value = zoomControl.value;
      byId("zoom-value").textContent = Number(slider.value).toFixed(1) + "×";
    }
    devices().catch(() => {});
    acquireWakeLock();
    connect(++cycle);
  } catch (err) {
    stopCapture();
    status(err.message);
  }
}

function stopCapture() {
  endSession();
  clearTimeout(zoomTimer);
  zoomControl?.close?.();
  zoomControl = null;
  inputStream?.getTracks().forEach(t => t.stop());
  inputStream = null;
  stream = null;
  video.srcObject = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  byId("start").disabled = false;
  byId("stop").disabled = true;
  byId("zoom-row").hidden = true;
  byId("torch").hidden = true;
}

async function restartCapture() {
  if (!stream) return;
  stopCapture();
  await startCapture();
}

async function acquireWakeLock() {
  if (!stream || document.visibilityState !== "visible" || !navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}

async function init() {
  if (!feed || (!credential && !invitation)) throw Error("Open a feed from the dashboard or scan a pairing QR code.");
  if (remote && invitation) {
    const result = await api("enroll", {id: feed, role, key: invitation}, "");
    credential = result.key;
    sessionStorage.setItem(savedKey, credential);
    if (camera) {
      prefs = result.camera;
      byId("label").textContent = result.label;
    }
    history.replaceState(null, "", location.pathname + "#" + feed);
  }
  if (!camera) {
    window.onresize = () => applyRotation(rotation);
    byId("play").onclick = showVideo;
    await connect(++cycle);
    return;
  }
  if (!invitation) {
    const joined = await api("join", {id: feed, role, key: credential}, "");
    prefs = joined.camera;
    byId("label").textContent = joined.label;
    await api("leave", {}, joined.client);
  }
  syncControls();
  status("Paired · tap Start camera when ready");
  byId("start").disabled = false;
  byId("start").onclick = startCapture;
  byId("stop").onclick = () => { stopCapture(); status("Camera stopped"); };
  byId("camera").onchange = restartCapture;
  byId("facing").onchange = () => { prefs.facing = byId("facing").value; byId("camera").value = ""; writePrefs(); restartCapture(); };
  byId("portrait").onchange = () => { prefs.portrait = byId("portrait").checked; syncControls(); writePrefs(); restartCapture(); };
  byId("eco").onchange = () => { prefs.eco = byId("eco").checked; syncControls(); writePrefs(); };
  byId("zoom").oninput = () => applyZoom(Number(byId("zoom").value));
  enablePinch();
  byId("torch").onclick = async () => {
    try {
      await inputStream.getVideoTracks()[0].applyConstraints({advanced: [{torch: !light}]});
      light = !light;
      byId("torch").textContent = light ? "Turn light off" : "Turn light on";
    } catch (err) { status(err.message); }
  };
  document.addEventListener("visibilitychange", acquireWakeLock);
}

window.addEventListener("pagehide", () => {
  if (session) fetch("/api/session", {method: "POST", keepalive: true,
    headers: {"Content-Type": "application/json", Authorization: "Bearer " + session},
    body: JSON.stringify({action: "leave"})}).catch(() => {});
});
init().catch(err => { status(err.message, true); });

