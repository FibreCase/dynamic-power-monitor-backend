import { useEffect, useState } from "react";
import { fetchHealth } from "./api";
import LiveView from "./components/LiveView";
import HistoryView from "./components/HistoryView";

const HEALTH_POLL_MS = 3000;

export default function App() {
  const [tab, setTab] = useState("live");
  const [health, setHealth] = useState(null);

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

  return (
    <>
      <header className="app-header">
        <h1>12V 供电监控面板</h1>
        <span className={`status-pill status-pill--${deviceOn ? "good" : "warning"}`}>
          <span className="status-pill__dot" />
          设备{deviceOn ? "在线" : "离线"}
        </span>
      </header>

      <nav className="tab-nav">
        <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
          实时监控
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          历史查询
        </button>
      </nav>

      <main className="view">
        {/* Conditional (not both-mounted) so switching to History actually
            unmounts LiveView and closes its WebSocket - opening /ws is what
            bumps the ESP32 to 10 Hz, so a backgrounded Live tab shouldn't
            silently hold the device at the fast rate. */}
        {tab === "live" ? <LiveView health={health} /> : <HistoryView />}
      </main>
    </>
  );
}
