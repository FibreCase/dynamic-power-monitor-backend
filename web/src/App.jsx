import { useEffect, useState } from "react";
import { fetchHealth } from "./api";
import { LANGS, LangContext, detectLang, translate } from "./i18n";
import { DEFAULT_UNIT_MODE } from "./units";
import LiveView from "./components/LiveView";
import HistoryView from "./components/HistoryView";
import OtaView from "./components/OtaView";
import AlertView from "./components/AlertView";
import UnitToggle from "./components/UnitToggle";
import LangToggle from "./components/LangToggle";

const HEALTH_POLL_MS = 3000;
const UNIT_MODE_KEY = "pm.unitMode";
const LANG_KEY = "pm.lang";

function loadUnitMode() {
  try {
    const v = localStorage.getItem(UNIT_MODE_KEY);
    return v === "m" || v === "S" ? v : DEFAULT_UNIT_MODE;
  } catch {
    return DEFAULT_UNIT_MODE;
  }
}

function loadLang() {
  try {
    return detectLang(localStorage.getItem(LANG_KEY));
  } catch {
    // storage unavailable (private mode / blocked) - fall back to the browser
    return detectLang(null);
  }
}

export default function App() {
  const [tab, setTab] = useState("live");
  const [health, setHealth] = useState(null);
  const [unitMode, setUnitMode] = useState(loadUnitMode);
  const [lang, setLang] = useState(loadLang);

  // App owns the language, so it can't read it back through the context it
  // provides - it translates with the plain helper; children use useT().
  const t = (key, params) => translate(lang, key, params);

  const setUnitModePersisted = (mode) => {
    setUnitMode(mode);
    try {
      localStorage.setItem(UNIT_MODE_KEY, mode);
    } catch {
      // storage unavailable (private mode / blocked) - keep it in-memory only
    }
  };

  const setLangPersisted = (id) => {
    setLang(id);
    try {
      localStorage.setItem(LANG_KEY, id);
    } catch {
      // storage unavailable (private mode / blocked) - keep it in-memory only
    }
  };

  // Keep the tab title and <html lang> in step with the chosen language.
  useEffect(() => {
    document.title = translate(lang, "app.title");
    document.documentElement.lang = LANGS.find((l) => l.id === lang)?.htmlLang ?? "en";
  }, [lang]);

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
  // transient fetch failure) reads as "unknown" rather than the device offline.
  const deviceState =
    health == null
      ? { tone: "default", labelKey: "status.unknown" }
      : health.device === true
        ? { tone: "good", labelKey: "status.online" }
        : { tone: "warning", labelKey: "status.offline" };

  return (
    <LangContext.Provider value={lang}>
      <header className="app-header">
        <h1>{t("app.title")}</h1>
        <UnitToggle mode={unitMode} onChange={setUnitModePersisted} />
        <LangToggle lang={lang} onChange={setLangPersisted} />
        <span className={`status-pill status-pill--${deviceState.tone}`}>
          <span className="status-pill__dot" />
          {t("app.deviceStatus", { status: t(deviceState.labelKey) })}
        </span>
      </header>

      <nav className="tab-nav">
        <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
          {t("tab.live")}
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          {t("tab.history")}
        </button>
        <button className={tab === "alerts" ? "active" : ""} onClick={() => setTab("alerts")}>
          {t("tab.alerts")}
        </button>
        <button className={tab === "ota" ? "active" : ""} onClick={() => setTab("ota")}>
          {t("tab.ota")}
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
    </LangContext.Provider>
  );
}
