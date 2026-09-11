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
