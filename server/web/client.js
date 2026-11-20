"use strict";
const byId = id => document.getElementById(id);
const role = document.body.dataset.role;
const camera = role === "camera";
const landscapeViewport = matchMedia("(orientation: landscape)");
let rotatedLayout = false;
let orientationLocked = false;
let aspectOverride = "";
const remote = location.protocol === "https:";
const video = byId("media");
const [fragment, legacyKey] = location.hash.slice(1).split(".");
const invitation = remote ? legacyKey || (fragment.length === 6 ? fragment : "") : "";
let feed = invitation && !legacyKey ? "" : fragment;
const storageKey = () => "lanlens:" + role + ":" + feed;
const cameraStateKey = () => storageKey() + ":settings";
const peers = new Map();
const appPairingKey = "lanlens-camera-app-pairing";
let credential = remote ? sessionStorage.getItem(storageKey()) : legacyKey;
if (camera && remote && !invitation && !credential) {
  try {
    const saved = JSON.parse(localStorage.getItem(appPairingKey));
    if (saved && /^[-_A-Za-z0-9]{12}$/.test(saved.feed) && (!feed || feed === saved.feed)) {
      feed = saved.feed;
      credential = saved.key;
    }
  } catch {}
}
let cameraState = {};
let preferencesWritten = Promise.resolve();
let lastMicrophone;
let session = "";
let stream;
let inputStream;
let starting = false;
let paired = false;
let pairingBusy = false;
let scanAttempt;
let lensRefresh = 0;
let lensSides = new Map();
let fullscreenPreview = false;
let nativePreviewFullscreen = false;
let floatingControlsOpen = false;
let fullscreenControlsTimer;
const phoneControlsKey = "lanlens:phone-controls";
const aspectModes = ["portrait", "landscape-crop", "landscape"];
const aspectNames = {portrait: "Portrait", "landscape-crop": "Landscape cropped", landscape: "Landscape"};
let zoomControl;
let cycle = 0;
let wakeLock;
let light = false;
let rotation = 0;
let zoomTimer;
let badgeTimer;
let viewerLabel = "";
let hasVideo = false;
let prefs = {facing: "environment", portrait: true, framing: "auto", muted: false, eco: false, zoom: 0, resolution: 0};

