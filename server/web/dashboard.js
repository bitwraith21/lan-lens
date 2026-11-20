"use strict";
const $ = id => document.getElementById(id);
const dock = new URLSearchParams(location.search).has("dock");
const launchKey = location.hash.slice(1);
const storageKey = dock ? "lanlens-admin" : "lanlens-browser";
function stored(value) {
  try {
    const storage = dock ? sessionStorage : localStorage;
    if (value === undefined) return storage.getItem(storageKey) || "";
    if (value) storage.setItem(storageKey, value);
    else storage.removeItem(storageKey);
  } catch {
    // Access for this page still works if the browser blocks persistent storage.
    return "";
  }
}
let key = launchKey || stored();
if (launchKey) {
  if (dock) stored(launchKey);
  history.replaceState(null, "", location.pathname + location.search);
}
let current = [];
let pairLink = "";
let qrImage = "";
let editing = "";
let signature = "";
let accordions = {};
let pendingAccordions = new Map();
let saveAccordion = Promise.resolve();
let vacantSources = [];
let trustURL = "";
let trustImage = "";
let bindingFeed = "";
let bindOptions = [];
const pendingMicrophones = new Map();
let refreshIssued = 0;
let refreshApplied = 0;

async function api(action, fields = {}, signal) {
  const response = await fetch("/api/admin", {
    method: "POST",
    headers: {"Content-Type": "application/json", Authorization: "Bearer " + key},
    body: JSON.stringify({action, ...fields}),
    signal
  });
  if (response.status === 401) {
    showAccessPrompt();
    throw Object.assign(Error("Dashboard access is required."), {auth: true});
  }
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").dataset.error = error;
}

async function loadPhoneTrust() {
  if (!trustURL || (!$("trust-phone").hidden && $("trust-url").href === trustURL)) return;
  try {
    const {image, url, fingerprint} = await api("trust-page");
    if (trustURL !== url) return;
    if (trustImage) URL.revokeObjectURL(trustImage);
    trustImage = URL.createObjectURL(new Blob([Uint8Array.from(atob(image), c => c.charCodeAt(0))], {type: "image/png"}));
    $("trust-qr").src = trustImage;
    $("trust-url").href = url;
    $("trust-url").textContent = url;
    $("trust-fingerprint").textContent = fingerprint;
    $("trust-phone").hidden = false;
  } catch (err) { showError(err); }
}

function showError(err) {
  if (!err.auth) ui.toast(err.message, true);
}

function button(label, glyph, onclick, className = "") {
  const el = document.createElement("button");
  el.className = className;
  ui.labelControl(el, label, glyph);
  el.onclick = async () => {
    el.disabled = true;
    try { await onclick(); } catch (err) { showError(err); }
    finally { el.disabled = false; }
  };
  return el;
}

async function mutate(action, fields, message) {
  await api(action, fields);
  ui.toast(message);
  await refresh();
}

async function pair(feed, role) {
  const {url, image, expiresAt} = await api("pair", {id: feed.id, role});
  pairLink = url;
  $("pair-link").value = url;
  $("pair-code").textContent = "App code " + new URL(url).hash.slice(1);
  $("pair-expires").textContent = "Use once before " + new Date(expiresAt).toLocaleTimeString([], {
    hour: "numeric", minute: "2-digit", second: "2-digit"
  }) + ".";
  if (qrImage) URL.revokeObjectURL(qrImage);
  qrImage = URL.createObjectURL(new Blob([Uint8Array.from(atob(image), c => c.charCodeAt(0))], {type: "image/png"}));
  $("qr").src = qrImage;
  $("pair-title").textContent = (role === "camera" ? "Pair camera · " : "Pair display · ") + feed.label;
  $("pair-scan-hint").hidden = role !== "camera";
  $("pair").showModal();
}

function edit(feed) {
  editing = feed?.id || "";
  $("edit-title").textContent = feed ? "Rename feed" : "Add feed";
  $("name").value = feed?.label || "";
  $("edit-error").hidden = true;
  $("edit").showModal();
  $("name").focus();
}

