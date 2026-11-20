"use strict";

const optics = (() => {
  const panel = document.getElementById("optics");
  const controls = [
    {kind: "focus", mode: "focusMode", value: "focusDistance", select: "focus-mode", slider: "focus-value", name: "Focus"},
    {kind: "exposure", mode: "exposureMode", value: "exposureTime", select: "exposure-mode", slider: "exposure-value", name: "Exposure"}
  ];
  let track;
  let caps = {};
  const draftManual = new Set();
  let selected = {};
  let persist = () => {};
  let busy = false;

  function modes(control) { return caps[control.mode] || []; }
  function range(key) {
    const limits = caps[key];
    return limits && Number.isFinite(limits.min) && limits.max > limits.min ? limits : null;
  }

  function focusBounds() {
    const limits = range("focusDistance");
    if (!limits) return null;
    // Camera2 can report an effectively infinite far endpoint. Use optical power
    // to give the near-focus part of the slider useful travel.
    const near = Math.max(limits.min, limits.step || .01);
    const far = Math.min(limits.max, Math.max(100, near * 2));
    return near < far ? {near, far} : null;
  }

  function focusSlider(distance, bounds) {
    const shift = 1 / bounds.near - 1 / Math.min(bounds.far, Math.max(bounds.near, distance));
    return Math.round(100 * shift / (1 / bounds.near - 1 / bounds.far));
  }

  function requestedDistance(position, bounds) {
    const fraction = position / 100;
    const distance = 1 / ((1 - fraction) / bounds.near + fraction / bounds.far);
    const limits = range("focusDistance");
    const step = limits.step;
    return step > 0 ? Math.min(bounds.far, Math.max(bounds.near,
      limits.min + Math.round((distance - limits.min) / step) * step)) : distance;
  }

  function displayRange(id, key, current) {
    const input = document.getElementById(id);
    const limits = range(key);
    input.closest("label").hidden = !limits;
    if (!limits) return;
    if (key === "focusDistance") {
      const bounds = focusBounds();
      input.closest("label").hidden = !bounds;
      if (!bounds) return;
      input.min = 0;
      input.max = 100;
      input.step = 1;
      input.value = current > 0 ? focusSlider(current, bounds) : 50;
      input.setAttribute("aria-valuetext", input.value < 50 ? "Nearer" : "Farther");
      return;
    }
    input.min = limits.min;
    input.max = limits.max;
    input.step = limits.step || "any";
    input.value = current ?? limits.min;
    input.title = current === undefined ? "" : String(current);
  }

  function sync() {
    const current = track?.getSettings() || {};
    for (const control of controls) {
      const select = document.getElementById(control.select);
      select.closest("label").hidden = !modes(control).length;
      const selected = current[control.mode];
      ui.replaceContents(select, ...[
        ["continuous", "Auto"], ["single-shot", "Single shot"], ["manual", "Manual"], ["none", "Fixed"]
      ].filter(([value]) => modes(control).includes(value)).map(([value, label]) => new Option(label, value)));
      if (draftManual.has(control.kind)) select.value = "manual";
      else if (modes(control).includes(selected)) select.value = selected;
      displayRange(control.slider, control.value, current[control.value]);
      if (select.value !== "manual") document.getElementById(control.slider).closest("label").hidden = true;
    }
    displayRange("ev-value", "exposureCompensation", current.exposureCompensation);
    const available = controls.some(control => modes(control).length) || range("exposureCompensation");
    panel.hidden = !available;
    const note = document.getElementById("optic-hint");
    note.hidden = !draftManual.has("focus") && !draftManual.has("exposure");
    note.textContent = draftManual.has("focus") ? "Move the Near–Far slider to set manual focus." : "Move the shutter slider to set manual exposure.";
  }

  async function setTrack(next, saved, onChange) {
    track = next;
    caps = next?.getCapabilities?.() || {};
    draftManual.clear();
    selected = {};
    persist = onChange || (() => {});
    if (saved?.selected) {
      for (const control of controls) {
        const {pointsOfInterest, ...choice} = saved.locked?.[control.kind] || saved.selected[control.kind] || {};
        if (modes(control).includes(choice[control.mode]) && await checkedApply(control, choice, next.getSettings()))
          selected[control.kind] = choice;
      }
      if (range("exposureCompensation") && Number.isFinite(saved.selected.ev?.exposureCompensation)) {
        try {
          if (await apply("ev", saved.selected.ev)) selected.ev = saved.selected.ev;
        } catch {}
      }
    }
    sync();
  }

  function save() {
    persist({selected});
  }

  function currentSettings(control, current) {
    const mode = current[control.mode] || (modes(control).includes("continuous") ? "continuous" : "");
    const state = mode ? {[control.mode]: mode} : {};
    if (mode === "manual" && Number.isFinite(current[control.value])) state[control.value] = current[control.value];
    if (mode === "manual" && control.kind === "exposure" && Number.isFinite(current.iso)) state.iso = current.iso;
    return state;
  }

  async function apply(control, settings) {
    const active = track;
    if (!active) return false;
    await updateCameraTrack(active, {}, control, settings);
    if (active !== track) return false;
    function matches() {
      const actual = active.getSettings();
      for (const mode of ["focusMode", "exposureMode"]) {
        if (settings[mode] && actual[mode] && actual[mode] !== settings[mode]) return false;
      }
      for (const name of ["focusDistance", "exposureTime", "iso", "exposureCompensation"]) {
        if (!Number.isFinite(settings[name]) || !Number.isFinite(actual[name])) continue;
        const tolerance = (range(name)?.step || .01) / 2 + 1e-6;
        if (Math.abs(actual[name] - settings[name]) > tolerance) return false;
      }
      return true;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      if (active !== track) return false;
      if (matches()) return true;
      if (attempt < 3) await delay(120);
    }
    return false;
  }

  async function checkedApply(control, settings, previous) {
    const active = track;
    const fallback = selected[control.kind] || currentSettings(control, previous);
    try {
      if (await apply(control.kind, settings)) return true;
    } catch {}
    // Advanced constraints may succeed after partially changing the camera. Restore the prior mode.
    if (active === track) {
      try { await apply(control.kind, fallback); } catch {}
    }
    return false;
  }

  async function adjust(control, settings) {
    if (!track || busy) return;
    busy = true;
    try {
      if (await checkedApply(control, settings, track.getSettings())) {
        selected[control.kind] = settings;
        draftManual.delete(control.kind);
        save();
        ui.toast(control.name + " updated.");
      } else {
        ui.toast("This camera did not apply the requested " + control.name.toLowerCase() + " mode.", true);
      }
    } catch (err) { ui.toast(err.message, true); }
    finally { busy = false; sync(); }
  }

  for (const control of controls) {
    document.getElementById(control.select).onchange = event => {
      const mode = event.target.value;
      if (mode === "manual" && track?.getSettings()[control.mode] !== "manual" && range(control.value)) {
        draftManual.add(control.kind);
        sync();
        return;
      }
      draftManual.delete(control.kind);
      if (mode === "manual" && !range(control.value)) {
        sync();
        ui.toast("This lens does not expose a manual adjustment to the browser.", true);
        return;
      }
      adjust(control, {[control.mode]: mode});
    };
    const slider = document.getElementById(control.slider);
    slider.oninput = () => {
      if (control.kind === "focus")
        slider.setAttribute("aria-valuetext", slider.value < 50 ? "Nearer" : "Farther");
    };
    slider.onchange = event => {
      const position = Number(event.target.value);
      const bounds = focusBounds();
      if (control.kind === "focus" && !bounds) return;
      const value = control.kind === "focus" ? requestedDistance(position, bounds) : position;
      adjust(control, {[control.mode]: "manual", [control.value]: value});
    };
  }
  document.getElementById("ev-value").onchange = async event => {
    if (!track) return;
    try {
      const value = {exposureCompensation: Number(event.target.value)};
      if (!await apply("ev", value)) throw Error("The lens did not apply exposure compensation.");
      selected.ev = value;
      save();
      ui.toast("Exposure compensation updated.");
    } catch (err) { ui.toast(err.message, true); }
  };
  return {setTrack};
})();