function status(text, error = false) {
  byId("status").textContent = text;
  byId("status").dataset.error = error;
  byId("status").dataset.live = text.startsWith("Live ·");
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function rememberCamera() {
  if (!camera || !feed) return;
  cameraState.prefs = prefs;
  try { sessionStorage.setItem(cameraStateKey(), JSON.stringify(cameraState)); } catch {}
}

async function api(action, fields = {}, id = session) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
  let response;
  try {
    response = await fetch("/api/session", {
      method: "POST",
      headers: {"Content-Type": "application/json", Authorization: "Bearer " + id},
      body: JSON.stringify({action, ...fields}),
      signal: controller ? controller.signal : undefined
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

function viewerStatus(text, detail = "", lost = false) {
  const overlay = byId("overlay");
  overlay.hidden = false;
  overlay.dataset.lost = lost;
  status(text, lost);
  const note = byId("display-note");
  note.textContent = detail;
  note.hidden = !detail;
  const label = byId("display-label");
  label.textContent = viewerLabel;
  label.hidden = !viewerLabel;
  byId("play").hidden = true;
}

function waitingForCamera() {
  if (hasVideo) viewerStatus("Signal lost", "The camera went offline.", true);
  else viewerStatus("Waiting for camera…");
}

function clearPeer(id) {
  const pc = peers.get(id);
  if (!pc) return;
  peers.delete(id);
  pc.close();
  if (!camera && peers.size === 0) {
    video.srcObject = null;
    reportViewerDimensions();
    waitingForCamera();
  }
}

function peerState(pc) {
  if (pc.connectionState) return pc.connectionState;
  return pc.iceConnectionState === "completed" ? "connected" : pc.iceConnectionState;
}

function peer(id) {
  clearPeer(id);
  const pc = new RTCPeerConnection({iceServers: []});
  peers.set(id, pc);
  const updateConnection = () => {
    if (peers.get(id) !== pc) return;
    if (peerState(pc) === "failed") {
      clearPeer(id);
      if (!camera) retryViewer();
    }
    if (camera) cameraStatus();
  };
  const event = typeof pc.connectionState === "string" ? "connectionstatechange" : "iceconnectionstatechange";
  pc.addEventListener(event, updateConnection);
  return pc;
}

function cameraStatus() {
  if (!stream) return;
  const connected = [...peers.values()].filter(p => peerState(p) === "connected").length;
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
  const playing = video.srcObject;
  if (!playing) return;
  try {
    await video.play();
    if (video.srcObject !== playing) return;
    hasVideo = true;
    byId("overlay").hidden = true;
  } catch {
    if (video.srcObject !== playing) return;
    viewerStatus("Camera connected");
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
      if (pc?.signalingState === "have-local-offer") {
        await pc.setRemoteDescription({type: "answer", sdp: msg.value});
        const senders = pc.getSenders();
        const current = stream?.getVideoTracks()[0];
        if (current) await Promise.all(senders.map(sender => useVideoTrack(sender, current)));
        if (!await enforceSenderCaps(senders)) await softwareCap();
      }
      break;
    }
    case "identify":
      const dimensions = video.videoWidth && video.srcObject ? " · " + video.videoWidth + "×" + video.videoHeight : "";
      byId("identify").textContent = label + dimensions;
      byId("identify").hidden = false;
      clearTimeout(badgeTimer);
      badgeTimer = setTimeout(() => { byId("identify").hidden = true; }, 2500);
      break;
    case "ask-reset":
    case "reload-camera":
    case "set-resolution":
    case "set-microphone":
      if (camera) await handlePhoneCommand(msg);
      break;
    case "reload-view":
      await retryViewer();
      break;
  }
}

async function connect(token) {
  let reportedMic;
  while (cycle === token) {
    try {
      if (!session) {
        const mic = camera ? microphoneStatus() : undefined;
        const joined = await api("join", {id: feed, role, key: credential, mic}, "");
        if (token !== cycle) {api("leave", {}, joined.client).catch(() => {}); return;}
        session = joined.client;
        if (camera) {
          reportedMic = mic;
          syncMicrophone(mic);
          byId("label").textContent = joined.label;
          cameraStatus();
          writePrefs();
        } else {
          viewerLabel = joined.label;
          document.title = viewerLabel + " · LAN Lens";
          applyRotation(joined.rotation);
          waitingForCamera();
        }
      }
      const mic = camera ? microphoneStatus() : undefined;
      const changed = mic !== reportedMic;
      const data = await api("poll", changed ? {mic} : {});
      if (token !== cycle) return;
      if (changed) {
        reportedMic = mic;
        syncMicrophone();
      }
      if (!camera && rotation !== data.rotation) applyRotation(data.rotation);
      if (camera && byId("label").textContent !== data.label) {
        byId("label").textContent = data.label;
        ui.toast("The host renamed this feed to " + data.label + ".");
      }
      else if (!camera && viewerLabel !== data.label) {
        viewerLabel = data.label;
        document.title = viewerLabel + " · LAN Lens";
        byId("display-label").textContent = viewerLabel;
      }
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
      if (err.code === 410 || ((err.code === 401 || err.code === 404) && !wasJoined)) {
        if (remote) forgetPairing();
        if (camera) {
          paired = false;
          cameraState.active = false;
          rememberCamera();
          stopCapture();
          ui.toast(err.message, true);
        }
        if (camera) pairingPrompt(err.message, true);
        else viewerStatus("Feed unavailable", err.message, true);
        return;
      }
      if (camera) status("Reconnecting…");
      else viewerStatus(hasVideo ? "Signal lost" : "Reconnecting…", "Reconnecting to LAN Lens.", hasVideo);
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

const resolutions = [360, 540, 720, 1080];
const initialResolution = 540;
const constrainedDevice = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
const frameRate = 24;
let autoResolution = initialResolution;
let qualityTimer;
let phoneStats;
let pendingHostResolution;
let hostResolutionTimer;
let changingQuality = false;
let samplingQuality = false;
let weakSamples = 0;
let healthySamples = 0;
let autoQualityBlocked = false;

const trackOptions = new WeakMap();

function updateCameraTrack(track, constraints, group, values) {
  let state = trackOptions.get(track);
  if (!state) {
    state = {groups: {}, promise: Promise.resolve()};
    trackOptions.set(track, state);
  }
  const operation = state.promise.catch(() => {}).then(async () => {
    if (!group) {
      const {advanced, ...capture} = track.getConstraints();
      await track.applyConstraints({...capture, ...constraints});
      return;
    }
    // Older Chromium rejects mixing capture and camera controls and only
    // reads the first advanced constraint set.
    const groups = {...state.groups};
    delete groups[group];
    if (Object.keys(values).length) groups[group] = values;
    const optics = Object.assign({}, ...Object.values(groups));
    await track.applyConstraints(Object.keys(optics).length ? {advanced: [optics]} : {});
    state.groups = groups;
  });
  state.promise = operation;
  return operation;
}

async function capSender(sender) {
  if (sender.track?.kind !== "video") return true;
  const native = sender.track === inputStream?.getVideoTracks()[0];
  const size = native ? rawCaptureSize() : sender.track.getSettings();
  const shortSide = Math.min(size.width, size.height);
  if (!Number.isFinite(shortSide)) return true;
  const target = prefs.resolution || autoResolution;
  const factor = native ? Math.max(1, shortSide / target) : 1;
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return true;
    if (parameters.encodings.every(encoding =>
      (encoding.scaleResolutionDownBy || 1) === factor && encoding.maxFramerate === frameRate)) return true;
    for (const encoding of parameters.encodings) {
      encoding.scaleResolutionDownBy = factor;
      encoding.maxFramerate = frameRate;
    }
    await sender.setParameters(parameters);
    return true;
  } catch {
    return factor === 1;
  }
}

async function useVideoTrack(sender, track) {
  if (sender.track?.kind !== "video" || sender.track === track) return;
  try { await sender.replaceTrack(track); }
  catch (err) { if (err.name !== "InvalidStateError") throw err; }
}

async function enforceSenderCaps(senders) {
  return (await Promise.all(senders.map(capSender))).every(Boolean);
}

async function softwareCap() {
  const controls = zoomControl;
  if (!controls || controls.force) return;
  controls.force = true;
  try { await refreshPipeline(); }
  catch { ui.toast("Could not enforce the selected resolution on this browser.", true); }
}

function outputAspect() {
  if (prefs.framing === "crop") return "landscape-crop";
  return aspectOverride || (landscapeViewport.matches ? "landscape" : "portrait");
}

function syncAspectButtons() {
  const aspect = outputAspect();
  for (const mode of aspectModes) byId(mode).setAttribute("aria-pressed", aspect === mode);
  const next = aspectModes[(aspectModes.indexOf(aspect) + 1) % aspectModes.length];
  const button = byId("cycle-aspect");
  const label = "Change aspect to " + aspectNames[next];
  if (button.title !== label) ui.labelControl(button, label, "aspect");
  document.body.classList.toggle("rotated-camera", rotatedLayout && !landscapeViewport.matches);
  document.body.classList.toggle("landscape-controls", landscapeViewport.matches || rotatedLayout);
}

function setupAspectButtons() {
  let request = 0;
  let requestedAspect;
  function unlock() {
    if (orientationLocked) {
      screen.orientation?.unlock?.();
      if (!fullscreenPreview && document.fullscreenElement === document.documentElement)
        document.exitFullscreen?.().catch(() => {});
    }
    orientationLocked = rotatedLayout = false;
  }

  function applyAspect() {
    const aspect = outputAspect();
    const changed = aspect !== requestedAspect;
    requestedAspect = aspect;
    prefs.portrait = aspect !== "landscape";
    cameraState.aspectOverride = aspectOverride;
    syncAspectButtons();
    showCaptureResolution();
    writePrefs();
    const track = inputStream?.getVideoTracks()[0];
    // Ask for a native frame first. The processor corrects framing when
    // the input still arrives in the other orientation.
    if (track && changed) updateCameraTrack(track, captureSize(prefs.resolution || autoResolution))
      .then(refreshPipeline).catch(() => {});
    refreshPipeline().catch(err => ui.toast("Could not change framing: " + err.message, true));
  }

  function followScreen() {
    // Release the temporary selection when the screen takes on its own orientation.
    if (orientationLocked || landscapeViewport.matches) rotatedLayout = false;
    if (!orientationLocked && !rotatedLayout) aspectOverride = "";
    applyAspect();
  }

  if (landscapeViewport.addEventListener) landscapeViewport.addEventListener("change", followScreen);
  else landscapeViewport.addListener(followScreen);
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && orientationLocked) {
      orientationLocked = false;
      followScreen();
    }
  });

  byId("cycle-aspect").onclick = () => {
    const next = aspectModes[(aspectModes.indexOf(outputAspect()) + 1) % aspectModes.length];
    byId(next).click();
    ui.toast(aspectNames[next] + " selected.");
  };
  byId("portrait").onclick = () => {
    request++;
    unlock();
    prefs.framing = "auto";
    aspectOverride = "portrait";
    applyAspect();
  };
  byId("landscape-crop").onclick = () => {
    request++;
    unlock();
    prefs.framing = "crop";
    aspectOverride = "";
    applyAspect();
  };
  byId("landscape").onclick = async () => {
    const token = ++request;
    prefs.framing = "auto";
    aspectOverride = "landscape";
    applyAspect();
    if (!landscapeViewport.matches && !rotatedLayout) {
      let fullscreen = false;
      try {
        if (!screen.orientation?.lock) throw Error("Orientation lock unavailable");
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
          fullscreen = true;
        }
        if (token !== request) {
          if (fullscreen) await document.exitFullscreen().catch(() => {});
          return;
        }
        await screen.orientation.lock("landscape");
        if (token !== request) {
          screen.orientation.unlock?.();
          if (fullscreen) await document.exitFullscreen().catch(() => {});
          return;
        }
        orientationLocked = true;
      } catch {
        if (fullscreen && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        if (token !== request) return;
        rotatedLayout = !landscapeViewport.matches;
      }
      applyAspect();
    }
  };
}

function rawCaptureSize() {
  const track = inputStream?.getVideoTracks()[0];
  if (!track) return {};
  if (stream === inputStream && video.srcObject === inputStream && video.videoWidth && video.videoHeight)
    return {width: video.videoWidth, height: video.videoHeight};
  return zoomControl?.processor?.sourceSize() || zoomControl?.rawSize || track.getSettings();
}

function incorrectAspect({width, height}) {
  if (!width || !height) return false;
  if (outputAspect() === "portrait") return width > height;
  return Math.abs(width / height / (16 / 9) - 1) > .02;
}

function sourceResize(source, controls) {
  if (!controls || zoomControl !== controls || !source.videoWidth || !source.videoHeight) return;
  controls.rawSize = {width: source.videoWidth, height: source.videoHeight};
  refreshPipeline().catch(err => ui.toast(err.message, true));
}

function reportViewerDimensions() {
  if (!session || camera) return;
  api("dimensions", {width: video.srcObject ? video.videoWidth : 0, height: video.srcObject ? video.videoHeight : 0}).catch(() => {});
}

function captureSize(shortSide) {
  const longSide = Math.round(shortSide * 16 / 9);
  const aspect = outputAspect();
  const nativePortrait = aspect === "portrait" && navigator.mediaDevices?.getSupportedConstraints()?.resizeMode;
  const crop = aspect === "landscape-crop";
  return {
    width: {ideal: crop ? shortSide : longSide},
    height: {ideal: crop ? longSide : shortSide},
    resizeMode: nativePortrait ? {ideal: "none"} : undefined,
    frameRate: nativePortrait ? {ideal: frameRate} : {ideal: frameRate, max: frameRate}
  };
}

function showCaptureResolution() {
  const size = rawCaptureSize();
  const capture = size.width && size.height ? Math.min(size.width, size.height) : 0;
  const output = zoomControl?.processor?.outputHeight() || (capture ? Math.min(capture, prefs.resolution || autoResolution) : 0);
  const mode = prefs.resolution ? "" : "Auto · ";
  let text = "";
  if (output) text = mode + output + "p output" + (capture > output ? " · " + capture + "p capture" : "");
  else if (prefs.resolution) text = prefs.resolution + "p selected";
  if (byId("actual-resolution").textContent !== text) byId("actual-resolution").textContent = text;
  const rendered = zoomControl?.processor?.frameSize() || (capture && output ? {
    width: Math.round(size.width * output / capture), height: Math.round(size.height * output / capture)
  } : null);
  const label = {"portrait": "Portrait", "landscape-crop": "Landscape cropped", "landscape": "Landscape"}[outputAspect()];
  const framing = rendered?.width && rendered?.height ? label + " · " + rendered.width + "×" + rendered.height : label;
  if (byId("aspect-mode").textContent !== framing) byId("aspect-mode").textContent = framing;
}

function linkQuality(report) {
  let healthy = false;
  for (const stat of report.values()) {
    if (stat.type !== "outbound-rtp" || stat.kind !== "video" || !stat.bytesSent) continue;
    const remoteVideo = report.get(stat.remoteId);
    const loss = remoteVideo?.fractionLost;
    const rtt = remoteVideo?.roundTripTime;
    if (["bandwidth", "cpu"].includes(stat.qualityLimitationReason) || loss > .10 || rtt > .35)
      return "weak";
    if (Number.isFinite(loss) && Number.isFinite(rtt) && loss < .025 && rtt < .18 &&
        (!stat.qualityLimitationReason || stat.qualityLimitationReason === "none")) healthy = true;
  }
  return healthy ? "healthy" : "unknown";
}

async function changeResolution(resolution, selection = prefs.resolution) {
  if (changingQuality) return;
  const track = inputStream?.getVideoTracks()[0];
  changingQuality = true;
  syncControls();
  try {
    if (track) {
      try {
        await updateCameraTrack(track, captureSize(resolution));
      } catch (err) {
        if (!zoomControl) throw err;
      }
      if (track !== inputStream?.getVideoTracks()[0]) return;
    }
    prefs.resolution = selection;
    if (selection === 0) autoResolution = resolution;
    if (zoomControl) {
      zoomControl.force = false;
      await refreshPipeline();
    }
    showCaptureResolution();
    return true;
  } finally {
    changingQuality = false;
    syncControls();
  }
}

function updatePhoneStats(track, reports, connections) {
  if (!phoneStats || !byId("camera-stats").open || (fullscreenPreview && !floatingControlsOpen)) return;
  const entries = reports?.flatMap((result, index) => result.status === "fulfilled"
    ? [[connections[index][0], result.value]] : []);
  phoneStats.render(track, entries);
}

async function adjustAutomaticResolution() {
  if (!stream || changingQuality || samplingQuality || pendingHostResolution) return;
  const activeTrack = inputStream?.getVideoTracks()[0];
  const connections = [...peers.entries()].filter(([, pc]) => peerState(pc) === "connected");
  if (!connections.length) {
    weakSamples = healthySamples = 0;
    updatePhoneStats(activeTrack);
    return;
  }
  samplingQuality = true;
  try {
    const reports = await Promise.allSettled(connections.map(([, pc]) => pc.getStats()));
    if (activeTrack !== inputStream?.getVideoTracks()[0] || !stream || changingQuality || pendingHostResolution) return;
    updatePhoneStats(activeTrack, reports, connections);
    const target = prefs.resolution || autoResolution;
    const outbound = reports.flatMap(result => result.status === "fulfilled"
      ? [...result.value.values()].filter(stat => stat.type === "outbound-rtp" && stat.kind === "video" && stat.frameWidth && stat.frameHeight)
      : []);
    const oversized = outbound.some(stat => Math.min(stat.frameWidth, stat.frameHeight) > target);
    const mismatched = outbound.find(stat => incorrectAspect({width: stat.frameWidth, height: stat.frameHeight}));
    if (mismatched && prefs.eco && zoomControl && !zoomControl.processor) {
      zoomControl.rawSize = {width: mismatched.frameWidth, height: mismatched.frameHeight};
      await refreshPipeline();
    }
    if (oversized && !zoomControl?.processor) await softwareCap();
    if (prefs.resolution || autoQualityBlocked) return;
    const states = reports.map(result => result.status === "fulfilled" ? linkQuality(result.value) : "unknown");
    weakSamples = states.includes("weak") ? weakSamples + 1 : 0;
    healthySamples = states.every(state => state === "healthy") ? healthySamples + 1 : 0;
    const index = resolutions.indexOf(autoResolution);
    const next = weakSamples >= 2 ? resolutions[index - 1] : healthySamples >= 5 && (!constrainedDevice || autoResolution < 720) ? resolutions[index + 1] : null;
    if (next) {
      weakSamples = healthySamples = 0;
      await changeResolution(next, 0);
    }
  } catch {
    // Some devices cannot change capture constraints during an active call.
    // The browser still controls WebRTC bitrate.
    autoQualityBlocked = true;
  } finally {
    samplingQuality = false;
  }
}

function syncControls() {
  const running = Boolean(stream);
  const select = byId("camera");
  const selected = cameraState.device || (prefs.facing === "user" ? "front" : "rear");
  if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
  syncAspectButtons();
  byId("preview-fullscreen").hidden = !paired || !byId("pairing").hidden;
  byId("eco").setAttribute("aria-pressed", prefs.eco);
  ui.labelControl(byId("eco"), prefs.eco ? "Disable Eco Mode" : "Enable Eco Mode", "eco");
  byId("eco-screen").hidden = !prefs.eco;
  video.hidden = prefs.eco;
  const previewStream = prefs.eco ? null : stream || null;
  if (video.srcObject !== previewStream) video.srcObject = previewStream;

  syncMicrophone();
  byId("start").hidden = running;
  byId("start").disabled = !paired || starting;
  byId("stop").hidden = !running;
  byId("stop").disabled = starting;
  byId("reset").disabled = !running || starting;
  byId("cycle-aspect").disabled = !paired || starting;
  byId("zoom").disabled = !zoomControl || starting;
  updateFullscreenVisibility();
  byId("pair-another").hidden = !remote || !paired || running || starting || !byId("pairing").hidden;
  const switchLens = byId("switch-lens");
  const switchLabel = currentFacing() === "user" ? "Switch to rear camera" : "Switch to front camera";
  if (switchLens.title !== switchLabel) ui.labelControl(switchLens, switchLabel, "flip");
  switchLens.disabled = !paired || starting;
  byId("resolution").disabled = !paired || starting || changingQuality || Boolean(pendingHostResolution);
  if (!changingQuality) byId("resolution").value = prefs.resolution || 0;
  for (const id of ["camera", "portrait", "landscape-crop", "landscape", "eco"])
    byId(id).disabled = !paired || starting;
}

function writePrefs() {
  rememberCamera();
  if (!session) return;
  const owner = session;
  const saved = {...prefs};
  const microphone = audioTracks().length > 0;
  preferencesWritten = preferencesWritten.then(async () => {
    if (session !== owner) return;
    try {
      await api("prefs", {camera: saved, microphone}, owner);
    } catch (err) {
      if (err.code !== 401) ui.toast("Could not save camera preferences: " + err.message, true);
    }
  });
}

function audioTracks() {
  return inputStream?.getAudioTracks().filter(track => track.readyState === "live") || [];
}

function microphoneStatus() {
  const tracks = audioTracks();
  const available = tracks.length > 0;
  const muted = available ? tracks.every(track => !track.enabled) : Boolean(prefs.muted);
  const interrupted = available && tracks.every(track => track.muted === true);
  if (!lastMicrophone || lastMicrophone.available !== available ||
      lastMicrophone.muted !== muted || lastMicrophone.interrupted !== interrupted) {
    const revision = lastMicrophone ? lastMicrophone.revision + 1 : 1;
    lastMicrophone = {available, muted, interrupted, revision};
  }
  return lastMicrophone;
}

function syncMicrophone({available, muted, interrupted} = microphoneStatus()) {
  const button = byId("mic-toggle");
  const label = !available ? "Microphone unavailable" : muted ? "Unmute microphone" : "Mute microphone";
  if (button.getAttribute("aria-label") !== label)
    ui.labelControl(button, label, muted || !available ? "micOff" : "mic");
  button.title = interrupted && !muted ? "Microphone temporarily interrupted" : label;
  button.setAttribute("aria-pressed", available && muted);
  button.disabled = !available;
  button.hidden = !stream;
}

function setMicrophoneMuted(muted) {
  const tracks = audioTracks();
  if (!tracks.length) throw Error("This phone has no active microphone in LAN Lens.");
  for (const track of tracks) track.enabled = !muted;
  prefs.muted = muted;
  syncMicrophone();
  writePrefs();
}

async function handlePhoneCommand(msg) {
  const key = credential;
  let result;
  let success = false;
  try {
    switch (msg.kind) {
      case "set-microphone":
        if (!["true", "false"].includes(msg.value)) throw Error("Invalid microphone command.");
        setMicrophoneMuted(msg.value === "true");
        result = msg.value === "true" ? "Microphone muted by the host." : "Microphone unmuted by the host.";
        break;
      case "ask-reset": {
        const answer = ui.confirm({title: "Restart camera?", message: "The host requested a restart. The live feed will briefly disconnect.",
          accept: "Restart", timeout: 40000});
        ui.toast("The host requested a camera restart.");
        if (!await answer) throw Error("Camera restart declined on the phone.");
        if (!await restartCapture("")) throw Error("The phone could not restart the camera.");
        result = "Phone camera restarted.";
        break;
      }
      case "reload-camera":
        ui.toast("The host is restarting the camera.");
        if (!await restartCapture("")) throw Error("The phone could not restart the camera.");
        result = "Phone camera restarted.";
        break;
      case "set-resolution":
        result = await warnHostResolution(Number(msg.value));
        break;
    }
    success = true;
  } catch (err) {
    result = err.message;
  }
  ui.toast(result, !success);
  if (msg.request) {
    try {
      const mic = msg.kind === "set-microphone" ? microphoneStatus() : undefined;
      await api("feedback", {request: msg.request, result: result.slice(0, 128), success, mic}, key);
    }
    catch (err) {
      if (![401, 404, 410].includes(err.code)) ui.toast("Could not confirm the command to the controller.", true);
    }
  }
}

function lensFacing(device, active) {
  let modes;
  try { modes = device.getCapabilities?.()?.facingMode; } catch {}
  if (device.deviceId === active.deviceId && active.facingMode) return active.facingMode;
  if (modes?.includes("environment")) return "environment";
  if (modes?.includes("user")) return "user";
  if (/\b(rear|back|environment)\b/i.test(device.label)) return "environment";
  if (/\b(front|user|selfie|facetime)\b/i.test(device.label)) return "user";
  if (/\b(telephoto|ultra[ -]?wide)\b/i.test(device.label)) return "environment";
  return "";
}

async function devices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const request = ++lensRefresh;
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (request !== lensRefresh) return;
  const active = inputStream?.getVideoTracks()[0]?.getSettings() || {};
  const inputs = new Map();
  for (const device of devices) {
    if (device.kind === "videoinput" && device.deviceId && !inputs.has(device.deviceId))
      inputs.set(device.deviceId, device);
  }

  const groups = [
    {facing: "environment", label: "Rear lenses"},
    {facing: "user", label: "Front lenses"},
    {facing: "", label: "Other cameras"}
  ].map(group => ({...group, element: document.createElement("optgroup")}));
  for (const group of groups) group.element.label = group.label;
  const sides = new Map();
  for (const device of inputs.values()) {
    const facing = lensFacing(device, active);
    const group = groups.find(item => item.facing === facing) || groups[2];
    const number = group.element.children.length + 1;
    const fallback = group.facing === "environment" ? "Rear lens " : group.facing === "user" ? "Front lens " : "Camera ";
    const key = "device:" + device.deviceId;
    sides.set(key, group.facing);
    group.element.appendChild(new Option(device.label || fallback + number, key));
  }
  for (const {element} of groups) {
    const options = Array.from(element.children);
    const labels = options.map(option => option.text);
    options.forEach((option, index) => {
      if (labels.filter(label => label === option.text).length > 1)
        option.text += " " + (labels.slice(0, index + 1).filter(label => label === option.text).length);
    });
  }
  lensSides = sides;
  const picker = byId("camera");
  ui.replaceContents(picker, new Option("Rear (automatic)", "rear"), new Option("Front (automatic)", "front"),
    ...groups.filter(group => group.element.children.length).map(group => group.element));
  syncControls();
}

async function cameraZoom(track, caps) {
  const range = caps.zoom;
  // A coarse native zoom range visibly jumps between hardware steps.
  if (range && Number.isFinite(range.min) && Number.isFinite(range.max) &&
      range.max > range.min && (!range.step || range.step <= .02)) {
    const apply = value => updateCameraTrack(track, {}, "zoom", {zoom: value});
    const value = Math.min(range.max, Math.max(range.min, prefs.zoom || track.getSettings().zoom || 1));
    try {
      if (Math.abs((track.getSettings().zoom || 1) - value) > .01) await apply(value);
      return {min: range.min, max: range.max, value, apply};
    } catch {}
  }
  const value = Math.min(4, Math.max(1, prefs.zoom || 1));
  return {min: 1, max: 4, value, renderedZoom: value, softwareZoom: true};
}

async function createProcessor(input, controls) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", {alpha: false});
  if (!canvas.captureStream || !context) throw Error("Video processing is unavailable.");
  const source = document.createElement("video");
  source.muted = source.playsInline = true;
  source.className = "zoom-capture";
  source.setAttribute("aria-hidden", "true");
  document.body.append(source);
  source.srcObject = new MediaStream(input.getVideoTracks());
  source.addEventListener("resize", () => {
    if (controls.processor?.source === source) sourceResize(source, controls);
  });
  let output;
  let scheduled;
  let previousFrame = -1;
  let lastDraw = 0;
  let lastZoomFrame;
  const frameCallbacks = Boolean(source.requestVideoFrameCallback);
  function draw(now = performance.now()) {
    const width = source.videoWidth;
    const height = source.videoHeight;
    if (!width || !height) return;
    const portrait = outputAspect() === "portrait";
    const turn = portrait && width > height;
    const nativeWidth = portrait ? width : Math.min(width, height * 16 / 9);
    const nativeHeight = portrait ? height : Math.min(height, width * 9 / 16);
    const target = prefs.resolution || autoResolution;
    const scale = Math.min(1, target / Math.min(nativeWidth, nativeHeight));
    const drawnWidth = Math.max(2, Math.floor((nativeWidth * scale + 1e-7) / 2) * 2);
    const drawnHeight = Math.max(2, Math.floor((nativeHeight * scale + 1e-7) / 2) * 2);
    const frameWidth = turn ? drawnHeight : drawnWidth;
    const frameHeight = turn ? drawnWidth : drawnHeight;
    const resized = canvas.width !== frameWidth || canvas.height !== frameHeight;
    if (canvas.width !== frameWidth) canvas.width = frameWidth;
    if (canvas.height !== frameHeight) canvas.height = frameHeight;
    let zoom = 1;
    if (controls.softwareZoom) {
      const previous = controls.renderedZoom;
      const target = controls.value;
      const active = controls.processor?.source === source;
      const elapsed = lastZoomFrame === undefined ? 1000 / frameRate : Math.min(50, Math.max(0, now - lastZoomFrame));
      zoom = active ? previous + (target - previous) * (1 - Math.exp(-elapsed / 64)) : previous;
      if (active && Math.abs(zoom - target) < .005) zoom = target;
      controls.renderedZoom = zoom;
      lastZoomFrame = now;
      if (previous > 1 && zoom === 1 && active) refreshPipeline().catch(() => {});
    }
    const w = nativeWidth / zoom;
    const h = nativeHeight / zoom;
    if (turn) {
      const counterclockwise = screen.orientation?.angle === 90;
      if (counterclockwise) context.setTransform(0, -1, 1, 0, 0, frameHeight);
      else context.setTransform(0, 1, -1, 0, frameWidth, 0);
    }
    context.drawImage(source, (width - w) / 2, (height - h) / 2, w, h, 0, 0, drawnWidth, drawnHeight);
    if (turn) context.resetTransform();
    if (resized) showCaptureResolution();
  }
  function tick(now = performance.now()) {
    if ((frameCallbacks || source.currentTime !== previousFrame) && now - lastDraw >= (1000 / frameRate - 2)) {
      draw(now);
      lastDraw = now;
      previousFrame = source.currentTime;
    }
    scheduled = frameCallbacks ? source.requestVideoFrameCallback(tick) : setTimeout(tick, 1000 / frameRate);
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
    [output] = canvas.captureStream(frameRate).getVideoTracks();
    if (!output) throw Error("Video processing is unavailable.");
    tick();
    return {
      media: new MediaStream([output, ...input.getAudioTracks()]),
      source,
      sourceSize: () => source.videoWidth && source.videoHeight ? {width: source.videoWidth, height: source.videoHeight} : null,
      frameSize: () => ({width: canvas.width, height: canvas.height}),
      outputHeight: () => Math.min(canvas.width, canvas.height),
      close
    };
  } catch (err) {
    close();
    throw err;
  }
}

