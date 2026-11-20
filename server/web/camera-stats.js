const labels = {none: "None reported", cpu: "CPU", bandwidth: "Bandwidth", other: "Other"};
let previous = new Map();

function value(key, text) {
  const field = document.getElementById("stat-" + key);
  if (field.textContent !== text) field.textContent = text;
}

function maximum(values) {
  return values.length ? Math.max(...values) : null;
}

function format(number, unit, decimals = 1) {
  return Number.isFinite(number) ? number.toFixed(decimals) + unit : "—";
}

export function render(track, entries = []) {
  const next = new Map();
  const sizes = new Set();
  const limits = new Set();
  const fps = [];
  const throughput = [];
  const encode = [];
  const latencies = [];
  const losses = [];

  for (const [peerID, report] of entries) {
    for (const stat of report.values()) {
      if (stat.type !== "outbound-rtp" || stat.kind !== "video" || !stat.bytesSent) continue;
      const key = peerID + ":" + stat.id;
      const old = previous.get(key);
      next.set(key, stat);

      if (stat.frameWidth && stat.frameHeight) sizes.add(stat.frameWidth + "×" + stat.frameHeight);
      if (labels[stat.qualityLimitationReason]) limits.add(labels[stat.qualityLimitationReason]);
      const elapsed = (stat.timestamp - old?.timestamp) / 1000;
      const frames = stat.framesEncoded - old?.framesEncoded;
      if (Number.isFinite(stat.framesPerSecond)) fps.push(stat.framesPerSecond);
      else if (elapsed > 0 && frames >= 0) fps.push(frames / elapsed);
      if (elapsed > 0 && stat.bytesSent >= old.bytesSent)
        throughput.push((stat.bytesSent - old.bytesSent) * 8 / elapsed / 1000);
      const encodeTime = stat.totalEncodeTime - old?.totalEncodeTime;
      if (frames > 0 && encodeTime >= 0) encode.push(encodeTime * 1000 / frames);

      const reception = report.get(stat.remoteId);
      if (Number.isFinite(reception?.roundTripTime)) latencies.push(reception.roundTripTime * 1000);
      if (Number.isFinite(reception?.fractionLost)) losses.push(Math.max(0, reception.fractionLost) * 100);
    }
  }
  previous = next;

  value("capture", format(track?.getSettings().frameRate, " fps"));
  value("fps", format(fps.length ? Math.min(...fps) : null, " fps"));
  value("size", [...sizes].join(", ") || "—");
  value("bitrate", format(throughput.length ? throughput.reduce((sum, rate) => sum + rate, 0) : null, " kb/s", 0));
  if (limits.size > 1) limits.delete(labels.none);
  value("limit", [...limits].join(", ") || "—");
  value("encode", format(maximum(encode), " ms"));
  value("rtt", format(maximum(latencies), " ms", 0));
  value("loss", format(maximum(losses), "%"));
}

export function reset() {
  previous.clear();
}
