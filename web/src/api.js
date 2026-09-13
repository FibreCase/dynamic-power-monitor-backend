// Thin fetch/WS wrappers. Relative paths only - the Vite dev proxy forwards
// them to the backend in dev, and the backend serves this app same-origin
// in prod, so the same code works unmodified in both (see vite.config.js /
// power_monitor/app.py). No CORS, no configurable base URL, ever.

export function buildWsUrl() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ? JSON.stringify(body.detail) : `${path} -> ${res.status}`);
  }
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: body && body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: body || undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.detail ? JSON.stringify(json.detail) : `${path} -> ${res.status}`);
  }
  return json;
}

export function fetchHealth() {
  return getJson("/healthz");
}

export function fetchHistory({ startTs, endTs, limit = 500 } = {}) {
  const params = new URLSearchParams();
  if (startTs != null) params.set("start_ts", startTs);
  if (endTs != null) params.set("end_ts", endTs);
  params.set("limit", limit);
  return getJson(`/api/v1/history?${params}`);
}

// Overcurrent (OCP) events from either detection path (device ALERT / host
// threshold), time-descending. sys_ts is milliseconds (like history).
export function fetchAlerts({ startTs, endTs, limit = 200 } = {}) {
  const params = new URLSearchParams();
  if (startTs != null) params.set("start_ts", startTs);
  if (endTs != null) params.set("end_ts", endTs);
  params.set("limit", limit);
  return getJson(`/api/v1/alerts?${params}`);
}

// -- OTA (firmware update) ---------------------------------------------------
export function fetchOtaStatus() {
  return getJson("/ota/status");
}

// Upload a .bin. Sends it as multipart/form-data (field "file"); the browser
// sets the multipart boundary, so we pass the FormData as the body verbatim.
export function uploadFirmware(file) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return postJson("/ota/upload", fd);
}

export function startOtaUpdate() {
  return postJson("/ota/update");
}