function refreshPipeline() {
  const controls = zoomControl;
  const input = inputStream;
  if (!controls || !input) return Promise.resolve();
  const operation = (controls.pipeline || Promise.resolve()).catch(() => {}).then(async () => {
    if (zoomControl !== controls) return;
    const senders = [...peers.values()].flatMap(pc => pc.getSenders()).filter(sender => sender.track?.kind === "video");
    const required = controls.force || incorrectAspect(rawCaptureSize()) || (controls.softwareZoom && (controls.value > 1 || controls.renderedZoom > 1));
    const old = controls.processor;
    let next = required ? old || await createProcessor(input, controls) : null;
    if (zoomControl !== controls) {
      if (next !== old) next?.close();
      return;
    }
    async function use(media) {
      const track = media.getVideoTracks()[0];
      await Promise.all(senders.map(sender => useVideoTrack(sender, track)));
      if (zoomControl === controls) stream = media;
    }
    try {
      await use(next?.media || input);
      if (zoomControl !== controls) { if (next !== old) next?.close(); return; }
      if (!await enforceSenderCaps(senders) && !next) {
        controls.force = true;
        next = old || await createProcessor(input, controls);
        if (zoomControl !== controls) { if (next !== old) next.close(); return; }
        await use(next.media);
        await enforceSenderCaps(senders);
      }
    } catch (err) {
      await use(old?.media || input).catch(() => {});
      if (next !== old) next?.close();
      throw err;
    }
    if (zoomControl !== controls) { if (next !== old) next?.close(); return; }
    controls.processor = next;
    if (next !== old) old?.close();
    syncControls();
    showCaptureResolution();
  });
  controls.pipeline = operation;
  return operation;
}

