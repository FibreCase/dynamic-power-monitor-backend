import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOtaStatus, startOtaUpdate, uploadFirmware } from "../api";
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
  const [status, setStatus] = useState(null); // {available,size,mtime,device_online,firmware_version,ota_slot}
  const [busy, setBusy] = useState(null); // "upload" | "update" | null
  const [message, setMessage] = useState(null); // {ok, text}
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
      setMessage({ ok: true, text: `已保存固件 ${file.name}（${fmtBytes(r.size)}）。` });
      load();
    } catch (err) {
      setMessage({ ok: false, text: `上传失败：${err.message ?? err}` });
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate() {
    if (!window.confirm("即将向设备发送 OTA 命令，设备将重启进入新固件。确认继续？")) {
      return;
    }
    setBusy("update");
    setMessage(null);
    try {
      const r = await startOtaUpdate();
      setMessage({ ok: true, text: r.message ?? "命令已发送，设备即将重启。" });
    } catch (err) {
      setMessage({ ok: false, text: `更新失败：${err.message ?? err}` });
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
  const slotLabel = slot == null ? null : SLOT_LABEL[slot] ?? "未知";

  return (
    <div>
      <div className="stat-row">
        <StatTile
          label="当前固件"
          value={firmware ?? "—"}
          tone={firmware ? "default" : "warning"}
          sublabel={firmware ? "设备运行版本" : "设备未上报（未连接或旧固件）"}
        />
        <StatTile
          label="当前 OTA 槽位"
          value={slotLabel ?? "—"}
          tone={slotLabel ? "default" : "warning"}
          sublabel={slotLabel ? "运行分区" : "设备未上报"}
        />
      </div>

      <section className="ota-panel">
        <div className="ota-panel__head">
          <h2 className="ota-panel__title">固件更新（OTA）</h2>
          <div className="ota-panel__status">
            <span className={`status-pill status-pill--${available ? "good" : "warning"}`}>
              <span className="status-pill__dot" />
              {available ? `已保存固件 · ${fmtBytes(status.size)}` : "未上传固件"}
            </span>
            {status?.mtime != null && (
              <span className="ota-panel__mtime">上传于 {fmtTime(status.mtime)}</span>
            )}
          </div>
        </div>

        <div className="ota-panel__actions">
          <label className="ota-file">
            <input ref={fileRef} type="file" accept=".bin" onChange={onUpload} disabled={busy != null} />
            <span className="ota-file__btn">选择 .bin 固件</span>
          </label>
          <button
            type="button"
            className="ota-update"
            onClick={onUpdate}
            disabled={busy != null || !available || !online}
          >
            {busy === "update" ? "发送中…" : "推送到设备"}
          </button>
          {message && (
            <span className={`ota-message ${message.ok ? "ota-message--ok" : "ota-message--err"}`}>
              {message.text}
            </span>
          )}
        </div>

        <p className="ota-panel__hint">
          流程：选择固件 .bin → “推送到设备”。设备会拉取并重启；设备{online ? "在线" : "离线"}。
          若新固件无法启动，设备将自动回滚到上一版本。
        </p>
      </section>
    </div>
  );
}