function actionGroup(label, controls) {
  const section = document.createElement("div");
  section.className = "feed-group";
  const heading = document.createElement("p");
  heading.textContent = label;
  const row = document.createElement("div");
  row.className = "button-group";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", label);
  row.append(...controls);
  section.append(heading, row);
  return section;
}

function accordion(details, section, id = "") {
  const name = section + ":" + id;
  details.dataset.accordion = name;
  details.querySelector("summary").onclick = event => {
    event.preventDefault();
    const open = !details.open;
    details.open = open;
    const pending = {open};
    pendingAccordions.set(name, pending);
    saveAccordion = saveAccordion.then(async () => {
      try {
        await api("accordion", {section, id, open});
        accordions[name] = open;
      } catch (err) {
        showError(err);
      } finally {
        if (pendingAccordions.get(name) === pending) pendingAccordions.delete(name);
        syncAccordions();
      }
    });
  };
  return details;
}

function syncAccordions() {
  for (const details of document.querySelectorAll("details[data-accordion]")) {
    const name = details.dataset.accordion;
    details.open = pendingAccordions.get(name)?.open ?? accordions[name] ?? name.startsWith("setup:");
  }
}

function feedAccordion(section, feed, title) {
  const details = document.createElement("details");
  details.className = "feed-controls";
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.append(summary);
  return accordion(details, section, feed.id);
}

function describeBinding() {
  const source = bindOptions.find(item => item.uuid === $("bind-source").value);
  const scenes = (source?.scenes || []).map(scene => scene.name);
  $("bind-scenes").textContent = scenes.length ? "Used in " + scenes.join(", ") : "This source is outside the current scenes.";
  $("save-bind").disabled = !source;
}

function openBinding(feed) {
  bindingFeed = feed.id;
  bindOptions = vacantSources;
  ui.replaceContents($("bind-source"), ...bindOptions.map(source => new Option(source.name, source.uuid)));
  $("bind-error").hidden = true;
  describeBinding();
  $("bind").showModal();
}

async function showPhoneResult(request, pending) {
  ui.toast(pending, false, true);
  const result = await api("phone-result", {request});
  ui.toast(result.message, !result.success);
}

async function command(feed, kind, message) {
  const result = await api("command", {id: feed.id, command: kind});
  if (result.request) await showPhoneResult(result.request, message);
  else ui.toast(message);
}

function syncMicrophoneButtons() {
  const feeds = new Map(current.map(feed => [feed.id, feed]));
  for (const [id, pending] of pendingMicrophones) {
    if (feeds.get(id)?.mic?.connection === pending.connection) continue;
    pendingMicrophones.delete(id);
    if (pending.controller) pending.controller.abort();
    ui.toast("The phone disconnected before confirming the microphone change.", true);
  }

  for (const control of $("feeds").querySelectorAll(".feed-mic")) {
    const mic = feeds.get(control.dataset.feed)?.mic;
    const available = Boolean(mic?.available);
    const muted = available && mic.muted;
    let label = muted ? "Unmute microphone" : "Mute microphone";
    if (!mic) label = "Microphone offline";
    else if (!available) label = "Microphone unavailable";
    else if (mic.interrupted && !muted) label = "Mute microphone (interrupted)";
    if (control.getAttribute("aria-label") !== label)
      ui.labelControl(control, label, muted || !available ? "micOff" : "mic", true);
    control.setAttribute("aria-pressed", muted);
    control.disabled = !available || pendingMicrophones.has(control.dataset.feed);
  }
}