function updateSliderFill(slider) {
  const fraction = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
  slider.style.setProperty("--slider-fill", (fraction * 100) + "%");
}

function showZoomValue(value) {
  const slider = byId("zoom");
  slider.value = value;
  updateSliderFill(slider);
  const actual = Number(slider.value);
  byId("zoom-value").textContent = actual.toFixed(2) + "×";
  return actual;
}

async function applyZoom(value) {
  const controls = zoomControl;
  if (!controls) return;
  controls.pending = showZoomValue(Math.min(controls.max, Math.max(controls.min, value)));
  if (controls.busy) return;
  controls.busy = true;
  try {
    while (zoomControl === controls && controls.pending !== undefined) {
      const next = controls.pending;
      controls.pending = undefined;
      const previous = controls.value;
      if (controls.apply) await controls.apply(next);
      controls.value = next;
      if (controls.softwareZoom && previous === 1 && next > 1 && !controls.processor) {
        try { await refreshPipeline(); }
        catch (err) { controls.value = previous; throw err; }
      }
      if (zoomControl !== controls) break;
      prefs.zoom = next;
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(writePrefs, 350);
    }
  } catch (err) {
    if (zoomControl === controls) {
      showZoomValue(controls.value);
      ui.toast("Zoom: " + err.message, true);
    }
  } finally {
    controls.busy = false;
  }
}

