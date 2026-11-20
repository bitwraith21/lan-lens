"use strict";

const ui = (() => {
  const glyphs = {
    add: "M12 5v14M5 12h14",
    camera: "M3 7h12v10H3z M15 10l6-3v10l-6-3",
    flip: "M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4",
    expand: "M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6",
    collapse: "M3 9h6V3m12 6h-6V3M3 15h6v6m12-6h-6v6",
    screen: "M3 5h18v13H3z M8 22h8m-4-4v4",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zm10-3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
    qr: "M3 3h6v6H3z m12 0h6v6h-6z M3 15h6v6H3z m12 0h3v3h3v3m-6 0v-3m6-6v3m-9-3v3",
    left: "M3 11a9 9 0 1 1 3 9M3 4v7h7",
    right: "M21 11a9 9 0 1 0-3 9m3-16v7h-7",
    reload: "M20 6a8 8 0 1 0 1 8m0-10v5h-5",
    ask: "M3 4h18v13H9l-6 4zm7 4a2 2 0 1 1 3 2c-.7.5-1 .8-1 2m0 2h.01",
    linkOff: "m10 14 4-4m-7 5-2 2a3 3 0 0 0 4 4l3-3m1-8 3-3a3 3 0 0 1 4 4l-2 2M3 3l18 18",
    edit: "m4 16 12-12 4 4L8 20H4zm10-10 4 4",
    trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15m-8 4v7m4-7v7",
    settings: "M9 3h6l.5 3 2 .9 2.5-1.4 3 5.2-2.4 1.7v2.2l2.4 1.8-3 5.1-2.6-1.2-1.9 1-.5 2.7H9L8.5 21l-2-1-2.5 1.3-3-5.2 2.4-1.7v-2.2L1 10.4l3-5.2 2.6 1.3 1.9-.9ZM12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    identify: "M9 3H3v6m12-6h6v6m0 6v6h-6M3 15v6h6m3-13v8m-4-4h8",
    link: "m10 14 4-4m-7 5-2 2a3 3 0 0 0 4 4l4-4a3 3 0 0 0 0-4m4-4 2-2a3 3 0 0 0-4-4l-4 4a3 3 0 0 0 0 4",
    close: "m6 6 12 12M18 6 6 18",
    zoom: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm5 12 6 6M7 10h6m-3-3v6",
    crop: "M5 3v14h16M3 7h14v14M8 10h6v4H8z",
    aspect: "M4 7h12v10H4z M18 3h2a1 1 0 0 1 1 1v5m-3-6 3 3 2-3M6 14h3m3-4h2",
    landscape: "M3 6h18v12H3zm4 3H6v2m11 4h1v-2",
    portrait: "M7 3h10v18H7zm5 14h.01",
    eco: "M4 7h15v11H4z m17 3v5m-8-6-3 4h4l-3 3",
    mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zm-4 6v1a7 7 0 0 0 14 0v-1m-7 8v3m-4 0h8",
    micOff: "M9 8V5a3 3 0 0 1 6 0v7m-6-.5v.5a3 3 0 0 0 4.6 2.5M5 11v1a7 7 0 0 0 11.4 5.4M19 11v1c0 .9-.2 1.7-.5 2.5M12 19v3m-4 0h8M3 3l18 18",
    torch: "m13 2-8 12h6l-1 8 9-12h-6z",
    start: "m8 4 13 8-13 8z",
    stop: "M6 6h12v12H6z",
    check: "m4 12 5 5L20 6"
  };
  const ns = "http://www.w3.org/2000/svg";
  let timer;
  let lastToast;
  let lastTime = 0;

  function icon(name) {
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", glyphs[name]);
    svg.append(path);
    return svg;
  }

  function replaceContents(element, ...children) {
    if (typeof element.replaceChildren === "function") element.replaceChildren(...children);
    else {
      element.textContent = "";
      for (const child of children) element.appendChild(child);
    }
  }

  function labelControl(control, label, glyph, showText = false) {
    control.title = label;
    control.setAttribute("aria-label", label);
    replaceContents(control, icon(glyph));
    if (showText) {
      const text = document.createElement("span");
      text.textContent = label;
      control.append(text);
    }
    return control;
  }

  function toast(message, error = false, pending = false) {
    const time = Date.now();
    if (message === lastToast && time - lastTime < 2200) return;
    lastToast = message;
    lastTime = time;
    const openDialog = document.querySelector("dialog[open]");
    const parent = openDialog || document.body;
    let region = parent.querySelector(":scope > .toast");
    if (!region) {
      region = document.createElement("div");
      region.className = "toast";
      region.setAttribute("role", "status");
      region.setAttribute("aria-atomic", "true");
      parent.append(region);
    }
    clearTimeout(timer);
    // Only one message is visible, including when a dialog opens or closes.
    for (const other of document.querySelectorAll(".toast")) {
      if (other !== region) other.classList.remove("visible");
    }
    region.dataset.error = error;
    region.dataset.pending = pending;
    replaceContents(region, icon(error ? "close" : pending ? "reload" : "check"), document.createTextNode(message));
    region.classList.add("visible");
    timer = setTimeout(() => {
      region.classList.remove("visible");
      replaceContents(region);
    }, error ? 5600 : 3100);
  }

  function confirm({title, message, accept, danger = false, timeout = 0}) {
    let dialog = document.getElementById("confirm-action");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "confirm-action";
      dialog.className = "dialog";
      dialog.setAttribute("aria-labelledby", "confirm-title");
      dialog.setAttribute("aria-describedby", "confirm-message");
      dialog.innerHTML = '<form method="dialog"><h2 id="confirm-title"></h2><p id="confirm-message"></p><div class="dialog-actions"><button value="cancel" autofocus>Cancel</button><button id="confirm-accept" value="accept">Confirm</button></div></form>';
      document.body.append(dialog);
    }
    if (dialog.open) return Promise.resolve(false);
    dialog.querySelector("h2").textContent = title;
    dialog.querySelector("p").textContent = message;
    const button = dialog.querySelector("#confirm-accept");
    button.textContent = accept;
    button.className = danger ? "danger-solid" : "primary";
    dialog.returnValue = "";
    return new Promise(resolve => {
      const timer = timeout ? setTimeout(() => dialog.close("cancel"), timeout) : undefined;
      dialog.addEventListener("close", () => {
        clearTimeout(timer);
        resolve(dialog.returnValue === "accept");
      }, {once: true});
      dialog.showModal();
    });
  }

  for (const control of document.querySelectorAll("[data-icon]")) {
    labelControl(control, control.textContent.trim(), control.dataset.icon, control.hasAttribute("data-label"));
  }

  return {icon, labelControl, replaceContents, toast, confirm};
})();