function microphoneButton(feed) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "feed-mic";
  control.dataset.feed = feed.id;
  control.onclick = async () => {
    const mic = current.find(item => item.id === feed.id)?.mic;
    if (!mic?.available || pendingMicrophones.has(feed.id)) return;
    const {connection} = mic;
    const muted = !mic.muted;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const pending = {connection, controller};
    const ownsRequest = () => pendingMicrophones.get(feed.id) === pending;
    const signal = controller?.signal;
    pendingMicrophones.set(feed.id, pending);
    syncMicrophoneButtons();

    try {
      const {request} = await api("set-microphone", {id: feed.id, muted, connection}, signal);
      if (!ownsRequest()) return;
      ui.toast(muted ? "Mute request sent to the phone." : "Unmute request sent to the phone.", false, true);
      const result = await api("phone-result", {request}, signal);
      if (ownsRequest()) ui.toast(result.message, !result.success);
    } catch (err) {
      if (ownsRequest()) showError(err);
    } finally {
      if (ownsRequest()) {
        try { await refresh(); } catch (err) { showError(err); }
        if (ownsRequest()) pendingMicrophones.delete(feed.id);
        syncMicrophoneButtons();
      }
    }
  };
  return control;
}

function resolutionPanel(feed) {
  const details = feedAccordion("resolution", feed, "Resolution");
  const form = document.createElement("form");
  form.className = "host-resolution";
  form.dataset.feed = feed.id;
  const label = document.createElement("label");
  label.className = "field";
  label.textContent = "Phone resolution";
  const select = document.createElement("select");
  ui.replaceContents(select, ...[0, 360, 540, 720, 1080].map(value => new Option(value ? value + "p" : "Auto", value)));
  const current = document.createElement("small");
  current.className = "muted";
  const apply = document.createElement("button");
  apply.textContent = "Apply";
  apply.className = "primary";
  apply.type = "submit";
  label.append(select, current);
  form.append(label, apply);
  form.onsubmit = async event => {
    event.preventDefault();
    apply.disabled = true;
    try {
      const {request} = await api("setResolution", {id: feed.id, resolution: Number(select.value)});
      await showPhoneResult(request, "Resolution change sent. The phone displays a five-second warning.");
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      apply.disabled = !form.dataset.online;
    }
  };
  details.append(form);
  return details;
}

function syncResolutionPanels() {
  for (const form of document.querySelectorAll(".host-resolution")) {
    const feed = current.find(item => item.id === form.dataset.feed);
    if (!feed) continue;
    const resolution = feed.camera.resolution || 0;
    const select = form.querySelector("select");
    const currentSetting = String(resolution);
    if (form.dataset.setting !== currentSetting) {
      select.value = resolution;
      form.dataset.setting = currentSetting;
    }
    if (form.dataset.online !== (feed.online ? "1" : "")) {
      form.dataset.online = feed.online ? "1" : "";
      select.disabled = form.querySelector("button").disabled = !feed.online;
    }
    const text = "Current: " + (resolution ? resolution + "p" : "Auto");
    const received = feed.received?.length ? " · Received " + feed.received.join(", ") : "";
    form.querySelector("small").textContent = feed.online ? text + received : text + " · Start the phone to change it";
  }
}

function presenceText(feed) {
  if (!feed.online) return feed.views ? "Waiting for camera" : "Offline";
  if (!feed.views) return "Online";
  return "Online · " + feed.views + (feed.views === 1 ? " display" : " displays");
}