function currentFacing() {
  const actual = inputStream?.getVideoTracks()[0]?.getSettings().facingMode;
  if (actual === "environment" || actual === "user") return actual;
  return lensSides.get(cameraState.device) || prefs.facing;
}

function rememberLens(facing, device) {
  if (facing !== "environment" && facing !== "user") return;
  cameraState.lenses = {...cameraState.lenses, [facing]: device};
}

function selectLens(choice, facing) {
  if (!paired || starting || !byId("pairing").hidden) return;
  cameraState.device = choice.startsWith("device:") ? choice : "";
  if (facing) {
    prefs.facing = facing;
    rememberLens(facing, cameraState.device);
  }
  writePrefs();
  const label = facing === "user" ? "Front camera" : facing === "environment" ? "Rear camera" : "Camera lens";
  if (stream) restartCapture(label + " selected.");
  else {
    syncControls();
    ui.toast(label + " selected.");
  }
}

function switchFacing() {
  if (!paired || starting) return;
  const current = currentFacing();
  if (cameraState.device) {
    const known = inputStream?.getVideoTracks()[0]?.getSettings().facingMode || lensSides.get(cameraState.device);
    rememberLens(known, cameraState.device);
  }
  const facing = current === "user" ? "environment" : "user";
  selectLens(cameraState.lenses?.[facing] || (facing === "user" ? "front" : "rear"), facing);
}

function bindPreviewGestures() {
  const touches = new Map();
  let pinch;
  let tap;
  let previousTap;

  function distance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function spread() {
    const [a, b] = touches.values();
    return distance(a, b);
  }

  video.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch" || !stream || !zoomControl) return;
    video.setPointerCapture(event.pointerId);
    touches.set(event.pointerId, event);
    if (touches.size === 1) {
      tap = event;
    } else {
      tap = previousTap = null;
    }
    pinch = touches.size === 2 ? {distance: spread(), zoom: Number(byId("zoom").value)} : null;
  });
  video.addEventListener("pointermove", event => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, event);
    if (tap && distance(tap, event) > 14) tap = previousTap = null;
    if (pinch?.distance) applyZoom(pinch.zoom * spread() / pinch.distance);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    video.addEventListener(type, event => {
      if (!touches.delete(event.pointerId)) return;
      const isTap = type === "pointerup" && tap?.pointerId === event.pointerId &&
        event.timeStamp - tap.timeStamp <= 280 && distance(tap, event) <= 14;
      tap = pinch = null;
      if (!isTap) {
        previousTap = null;
      } else if (previousTap && event.timeStamp - previousTap.timeStamp <= 330 && distance(previousTap, event) <= 32) {
        previousTap = null;
        switchFacing();
      } else {
        previousTap = event;
      }
    });
  }
}

