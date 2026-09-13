import { useEffect, useState } from "react";
import { fetchHealth } from "./api";
import LiveView from "./components/LiveView";
import HistoryView from "./components/HistoryView";
import OtaView from "./components/OtaView";
import AlertView from "./components/AlertView";
import UnitToggle from "./components/UnitToggle";

const HEALTH_POLL_MS = 3000;
const UNIT_MODE_KEY = "pm.unitMode";

function loadUnitMode() {
  try {
    const v = localStorage.getItem(UNIT_MODE_KEY);
    return v === "S" ? "S" : "m";
  } catch {
    return "m";
  }
}

export default function App() {
  const [tab, setTab] = useState("live");
  const [health, setHealth] = useState(null);
  const [unitMode, setUnitMode] = useState(loadUnitMode);

  const setUnitModePersisted = (mode) => {
    setUnitMode(mode);
    try {
      localStorage.setItem(UNIT_MODE_KEY, mode);
    } catch {
      // storage unavailable (private mode / blocked) - keep it in-memory only
    }
  };

  // Lifted here (not inside LiveView) so the device-status pill in the
  // header stays live regardless of the active tab, with exactly one
  // polling interval for the whole app.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchHealth()
        .then((h) => { if (!cancelled) setHealth(h); })
        .catch(() => { if (!cancelled) setHealth(null); });
    };
    poll();
    const id = setInterval(poll, HEALTH_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const deviceOn = health?.device === true;

  // 3-state device status so an unreachable *backend* (health === null, e.g. a
  // transient fetch failure) reads as "未知" rather than the device offline.
  const deviceState =
    health == null
      ? { tone: "default", label: "未知" }
      : health.device === true
        ? { tone: "good", label: "在线" }
        : { tone: "warning", label: "离线" };

  return (
    <>
      <header className="app-header">
        <h1>12V 供电监控面板</h1>
        <UnitToggle mode={unitMode} onChange={setUnitModePersisted} />
        <span className={`status-pill status-pill--${deviceState.tone}`}>
          <span className="status-pill__dot" />
          设备{deviceState.label}
        </span>
      </header>

      <nav className="tab-nav">
        <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
          实时监控
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          历史查询
        </button>
        <button className={tab === "alerts" ? "active" : ""} onClick={() => setTab("alerts")}>
          异常日志
        </button>
        <button className={tab === "ota" ? "active" : ""} onClick={() => setTab("ota")}>
          固件更新
        </button>
      </nav>

      <main className="view" key={tab}>
        {/* Only one view is mounted at a time: switching away from Live unmounts
            it and closes its WebSocket - opening /ws is what bumps the ESP32 to
            10 Hz, so a backgrounded Live tab shouldn't hold the device at the
            fast rate. OtaView / AlertView likewise start/stop their poll on
            mount/unmount. */}
        {tab === "live" ? (
          <LiveView health={health} unitMode={unitMode} />
        ) : tab === "history" ? (
          <HistoryView unitMode={unitMode} />
        ) : tab === "alerts" ? (
          <AlertView unitMode={unitMode} />
        ) : (
          <OtaView deviceOnline={deviceOn} />
        )}
      </main>
    </>
  );
}