function render(feeds) {
  const content = $("feeds");
  ui.replaceContents(content);
  if (!feeds.length) {
    const empty = document.createElement("p");
    empty.className = "panel";
    empty.textContent = "Add a feed to pair your first camera.";
    content.append(empty);
  }
  for (const f of feeds) {
    const card = document.createElement("article");
    card.className = "feed";
    const head = document.createElement("div");
    head.className = "feed-head";
    const title = document.createElement("h3");
    title.textContent = f.label;
    title.title = f.label;
    const presence = document.createElement("span");
    presence.className = "presence" + (f.online ? " online" : "");
    presence.dataset.id = f.id;
    presence.textContent = presenceText(f);
    head.append(title, presence);
    const preview = document.createElement("a");
    preview.className = "button";
    ui.labelControl(preview, "Preview", "eye");
    preview.href = "/view#" + f.id + "." + f.viewerKey;
    preview.target = "_blank";
    preview.rel = "noopener noreferrer";
    const details = feedAccordion("controls", f, "Feed controls");
    const setup = feedAccordion("setup", f, "Feed setup");
    const sourcePanel = feedAccordion("sources", f, "OBS sources & scenes");
    const sources = document.createElement("div");
    sources.className = "bound-sources";
    for (const source of f.sources || []) {
      const row = document.createElement("p");
      const names = (source.scenes || []).map(scene => scene.name);
      row.textContent = source.name + (names.length ? " · " + names.join(", ") : "");
      row.title = row.textContent;
      sources.append(row);
    }
    const ask = (title, message, accept) => ui.confirm({title, message, accept, danger: true});
    const setupActions = [
        button("Pair camera", "qr", () => pair(f, "camera"), "primary"),
        button("Pair display", "screen", () => pair(f, "view")),
        button("Add to OBS scene", "add", async () => {
          const result = await api("addToOBS", {id: f.id});
          ui.toast(result.message);
          await refresh();
        }),
        button("Identify", "identify", () => command(f, "identify", "Identify sent to displays."))
    ];
    if (vacantSources.length && !sources.childElementCount) {
      setupActions.push(button("Link existing OBS source", "link", () => openBinding(f)));
    }
    setup.append(actionGroup("Pairing and sources", setupActions));
    if (!sources.childElementCount) {
      const empty = document.createElement("p");
      empty.textContent = "No OBS source linked.";
      sources.append(empty);
    }
    sourcePanel.append(sources);
    card.append(head, setup, sourcePanel, resolutionPanel(f));
    details.append(
      actionGroup("Display controls", [
        button("Rotate left", "left", () => mutate("rotate", {id: f.id, rotation: -90}, "Rotated left.")),
        button("Rotate right", "right", () => mutate("rotate", {id: f.id, rotation: 90}, "Rotated right.")),
        preview,
        button("Reload displays", "reload", () => command(f, "reload-view", "Reload sent to displays."))
      ]),
      actionGroup("Camera and feed controls", [
        button("Ask camera to restart", "ask", () => command(f, "ask-reset", "Restart request sent to the phone.")),
        button("Restart camera", "reload", async () => {
          if (await ui.confirm({title: "Restart camera?", message: "The live feed will briefly disconnect.", accept: "Restart"}))
            await command(f, "reload-camera", "Restart command sent to the phone.");
        }),
        button("Unpair camera", "linkOff", async () => {
          if (await ask("Unpair camera?", "The current phone will need a new pairing link.", "Unpair"))
            await mutate("disconnect", {id: f.id}, "Camera unpaired.");
        }),
        button("Rename feed", "edit", () => edit(f)),
        button("Delete feed", "trash", async () => {
          if (await ask("Delete “" + f.label + "”?", "This invalidates the pairing links and makes linked OBS sources available for reuse.", "Delete"))
            await mutate("delete", {id: f.id}, "Feed deleted.");
        }, "danger")
      ]),
      microphoneButton(f)
    );
    card.append(details);
    content.append(card);
  }
}