async function openCamera(device) {
  async function capture(id) {
    const video = {
      ...(id ? {deviceId: {exact: id}} : {facingMode: {ideal: prefs.facing}}),
      ...captureSize(prefs.resolution || autoResolution)
    };
    try { return await navigator.mediaDevices.getUserMedia({video, audio: true}); }
    catch (err) {
      if (!["NotAllowedError", "NotFoundError", "NotReadableError"].includes(err.name)) throw err;
      return navigator.mediaDevices.getUserMedia({video});
    }
  }
  try { return {stream: await capture(device)}; }
  catch (err) {
    if (!device || !["OverconstrainedError", "NotFoundError"].includes(err.name)) throw err;
    return {stream: await capture(), deviceUnavailable: true};
  }
}

async function startCapture(message = "") {
  if (starting || stream || !paired || !byId("pairing").hidden) return;
  starting = true;
  syncControls();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error("Camera access requires HTTPS with a trusted certificate.");
    const id = cameraState.device?.slice(7);
    const {stream: captured, deviceUnavailable} = await openCamera(id);
    inputStream = captured;
    for (const audio of audioTracks()) {
      audio.enabled = !prefs.muted;
      audio.onmute = audio.onunmute = () => {
        if (inputStream === captured) syncMicrophone();
      };
      audio.onended = () => {
        if (inputStream !== captured) return;
        syncMicrophone();
        ui.toast("The microphone disconnected.", true);
      };
    }
    if (deviceUnavailable) {
      for (const facing of ["environment", "user"]) {
        if (cameraState.lenses?.[facing] === cameraState.device) delete cameraState.lenses[facing];
      }
      cameraState.device = "";
      ui.toast("Saved lens unavailable. Using the automatic lens.", true);
    }
    const track = inputStream.getVideoTracks()[0];
    const facing = track.getSettings().facingMode || lensSides.get(cameraState.device);
    if (cameraState.device) rememberLens(facing, cameraState.device);
    track.onended = () => {
      if (track !== inputStream?.getVideoTracks()[0]) return;
      stopCapture();
      status("Camera disconnected", true);
      ui.toast("Camera disconnected.", true);
    };
    const caps = track.getCapabilities?.() || {};
    zoomControl = await cameraZoom(track, caps);
    stream = inputStream;
    await refreshPipeline();
    const lens = track.getSettings().deviceId || cameraState.device || prefs.facing;
    await optics.setTrack(track, cameraState.optics?.[lens], state => {
      cameraState.optics = {...cameraState.optics, [lens]: state};
      rememberCamera();
    });
    syncControls();
    byId("torch").hidden = !caps.torch;
    ui.labelControl(byId("torch"), "Turn on flashlight", "torch");
    byId("torch").setAttribute("aria-pressed", false);
    light = false;
    if (caps.torch && cameraState.torch) await setTorch(track, true).catch(() => {});
    cameraState.active = true;
    rememberCamera();
    if (zoomControl) {
      const slider = byId("zoom");
      slider.min = zoomControl.min;
      slider.max = zoomControl.max;
      showZoomValue(zoomControl.value);
    }
    showCaptureResolution();
    updatePhoneStats(track);
    weakSamples = healthySamples = 0;
    autoQualityBlocked = false;
    qualityTimer = setInterval(adjustAutomaticResolution, 4000);
    devices().catch(() => {});
    acquireWakeLock();
    connect(++cycle);
    if (message) ui.toast(message);
    return true;
  } catch (err) {
    stopCapture();
    status(err.message, true);
    ui.toast(err.message, true);
    return false;
  } finally {
    starting = false;
    syncControls();
  }
}

function stopCapture() {
  endSession();
  clearTimeout(zoomTimer);
  clearInterval(qualityTimer);
  clearHostResolution();
  zoomControl?.processor?.close();
  zoomControl = null;
  inputStream?.getTracks().forEach(t => t.stop());
  inputStream = null;
  optics.setTrack(null);
  updatePhoneStats(null);
  stream = null;
  syncControls();
  showCaptureResolution();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  byId("torch").hidden = true;
}

async function restartCapture(message) {
  if (starting || !stream) return false;
  stopCapture();
  return startCapture(message);
}

async function acquireWakeLock() {
  if (!stream || document.visibilityState !== "visible" || !navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}

function clearHostResolution(reason = "The phone stopped before applying the resolution change.") {
  clearTimeout(hostResolutionTimer);
  pendingHostResolution?.reject(Error(reason));
  pendingHostResolution = null;
  byId("quality-warning").hidden = true;
}

async function warnHostResolution(choice) {
  if (choice !== 0 && !resolutions.includes(choice)) throw Error("Invalid resolution.");
  if (!stream) throw Error("Start the phone camera before changing its resolution.");
  clearHostResolution("The host replaced the resolution request.");
  const warning = byId("quality-warning");
  warning.textContent = "The host will switch this camera to " + (choice ? choice + "p" : "Auto") + " in 5 seconds.";
  warning.hidden = false;
  ui.toast(warning.textContent);
  await new Promise((resolve, reject) => {
    pendingHostResolution = {reject};
    syncControls();
    hostResolutionTimer = setTimeout(() => {
      pendingHostResolution = null;
      warning.hidden = true;
      resolve();
    }, 5000);
  });
  await chooseResolution(choice);
  return "Host set resolution to " + (choice ? choice + "p" : "Auto") + ".";
}

async function chooseResolution(choice) {
  const previous = prefs.resolution || autoResolution;
  const requested = choice || initialResolution;
  weakSamples = healthySamples = 0;
  autoQualityBlocked = false;
  if (!await changeResolution(requested, choice)) throw Error("The camera is busy changing resolution.");
  writePrefs();
  if (stream && requested > previous) {
    await delay(350);
    const settings = inputStream?.getVideoTracks()[0]?.getSettings();
    const actual = Math.min(settings?.width, settings?.height);
    if (actual && actual < requested && (prefs.resolution || autoResolution) === requested && !await restartCapture(""))
      throw Error("Could not restart the camera at the selected resolution.");
  }
  const setting = choice ? choice + "p" : "Auto";
  return "Resolution set to " + setting + ".";
}

async function setTorch(track, enabled) {
  await updateCameraTrack(track, {}, "torch", {torch: enabled});
  if (track !== inputStream?.getVideoTracks()[0]) return;
  light = enabled;
  cameraState.torch = light;
  rememberCamera();
  const button = byId("torch");
  ui.labelControl(button, light ? "Turn off flashlight" : "Turn on flashlight", "torch");
  button.setAttribute("aria-pressed", light);
}

function forgetPairing() {
  sessionStorage.removeItem(storageKey());
  if (!camera) return;
  try {
    const saved = JSON.parse(localStorage.getItem(appPairingKey));
    if (saved?.feed === feed) localStorage.removeItem(appPairingKey);
  } catch {}
}

function pairingPrompt(text = "", error = false) {
  if (!remote || !camera) return;
  if (fullscreenPreview) closeFullscreenPreview();
  byId("preview-fullscreen").hidden = true;
  byId("pairing").hidden = false;
  byId("capture-controls").hidden = true;
  byId("pair-another").hidden = true;
  byId("cancel-pairing").hidden = !paired;
  status(text || "Scan the camera QR code shown in OBS.", error);
}

function showPairedCamera() {
  stopQRScan();
  byId("pairing").hidden = true;
  byId("capture-controls").hidden = false;
  byId("manual-code").value = "";
  byId("pair-with-code").open = false;
  syncControls();
  showCaptureResolution();
  status("Paired · ready to start");
}

function pairingLinkCode(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch {}
  if (!url || url.protocol !== "https:" || url.username || url.password ||
      !["/c", "/camera"].includes(url.pathname) || url.search || !/^[A-Z2-9]{6}$/i.test(url.hash.slice(1))) {
    throw Error("Scan the camera pairing QR code from the OBS dock.");
  }
  if (url.origin !== location.origin) {
    throw Error("That QR code uses a different LAN Lens address. Open its camera link first.");
  }
  return url.hash.slice(1).toUpperCase();
}

function syncPairingControls() {
  byId("scan-pairing").disabled = pairingBusy || Boolean(scanAttempt);
  byId("cancel-scan").hidden = !scanAttempt;
  byId("cancel-pairing").disabled = pairingBusy;
  byId("submit-pair-code").disabled = pairingBusy;
}

function stopQRScan() {
  if (!scanAttempt) return;
  const attempt = scanAttempt;
  scanAttempt = null;
  if (attempt.stop) attempt.stop();
  byId("qr-preview").hidden = true;
  byId("qr-guide").hidden = true;
  syncPairingControls();
}

async function submitPairing(value, fromQR = false) {
  if (pairingBusy) return;
  stopQRScan();
  pairingBusy = true;
  syncPairingControls();
  status("Pairing…");
  try {
    const code = fromQR ? pairingLinkCode(value) : value;
    await init(code, "");
    ui.toast("Camera paired.");
  } catch (err) {
    pairingPrompt(err.message, true);
    ui.toast(err.message, true);
  } finally {
    pairingBusy = false;
    syncPairingControls();
  }
}

async function scanPairing() {
  if (scanAttempt || pairingBusy || starting || stream) return;
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    pairingPrompt("Trusted HTTPS is required to scan. Enter the code or open the trusted camera link.", true);
    byId("pair-with-code").open = true;
    return;
  }
  const attempt = {};
  scanAttempt = attempt;
  syncPairingControls();
  status("Opening the scanning camera…");

  function fail(message) {
    if (scanAttempt !== attempt) return;
    stopQRScan();
    pairingPrompt(message, true);
    ui.toast(message, true);
  }

  try {
    const {scanQR} = await import("/qr-scanner.js");
    if (scanAttempt !== attempt) return;
    const preview = byId("qr-preview");
    preview.hidden = false;
    attempt.stop = scanQR(preview, raw => {
      if (scanAttempt === attempt) submitPairing(raw, true);
    }, fail, () => {
      byId("qr-guide").hidden = false;
      status("Point the camera at the QR code.");
    });
  } catch {
    fail("Could not load the QR scanner. Try again or enter the pairing code.");
  }
}

