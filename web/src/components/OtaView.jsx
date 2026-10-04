import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOtaStatus, startOtaUpdate, uploadFirmware } from "../api";
import { useT } from "../i18n";
import StatTile from "./StatTile";

const STATUS_POLL_MS = 4000;

// Running-partition subtype (see protocol.OTA_SLOT_*) -> human label.
const SLOT_LABEL = { 1: "ota_0", 2: "ota_1" };

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function fmtTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function OtaView({ deviceOnline }) {
  const t = useT();
  const [status, setStatus] = useState(null); // {available,size,mtime,device_online,firmware_version,ota_slot}
  const [busy, setBusy] = useState(null); // "upload" | "update" | null
  // Either a translation key (+params) so it re-renders on a language switch, or
  // a raw server-provided string (the backend's own message text).
  const [message, setMessage] = useState(null); // {ok, key?, params?, text?}
  const fileRef = useRef(null);

  const load = useCallback(() => {
    fetchOtaStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  async function onUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setBusy("upload");
    setMessage(null);
    try {
      const r = await uploadFirmware(file);
      setMessage({ ok: true, key: "ota.saved", params: { name: file.name, size: fmtBytes(r.size) } });
      load();
    } catch (err) {
      setMessage({ ok: false, key: "ota.uploadFailed", params: { err: String(err.message ?? err) } });
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate() {
    if (!window.confirm(t("ota.confirm"))) {
      return;
    }
    setBusy("update");
    setMessage(null);
    try {
      const r = await startOtaUpdate();
      // Prefer the backend's own message; fall back to a translated default.
      setMessage(r.message ? { ok: true, text: r.message } : { ok: true, key: "ota.sent" });
    } catch (err) {
      setMessage({ ok: false, key: "ota.updateFailed", params: { err: String(err.message ?? err) } });
    } finally {
      setBusy(null);
    }
  }

  const available = status?.available === true;
  const online = deviceOnline === true;

  // Device-reported running firmware + active slot. `null` until the device has
  // connected and sent its one-time device-info frame -> show a placeholder.
  const firmware = status?.firmware_version ?? null;
  const slot = status?.ota_slot;
  const slotLabel = slot == null ? null : SLOT_LABEL[slot] ?? t("status.unknown");

  return (
    <div>
      <div className="stat-row">
        <StatTile
          label={t("ota.currentFirmware")}
          value={firmware ?? "—"}
          tone={firmware ? "default" : "warning"}
          sublabel={firmware ? t("ota.runningVersion") : t("ota.notReportedOld")}
        />
        <StatTile
          label={t("ota.currentSlot")}
          value={slotLabel ?? "—"}
          tone={slotLabel ? "default" : "warning"}
          sublabel={slotLabel ? t("ota.runningPartition") : t("ota.notReported")}
        />
      </div>

      <section className="ota-panel">
        <div className="ota-panel__head">
          <h2 className="ota-panel__title">{t("ota.title")}</h2>
          <div className="ota-panel__status">
            <span className={`status-pill status-pill--${available ? "good" : "warning"}`}>
              <span className="status-pill__dot" />
              {available ? t("ota.stored", { size: fmtBytes(status.size) }) : t("ota.none")}
            </span>
            {status?.mtime != null && (
              <span className="ota-panel__mtime">{t("ota.uploadedAt", { time: fmtTime(status.mtime) })}</span>
            )}
          </div>
        </div>

        <div className="ota-panel__actions">
          <label className="ota-file">
            <input ref={fileRef} type="file" accept=".bin" onChange={onUpload} disabled={busy != null} />
            <span className="ota-file__btn">{t("ota.choose")}</span>
          </label>
          <button
            type="button"
            className="ota-update"
            onClick={onUpdate}
            disabled={busy != null || !available || !online}
          >
            {busy === "update" ? t("ota.pushing") : t("ota.push")}
          </button>
          {message && (
            <span className={`ota-message ${message.ok ? "ota-message--ok" : "ota-message--err"}`}>
              {message.key ? t(message.key, message.params) : message.text}
            </span>
          )}
        </div>

        <p className="ota-panel__hint">
          {t("ota.hint", { status: t(online ? "status.online" : "status.offline") })}
        </p>
      </section>
    </div>
  );
}