async function refresh() {
  const issued = ++refreshIssued;
  const state = await api("state");
  if (issued < refreshApplied) return;
  refreshApplied = issued;
  current = state.feeds;
  accordions = state.accordions || {};
  vacantSources = state.vacantSources || [];
  $("https-current").textContent = state.customHTTPS ? "Pairing host: " + state.customHTTPS : "Using the LAN Lens local certificate.";
  $("https-reset").hidden = !state.customHTTPS;
  $("pair-trust").hidden = !state.trustURL;
  if (trustURL !== (state.trustURL || "")) {
    trustURL = state.trustURL || "";
    $("trust-phone").hidden = true;
    if ($("trust").open) loadPhoneTrust();
  }
  $("trust-status").textContent = state.customHTTPS
    ? "Phones that trust the configured HTTPS certificate can skip this step."
    : trustURL ? "Scan on the phone or type the address to download the local CA."
      : "The phone download is unavailable. You can still save the certificate from this computer.";
  $("address").disabled = Boolean(state.customHTTPS);
  $("network").textContent = state.address ? state.address + " · LAN" : "No LAN address";
  const addresses = state.addresses || [];
  const addressMenu = $("address");
  if (JSON.stringify(Array.from(addressMenu.options).slice(1).map(option => option.value)) !== JSON.stringify(addresses)) {
    ui.replaceContents(addressMenu, new Option("Automatic", ""), ...addresses.map(address => new Option(address, address)));
  }
  addressMenu.value = addresses.includes(state.preferredAddress) ? state.preferredAddress : "";
  const next = JSON.stringify([vacantSources, current.map(({id, label, viewerKey, sources}) => [id, label, viewerKey, sources])]);
  if (next !== signature) {
    render(current);
    signature = next;
  } else {
    for (const p of $("feeds").querySelectorAll(".presence")) {
      const feed = current.find(f => f.id === p.dataset.id);
      p.classList.toggle("online", feed.online);
      p.textContent = presenceText(feed);
    }
  }
  syncAccordions();
  syncResolutionPanels();
  syncMicrophoneButtons();
}

$("add").onclick = () => edit();
$("identify-all").onclick = async () => {
  const button = $("identify-all");
  button.disabled = true;
  try {
    const {queued} = await api("identify-all");
    ui.toast("Identify sent to " + queued + (queued === 1 ? " display." : " displays."));
  } catch (err) { showError(err); }
  finally { button.disabled = false; }
};
$("settings").onclick = () => $("setup").showModal();
$("close-settings").onclick = () => $("setup").close();
$("cancel-edit").onclick = () => $("edit").close();
accordion($("trust"), "trust");
if (dock) {
  const openBrowser = $("open-browser");
  openBrowser.hidden = false;
  openBrowser.onclick = async () => {
    openBrowser.disabled = true;
    try { await api("open-browser"); }
    catch (err) { showError(err); }
    finally { openBrowser.disabled = false; }
  };
}
$("trust").addEventListener("toggle", () => { if ($("trust").open) loadPhoneTrust(); });
$("pair-trust").onclick = () => {
  $("pair").close();
  $("setup").showModal();
  if (!$("trust").open) $("trust").querySelector("summary").click();
  else loadPhoneTrust();
};
accordion($("https-config"), "https");
$("https-form").onsubmit = async event => {
  event.preventDefault();
  const https = {
    hostname: $("https-host").value,
    certificate: $("https-cert").value,
    key: $("https-key").value
  };
  try {
    await mutate("customHTTPS", {https}, "Pairing links now use " + https.hostname + ".");
    $("https-form").reset();
  } catch (err) { showError(err); }
};
$("https-reset").onclick = () => mutate("customHTTPS", {}, "Pairing links now use the local certificate.").catch(showError);
$("bind-source").onchange = describeBinding;
$("cancel-bind").onclick = () => $("bind").close();
$("bind-form").onsubmit = async event => {
  event.preventDefault();
  $("save-bind").disabled = true;
  $("bind-error").hidden = true;
  try {
    const result = await api("bindSource", {id: bindingFeed, source: $("bind-source").value});
    $("bind").close();
    ui.toast(result.message);
    await refresh();
  } catch (err) {
    if (!err.auth) {
      $("bind-error").textContent = err.message;
      $("bind-error").hidden = false;
      $("save-bind").disabled = false;
    }
  }
};
$("feed-form").onsubmit = async event => {
  event.preventDefault();
  const submit = $("save-edit");
  const action = editing ? "rename" : "create";
  $("edit-error").hidden = true;
  submit.disabled = true;
  try {
    await api(action, {id: editing, label: $("name").value});
    $("edit").close();
    ui.toast(action === "rename" ? "Feed renamed." : "Feed added.");
    await refresh();
  } catch (err) {
    if (err.auth) return;
    if (!$("edit").open) { ui.toast(err.message, true); return; }
    $("edit-error").textContent = err.message;
    $("edit-error").hidden = false;
  } finally {
    submit.disabled = false;
  }
};
$("close").onclick = () => $("pair").close();
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(pairLink);
    ui.toast("Pairing link copied.");
  } catch {
    const link = $("pair-link");
    link.select();
  }
};
$("pair").onclose = () => {
  URL.revokeObjectURL(qrImage);
  qrImage = "";
  pairLink = "";
  $("pair-link").value = "";
  $("pair-code").textContent = "";
};
$("address").onchange = () => mutate("address", {address: $("address").value}, "Pairing address updated.").catch(showError);
for (const action of ["import", "export"]) {
  $(action).onclick = async () => {
    if (action === "import" && !await ui.confirm({
      title: "Import settings?", message: "This replaces current settings and closes active camera sessions.", accept: "Choose file"
    })) return;
    $(action).disabled = true;
    try {
      const result = await api(action);
      if (result.cancelled) return;
      if (action === "export") ui.toast(result.revealed ? "Settings exported. Folder opened." : "Settings exported to " + result.path);
      else { ui.toast("Settings imported."); await refresh(); }
    } catch (err) { showError(err); }
    finally { $(action).disabled = false; }
  };
}
if (dock) {
  $("certificate").onclick = async event => {
    event.preventDefault();
    try {
      const result = await api("certificate");
      if (!result.cancelled) ui.toast("Trust certificate saved.");
    } catch (err) { showError(err); }
  };
}