function bindPairingControls() {
  byId("scan-pairing").onclick = scanPairing;
  byId("cancel-scan").onclick = () => {
    stopQRScan();
    pairingPrompt();
  };
  byId("cancel-pairing").onclick = showPairedCamera;
  byId("pair-another").onclick = () => pairingPrompt();
  byId("manual-code").oninput = event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "");
  };
  byId("manual-pair").onsubmit = event => {
    event.preventDefault();
    submitPairing(byId("manual-code").value);
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !scanAttempt) return;
    stopQRScan();
    pairingPrompt();
  });
}

function initializeCameraInstall() {
  if (!camera || matchMedia("(display-mode: standalone)").matches || navigator.standalone) return;
  const button = byId("install-camera");
  const offer = byId("install-offer");
  const promotionKey = "lanlens-install-offer";
  let installEvent;
  let seen = false;
  let workerError = false;
  try { seen = localStorage.getItem(promotionKey) === "seen"; } catch {}
  button.hidden = false;

  function dismissOffer() {
    offer.hidden = seen = true;
    try { localStorage.setItem(promotionKey, "seen"); } catch {}
  }

  function showHelp() {
    const help = byId("install-status");
    if (!isSecureContext || !remote || workerError) {
      help.textContent = "Open the HTTPS camera link in Chrome or Safari. If the address bar shows an X or certificate warning, confirm the LAN Lens CA was installed as a CA certificate, then reopen the link.";
    } else {
      help.textContent = "Open the browser menu to install LAN Lens. The browser shows the native install option when this connection is eligible.";
    }
    byId("install-help").showModal();
  }

  async function install() {
    dismissOffer();
    const prompt = installEvent;
    installEvent = null;
    try {
      if (prompt) await prompt.prompt();
      else if (remote && isSecureContext && typeof navigator.install === "function") await navigator.install();
      else showHelp();
    } catch (err) {
      if (err.name !== "AbortError") showHelp();
    }
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installEvent = event;
    if (!seen) offer.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    dismissOffer();
    button.hidden = true;
  });
  button.onclick = byId("install-now").onclick = install;
  byId("install-dismiss").onclick = dismissOffer;
  if (remote && isSecureContext) navigator.serviceWorker?.register("/camera-sw.js").catch(() => { workerError = true; });
}

async function init(code = invitation, requestedFeed = legacyKey ? feed : "") {
  if (camera && remote && !code && (!feed || !credential)) {
    pairingPrompt();
    return;
  }
  if (!code && (!feed || !credential)) throw Error("Open a feed from the dashboard or scan a pairing QR code.");
  if (remote && code) {
    const result = await api("enroll", {id: requestedFeed, role, key: code}, "");
    credential = result.key;
    feed = result.id || feed;
    sessionStorage.setItem(storageKey(), credential);
    if (camera) {
      sessionStorage.removeItem(cameraStateKey());
      cameraState = {};
      try { localStorage.setItem(appPairingKey, JSON.stringify({feed, key: credential})); } catch {}
      prefs = {resolution: 0, ...result.camera};
      byId("label").textContent = result.label;
    }
    history.replaceState(null, "", location.pathname + "#" + feed);
  }
  if (!camera) {
    window.onresize = () => applyRotation(rotation);
    byId("play").onclick = showVideo;
    video.addEventListener("resize", reportViewerDimensions);
    await connect(++cycle);
    return;
  }
  if (!code) {
    let saved;
    try { saved = await api("inspect", {id: feed, role, key: credential}, ""); }
    catch (err) {
      if (err.code === 401 || err.code === 404) forgetPairing();
      throw err;
    }
    try { cameraState = JSON.parse(sessionStorage.getItem(cameraStateKey())) || {}; } catch {}
    prefs = {resolution: 0, ...saved.camera, ...cameraState.prefs};
    byId("label").textContent = saved.label;
  }
  paired = true;
  aspectOverride = ["portrait", "landscape"].includes(cameraState.aspectOverride) ? cameraState.aspectOverride : "";
  rotatedLayout = aspectOverride === "landscape" && !landscapeViewport.matches;
  byId("camera-stats").open = Boolean(cameraState.statsOpen);
  byId("optics").open = Boolean(cameraState.opticsOpen);
  history.replaceState(null, "", "/c#" + feed);
  showPairedCamera();
  devices().catch(() => {});
  if (cameraState.active) await startCapture();
}

function bindPhoneControlSettings() {
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem(phoneControlsKey)) || {}; } catch {}
  function save() {
    try { localStorage.setItem(phoneControlsKey, JSON.stringify(preferences)); } catch {}
  }

  const panels = ["zoom-panel", "lens-panel", "resolution-panel", "fullscreen-panel"];
  for (const id of panels) {
    const panel = byId(id);
    if (typeof preferences.panels?.[id] === "boolean") panel.open = preferences.panels[id];
    panel.ontoggle = () => {
      preferences.panels = {...preferences.panels, [id]: panel.open};
      save();
    };
  }
  const opacity = byId("controls-opacity");
  function showOpacity() {
    updateSliderFill(opacity);
    document.body.style.setProperty("--controls-opacity", Number(opacity.value) / 100);
    byId("opacity-value").textContent = opacity.value + "%";
  }
  if (Number.isFinite(preferences.opacity)) opacity.value = preferences.opacity;
  opacity.oninput = showOpacity;
  opacity.onchange = () => {
    preferences.opacity = Number(opacity.value);
    save();
  };
  showOpacity();
}

