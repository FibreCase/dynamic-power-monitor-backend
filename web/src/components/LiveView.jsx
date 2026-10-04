import { useEffect, useMemo, useRef, useState } from "react";
import { buildWsUrl } from "../api";
import { buildStackedOption, buildTemperatureOption, buildMetrics, METRIC_COLORS, samplePoint } from "../chartOption";
import { getUnit, formatValue, DEFAULT_UNIT_MODE } from "../units";
import { useLang, useT } from "../i18n";
import EChart from "./EChart";
import StatTile from "./StatTile";

const WINDOW_OPTIONS = [
  { ms: 30_000, labelKey: "live.window.30s" },
  { ms: 60_000, labelKey: "live.window.1m" },
  { ms: 120_000, labelKey: "live.window.2m" },
  { ms: 300_000, labelKey: "live.window.5m" },
];

const RENDER_TICK_MS = 200; // chart refresh cadence, independent of the device's 0.1-10 Hz sample rate

const LINK_TONE = { connecting: "default", connected: "good", reconnecting: "warning" };
const LINK_LABEL_KEY = {
  connecting: "link.connecting",
  connected: "link.connected",
  reconnecting: "link.reconnecting",
};

function fmt(n, digits) {
  return typeof n === "number" ? n.toFixed(digits) : "--";
}