function showAccessPrompt() {
  key = "";
  stored("");
  $("dashboard-controls").hidden = true;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("browser-access").hidden = dock;
  notice(dock ? "Dashboard access expired. Reopen LAN Lens in OBS." : "", dock);
}

function supportWindow(now) {
  const hour = now.getHours();
  if (hour < 10) return null;
  return {
    day: [now.getFullYear(), now.getMonth() + 1, now.getDate()].join("-"),
    slot: hour < 14 ? "morning" : "afternoon"
  };
}

const supportStorageKey = "lanlens-support-dismissed";
let supportDismissal = {};
try {
  if (dock) supportDismissal = JSON.parse(localStorage.getItem(supportStorageKey)) || {};
} catch {}
let visibleSupportWindow = null;

function updateSupportReminder(now = new Date()) {
  if (!dock) return;
  const period = supportWindow(now);
  const dismissed = period && supportDismissal.day === period.day && supportDismissal[period.slot];
  visibleSupportWindow = dismissed ? null : period;
  $("support-reminder").hidden = !visibleSupportWindow;
  $("dashboard-controls").classList.toggle("support-visible", Boolean(visibleSupportWindow));
}

if (dock) {
  $("dismiss-support").onclick = () => {
    if (!visibleSupportWindow) return;
    const {day, slot} = visibleSupportWindow;
    if (supportDismissal.day !== day) supportDismissal = {day};
    supportDismissal[slot] = true;
    try { localStorage.setItem(supportStorageKey, JSON.stringify(supportDismissal)); } catch {}
    updateSupportReminder();
  };
  $("open-kofi").onclick = async () => {
    try { await api("open-kofi"); }
    catch (err) { showError(err); }
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateSupportReminder();
  });
}

async function monitor() {
  try {
    await refresh();
    $("browser-access").hidden = true;
    $("dashboard-controls").hidden = false;
    updateSupportReminder();
    notice("");
  } catch (err) {
    if (err.auth) return;
    notice("Could not reach LAN Lens. Keep OBS open and try again.", true);
  }
  setTimeout(monitor, 1800);
}

async function connect() {
  if (!dock && launchKey) {
    try {
      const response = await fetch("/api/browser-access", {
        method: "POST",
        headers: {Authorization: "Bearer " + launchKey}
      });
      if (response.ok) {
        const {credential} = await response.json();
        key = credential;
        stored(credential);
      } else {
        key = stored();
      }
    } catch {
      key = stored() || launchKey;
    }
  }
  if (key) monitor();
  else showAccessPrompt();
}
connect();