function updateFullscreenVisibility() {
  const autoHide = fullscreenPreview && stream && !starting && !floatingControlsOpen;
  if (!autoHide) {
    clearTimeout(fullscreenControlsTimer);
    fullscreenControlsTimer = undefined;
    document.body.classList.remove("fullscreen-controls-hidden");
    return;
  }
  if (fullscreenControlsTimer || document.body.classList.contains("fullscreen-controls-hidden")) return;
  fullscreenControlsTimer = setTimeout(() => {
    fullscreenControlsTimer = undefined;
    const focused = document.activeElement;
    if (focused?.closest("#fullscreen-toolbar") &&
        CSS.supports("selector(:focus-visible)") && focused.matches(":focus-visible")) return;
    document.body.classList.add("fullscreen-controls-hidden");
  }, 3000);
}

function revealFullscreenControls() {
  clearTimeout(fullscreenControlsTimer);
  fullscreenControlsTimer = undefined;
  document.body.classList.remove("fullscreen-controls-hidden");
  updateFullscreenVisibility();
}

function setFloatingControls(open) {
  floatingControlsOpen = open;
  const button = byId("preview-settings");
  button.setAttribute("aria-expanded", open);
  ui.labelControl(button, open ? "Hide camera controls" : "Show camera controls", "settings");
  byId("phone-controls").classList.toggle("floating-controls-open", open);
  if (open) updatePhoneStats(inputStream?.getVideoTracks()[0]);
  else phoneStats?.reset();
  revealFullscreenControls();
}

function setFullscreenPreview(enabled) {
  fullscreenPreview = enabled;
  const button = byId("preview-fullscreen");
  button.setAttribute("aria-pressed", enabled);
  ui.labelControl(button, enabled ? "Exit full screen" : "Enter full screen", enabled ? "collapse" : "expand");
  document.body.classList.toggle("fullscreen-preview", enabled);
  byId("preview-settings").hidden = !enabled;
  const holder = byId("fullscreen-toolbar");
  const toolbar = byId("camera-toolbar");
  const shortcuts = byId("preview-actions");
  const focused = shortcuts.contains(document.activeElement) ? document.activeElement : null;
  holder.hidden = !enabled;
  if (enabled) {
    holder.append(toolbar, shortcuts);
  } else {
    byId("capture-controls").prepend(toolbar);
    byId("preview").append(shortcuts);
  }
  focused?.focus({preventScroll: true});
  setFloatingControls(false);
}

function closeFullscreenPreview() {
  const shouldExit = nativePreviewFullscreen && document.fullscreenElement && !orientationLocked;
  nativePreviewFullscreen = false;
  setFullscreenPreview(false);
  if (shouldExit) document.exitFullscreen().catch(() => {});
}

function bindFullscreenPreview() {
  const button = byId("preview-fullscreen");
  button.onclick = async () => {
    if (!paired) return;
    if (fullscreenPreview) {
      closeFullscreenPreview();
      return;
    }
    setFullscreenPreview(true);
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    button.disabled = true;
    try {
      await document.documentElement.requestFullscreen();
      if (fullscreenPreview) nativePreviewFullscreen = true;
      else if (!orientationLocked) await document.exitFullscreen();
    } catch {
      // The viewport layout also works in browsers that decline native fullscreen.
    } finally {
      button.disabled = false;
    }
  };
  byId("preview-settings").onclick = () => setFloatingControls(!floatingControlsOpen);
  byId("preview").addEventListener("pointerdown", revealFullscreenControls);
  byId("fullscreen-toolbar").addEventListener("pointerdown", revealFullscreenControls);
  document.addEventListener("fullscreenchange", () => {
    if (nativePreviewFullscreen && !document.fullscreenElement) closeFullscreenPreview();
  });
  document.addEventListener("keydown", event => {
    if (!fullscreenPreview || document.querySelector("dialog[open]")) return;
    if (event.key === "Tab") revealFullscreenControls();
    if (event.key !== "Escape") return;
    if (floatingControlsOpen) setFloatingControls(false);
    else closeFullscreenPreview();
  });
}

function bindCameraControls() {
  const statsPanel = byId("camera-stats");
  statsPanel.ontoggle = async () => {
    cameraState.statsOpen = statsPanel.open;
    rememberCamera();
    if (!statsPanel.open) {
      phoneStats?.reset();
      return;
    }
    try {
      if (!phoneStats) phoneStats = await import("/camera-stats.js");
      updatePhoneStats(inputStream?.getVideoTracks()[0]);
    } catch {
      if (statsPanel.open) ui.toast("Could not load camera statistics.", true);
    }
  };
  byId("optics").addEventListener("toggle", () => {
    cameraState.opticsOpen = byId("optics").open;
    rememberCamera();
  });
  byId("start").onclick = () => startCapture("Camera started.");
  byId("stop").onclick = () => {
    cameraState.active = false;
    rememberCamera();
    stopCapture();
    status("Camera stopped");
    ui.toast("Camera stopped.");
  };
  byId("camera").onchange = () => {
    const choice = byId("camera").value;
    const facing = choice === "front" ? "user" : choice === "rear" ? "environment" : lensSides.get(choice);
    selectLens(choice, facing);
  };
  byId("switch-lens").onclick = switchFacing;
  setupAspectButtons();
  bindFullscreenPreview();
  byId("eco").onclick = () => {
    prefs.eco = !prefs.eco;
    syncControls();
    writePrefs();
    ui.toast(prefs.eco ? "Eco Mode on. Local preview off." : "Local preview restored.");
  };
  byId("resolution").onchange = async () => {
    try { ui.toast(await chooseResolution(Number(byId("resolution").value))); }
    catch (err) { ui.toast(err.message, true); }
  };
  byId("mic-toggle").onclick = () => {
    const muted = !microphoneStatus().muted;
    try {
      setMicrophoneMuted(muted);
      ui.toast(muted ? "LAN Lens microphone muted." : "LAN Lens microphone unmuted.");
    } catch (err) { ui.toast(err.message, true); }
  };
  byId("reset").onclick = async () => {
    if (await ui.confirm({title: "Restart camera?", message: "The live feed will briefly disconnect.", accept: "Restart"}))
      await restartCapture("Camera restarted.");
  };
  bindPhoneControlSettings();
  byId("zoom").oninput = () => applyZoom(Number(byId("zoom").value));
  bindPreviewGestures();
  video.onresize = () => {
    if (stream === inputStream && video.srcObject === inputStream) sourceResize(video, zoomControl);
    showCaptureResolution();
  };
  byId("torch").onclick = async () => {
    const button = byId("torch");
    const track = inputStream?.getVideoTracks()[0];
    if (!track) return;
    button.disabled = true;
    try {
      await setTorch(track, !light);
      if (track !== inputStream?.getVideoTracks()[0]) return;
      ui.toast(light ? "Flashlight on." : "Flashlight off.");
    } catch (err) { ui.toast(err.message, true); }
    finally { button.disabled = false; }
  };
  document.addEventListener("visibilitychange", acquireWakeLock);
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (paired) devices().catch(() => {});
  });
}

window.addEventListener("pagehide", () => {
  if (camera) stopQRScan();
  if (session) fetch("/api/session", {method: "POST", keepalive: true,
    headers: {"Content-Type": "application/json", Authorization: "Bearer " + session},
    body: JSON.stringify({action: "leave"})}).catch(() => {});
});
if (camera) {
  bindCameraControls();
  bindPairingControls();
  initializeCameraInstall();
}
init().catch(err => {
  if (camera && remote) pairingPrompt(err.message, true);
  else if (camera) status(err.message, true);
  else viewerStatus("Feed unavailable", err.message, true);
});

