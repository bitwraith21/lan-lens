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

async function api(action, fields = {}) {
  const response = await fetch("/api/admin", {
    method: "POST",
    headers: {"Content-Type": "application/json", Authorization: "Bearer " + key},
    body: JSON.stringify({action, ...fields})
  });
  if (response.status === 401 || response.status === 404) {
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

function button(label, onclick, className = "") {
  const el = document.createElement("button");
  el.textContent = label;
  el.className = className;
  el.onclick = () => Promise.resolve().then(onclick).catch(err => { if (!err.auth) notice(err.message, true); });
  return el;
}

async function mutate(action, fields, message) {
  await api(action, fields);
  if (message) notice(message);
  await refresh();
}

async function pair(feed, role) {
  const {url, image, expiresAt} = await api("pair", {id: feed.id, role});
  pairLink = url;
  $("pair-link").value = url;
  $("pair-link").hidden = true;
  $("pair-expires").textContent = "Use once before " + new Date(expiresAt).toLocaleTimeString([], {
    hour: "numeric", minute: "2-digit", second: "2-digit"
  }) + ".";
  if (qrImage) URL.revokeObjectURL(qrImage);
  qrImage = URL.createObjectURL(new Blob([Uint8Array.from(atob(image), c => c.charCodeAt(0))], {type: "image/png"}));
  $("qr").src = qrImage;
  $("pair-title").textContent = (role === "camera" ? "Pair camera · " : "Pair display · ") + feed.label;
  $("pair").showModal();
}

function edit(feed) {
  editing = feed?.id || "";
  $("edit-title").textContent = feed ? "Rename feed" : "Add feed";
  $("name").value = feed?.label || "";
  $("edit").showModal();
  $("name").focus();
}

function render(feeds) {
  $("feeds").replaceChildren();
  if (!feeds.length) {
    const empty = document.createElement("p");
    empty.textContent = "Add a feed to pair your first camera.";
    $("feeds").append(empty);
  }
  for (const f of feeds) {
    const card = document.createElement("article");
    card.className = "feed";
    const head = document.createElement("div");
    head.className = "feed-head";
    const title = document.createElement("h3");
    title.textContent = f.label;
    const presence = document.createElement("span");
    presence.className = "presence" + (f.online ? " online" : "");
    presence.dataset.id = f.id;
    presence.textContent = (f.online ? "Online" : "Offline") + " · " + f.views + " viewing";
    head.append(title, presence);
    const links = document.createElement("div");
    links.className = "actions";
    const preview = document.createElement("a");
    preview.className = "button";
    preview.textContent = "Preview";
    preview.href = "/view#" + f.id + "." + f.viewerKey;
    preview.target = "_blank";
    preview.rel = "noopener noreferrer";
    links.append(button("Pair camera", () => pair(f, "camera"), "primary"), button("Pair display", () => pair(f, "view")),
      button("Add to OBS", () => mutate("addToOBS", {id: f.id}, "Add request sent to the current OBS scene.")), preview);
    const controls = document.createElement("details");
    controls.className = "command-row";
    const summary = document.createElement("summary");
    summary.textContent = "Feed controls";
    const row = document.createElement("div");
    row.className = "actions command-row";
    const command = cmd => mutate("command", {id: f.id, command: cmd});
    row.append(button("Rotate left", () => mutate("rotate", {id: f.id, rotation: -90})),
      button("Rotate right", () => mutate("rotate", {id: f.id, rotation: 90})),
      button("Identify", () => command("identify")),
      button("Reload displays", () => command("reload-view")),
      button("Ask camera to reset", () => command("ask-reset")),
      button("Reload camera", () => command("reload-camera")),
      button("Rename", () => edit(f)),
      button("Unpair camera", () => confirm("Unpair this camera?") && mutate("disconnect", {id: f.id})),
      button("Delete feed", () => confirm("Delete “" + f.label + "”?") && mutate("delete", {id: f.id}), "danger"));
    controls.append(summary, row);
    card.append(head, links, controls);
    $("feeds").append(card);
  }
}

async function refresh() {
  const state = await api("state");
  current = state.feeds;
  $("network").textContent = state.address ? state.address + " · LAN" : "No LAN address";
  const addresses = state.addresses || [];
  const addressMenu = $("address");
  if (addressMenu.options.length !== addresses.length + 1) {
    addressMenu.replaceChildren(new Option("Automatic", ""), ...addresses.map(address => new Option(address, address)));
  }
  addressMenu.value = addresses.includes(state.preferredAddress) ? state.preferredAddress : "";
  const next = JSON.stringify(current.map(({id, label, viewerKey}) => [id, label, viewerKey]));
  if (next !== signature) {
    render(current);
    signature = next;
  } else {
    for (const p of $("feeds").querySelectorAll(".presence")) {
      const feed = current.find(f => f.id === p.dataset.id);
      p.classList.toggle("online", feed.online);
      p.textContent = (feed.online ? "Online" : "Offline") + " · " + feed.views + " viewing";
    }
  }
}

$("add").onclick = () => edit();
$("cancel-edit").onclick = () => $("edit").close();
$("save-edit").onclick = async () => {
  try {
    await mutate(editing ? "rename" : "create", {id: editing, label: $("name").value});
    $("edit").close();
  } catch (err) {
    if (err.auth) return;
    $("name").setCustomValidity(err.message);
    $("name").reportValidity();
  }
};
$("name").oninput = () => $("name").setCustomValidity("");
$("name").onkeydown = event => { if (event.key === "Enter") $("save-edit").click(); };
$("close").onclick = () => $("pair").close();
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(pairLink);
    $("copy").textContent = "Copied";
  } catch {
    const link = $("pair-link");
    link.hidden = false;
    link.select();
  }
};
$("pair").onclose = () => { $("copy").textContent = "Copy pairing link"; };
$("address").onchange = () => mutate("address", {address: $("address").value}).catch(err => { if (!err.auth) notice(err.message, true); });
for (const action of ["import", "export"]) {
  $(action).onclick = async () => {
    if (action === "import" && !confirm("Replace current LAN Lens settings and close active camera sessions?")) return;
    $(action).disabled = true;
    notice("Choose a file in the system file picker.");
    try {
      const result = await api(action);
      if (result.cancelled) notice("File selection cancelled.");
      else if (action === "export") notice((result.revealed ? "Exported and opened in the file manager. " : "Exported to ") + result.path);
      else { notice("Imported " + result.path); await refresh(); }
    } catch (err) { if (!err.auth) notice(err.message, true); }
    finally { $(action).disabled = false; }
  };
}
if (dock) {
  $("certificate").onclick = async event => {
    event.preventDefault();
    notice("Choose where to save the trust certificate.");
    try {
      const result = await api("certificate");
      if (result.cancelled) notice("File selection cancelled.");
      else notice("Trust certificate saved to " + result.path);
    } catch (err) { if (!err.auth) notice(err.message, true); }
  };
}
function showAccessPrompt() {
  key = "";
  stored("");
  $("dashboard-controls").hidden = true;
  if ($("pair").open) $("pair").close();
  if ($("edit").open) $("edit").close();
  $("browser-access").hidden = dock;
  notice(dock ? "Dashboard access expired. Reopen LAN Lens in OBS." : "", dock);
}

async function monitor() {
  try {
    await refresh();
    if ($("dashboard-controls").hidden) {
      $("browser-access").hidden = true;
      $("dashboard-controls").hidden = false;
      notice("");
    }
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