export default function LiveView({ health, unitMode = DEFAULT_UNIT_MODE }) {
  const t = useT();
  const lang = useLang();
  const [windowMs, setWindowMs] = useState(60_000);
  const [linkStatus, setLinkStatus] = useState("connecting");
  const [latest, setLatest] = useState(null);
  // {voltage,current,power,temperature} -> {min,max,avg} over the samples
  // currently in the window, already converted to the active display unit.
  const [summary, setSummary] = useState(null);

  const currentUnit = getUnit("current", unitMode);
  const powerUnit = getUnit("power", unitMode);

  const bufferRef = useRef([]); // ascending {sys_ts, voltage, current, power, temperature}
  const chartRef = useRef(null);
  const tempChartRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const backoffRef = useRef(500);
  const unmountedRef = useRef(false);

  // Metric display-factors for the active units; the 200ms tick reads this
  // ref so live samples are pushed already converted to the chosen unit.
  const metricsRef = useRef(buildMetrics({ currentUnit: unitMode, powerUnit: unitMode, lang }));

  // Built once (empty series) - all subsequent updates go through the
  // imperative chartRef.setOption path below, never re-triggering this.
  const initialOption = useMemo(
    () =>
      buildStackedOption([], {
        animate: false,
        currentUnit: unitMode,
        powerUnit: unitMode,
        lang,
      }),
    // mount-time seed only; unit/lang changes re-theme via the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Temperature rides its own chart (see buildTemperatureOption) and is
  // unit-independent, so this is seeded once too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialTempOption = useMemo(() => buildTemperatureOption([], { animate: false, lang }), []);

  useEffect(() => {
    unmountedRef.current = false;

    function connect() {
      const ws = new WebSocket(buildWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        backoffRef.current = 500;
        setLinkStatus("connected");
      };
      ws.onmessage = (evt) => {
        try {
          bufferRef.current.push(JSON.parse(evt.data));
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (unmountedRef.current) return;
        setLinkStatus("reconnecting");
        reconnectTimerRef.current = setTimeout(() => {
          backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
          connect();
        }, backoffRef.current);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      unmountedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  // Prune the buffer by elapsed wall-clock time (not sample count - the
  // device's rate varies 10 Hz active / 0.1 Hz idle, so a fixed-count ring
  // buffer would misrepresent density) and push a data-only patch to the
  // chart on a fixed cadence, decoupled from the WS message rate.
  useEffect(() => {
    // Reset the window's min/max/avg so a wider/narrower window doesn't show
    // stats computed over a different span until new samples arrive.
    setSummary(null);
    const id = setInterval(() => {
      const cutoff = Date.now() - windowMs;
      const buf = bufferRef.current;
      let i = 0;
      while (i < buf.length && buf[i].sys_ts < cutoff) i++;
      if (i > 0) buf.splice(0, i);
      if (buf.length === 0) return;

      const ms = metricsRef.current;
      chartRef.current?.setOption(
        {
          series: ms.map((m) => ({
            data: buf.map((s) => [s.sys_ts, s[m.key] * m.factor]),
          })),
        },
        { notMerge: false, lazyUpdate: true },
      );
      setLatest(buf[buf.length - 1]);

      // Same window into the temperature chart.
      tempChartRef.current?.setOption(
        { series: [{ data: buf.map((s) => samplePoint(s, "temperature")) }] },
        { notMerge: false, lazyUpdate: true },
      );

      // min/max/avg over the window, one number per metric so the tile can show
      // "min - max | avg" in small text. Temperature is optional (a device with
      // no sensor, or a historical row, has none), so it counts only real
      // values and reports null when there are none.
      const factor = { ...Object.fromEntries(ms.map((m) => [m.key, m.factor])), temperature: 1 };
      const stat = (key) => {
        const f = factor[key];
        let min = Infinity,
          max = -Infinity,
          sum = 0,
          n = 0;
        for (const s of buf) {
          const raw = s[key];
          if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
          const v = raw * f;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
          n++;
        }
        return n ? { min, max, avg: sum / n } : null;
      };
      setSummary({
        voltage: stat("voltage"),
        current: stat("current"),
        power: stat("power"),
        temperature: stat("temperature"),
      });
    }, RENDER_TICK_MS);
    return () => clearInterval(id);
  }, [windowMs, unitMode]);

  // When the unit or language changes, push a fresh full option (new titles,
  // tooltips, converted series) so the charts re-theme in place without
  // remounting the WebSocket. The first mount is skipped because the two
  // `initial*Option` seeds above already drew them with the active settings.
  const firstThemeRenderRef = useRef(true);
  useEffect(() => {
    metricsRef.current = buildMetrics({ currentUnit: unitMode, powerUnit: unitMode, lang });
    if (firstThemeRenderRef.current) {
      firstThemeRenderRef.current = false;
      return;
    }
    const samples = bufferRef.current.map((s) => ({ ...s }));
    chartRef.current?.setOption(
      buildStackedOption(samples, { animate: false, currentUnit: unitMode, powerUnit: unitMode, lang }),
      { notMerge: true, lazyUpdate: true },
    );
    tempChartRef.current?.setOption(
      buildTemperatureOption(samples, { animate: false, lang }),
      { notMerge: true, lazyUpdate: true },
    );
  }, [unitMode, lang]);

  // 3-state device status (matches the header pill): an unreachable backend
  // (health === null) reads as "unknown" rather than the device being offline.
  const deviceState =
    health == null
      ? { labelKey: "status.unknown", tone: "default" }
      : health.device === true
        ? { labelKey: "status.online", tone: "good" }
        : { labelKey: "status.offline", tone: "warning" };

  // "min - max | avg" for a metric's window summary (already unit-converted);
  // the unit itself stays on the main value, so these are bare numbers.
  const rangeText = (s, digits) =>
    s ? `${s.min.toFixed(digits)} - ${s.max.toFixed(digits)} | ${s.avg.toFixed(digits)}` : undefined;

  return (
    <div>
      <div className="stat-row">
        <StatTile
          label={t("metric.voltage")}
          value={fmt(latest?.voltage, 3)}
          unit="V"
          dotColor={METRIC_COLORS.voltage}
          sublabel={rangeText(summary?.voltage, 3)}
        />
        <StatTile
          label={t("metric.current")}
          value={formatValue(latest?.current, currentUnit)}
          unit={currentUnit.label}
          dotColor={METRIC_COLORS.current}
          sublabel={rangeText(summary?.current, currentUnit.digits)}
        />
        <StatTile
          label={t("metric.power")}
          value={formatValue(latest?.power, powerUnit)}
          unit={powerUnit.label}
          dotColor={METRIC_COLORS.power}
          sublabel={rangeText(summary?.power, powerUnit.digits)}
        />
        <StatTile
          label={t("metric.temperature")}
          value={fmt(latest?.temperature, 1)}
          unit="°C"
          dotColor={METRIC_COLORS.temperature}
          sublabel={rangeText(summary?.temperature, 1)}
        />
        <StatTile
          label={t("metric.device")}
          value={t(deviceState.labelKey)}
          tone={deviceState.tone}
        />
        <StatTile
          label={t("metric.link")}
          value={t(LINK_LABEL_KEY[linkStatus])}
          tone={LINK_TONE[linkStatus]}
          sublabel={health ? t("live.viewers", { n: health.viewers }) : undefined}
        />
      </div>

      <div className="chart-card">
        <div className="chart-card__toolbar">
          <span className="chart-card__live">
            <span className="chart-card__live-dot" />
            {t("live.badge")}
          </span>
          <label htmlFor="live-window" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {t("live.window")}
          </label>
          <select
            id="live-window"
            value={windowMs}
            onChange={(e) => setWindowMs(Number(e.target.value))}
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>
        <EChart ref={chartRef} option={initialOption} height={480} />
      </div>

      <div className="chart-card">
        <EChart ref={tempChartRef} option={initialTempOption} height={180} />
      </div>
    </div>
  );
}
