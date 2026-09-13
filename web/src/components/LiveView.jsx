import { useEffect, useMemo, useRef, useState } from "react";
import { buildWsUrl } from "../api";
import { buildStackedOption, buildMetrics, METRIC_COLORS } from "../chartOption";
import { getUnit, formatValue } from "../units";
import EChart from "./EChart";
import StatTile from "./StatTile";

const WINDOW_OPTIONS = [
  { ms: 30_000, label: "30 秒" },
  { ms: 60_000, label: "1 分钟" },
  { ms: 120_000, label: "2 分钟" },
  { ms: 300_000, label: "5 分钟" },
];

const RENDER_TICK_MS = 200; // chart refresh cadence, independent of the device's 0.1-10 Hz sample rate

const LINK_TONE = { connecting: "default", connected: "good", reconnecting: "warning" };
const LINK_LABEL = { connecting: "连接中", connected: "已连接", reconnecting: "重连中" };

function fmt(n, digits) {
  return typeof n === "number" ? n.toFixed(digits) : "--";
}

export default function LiveView({ health, unitMode = "m" }) {
  const [windowMs, setWindowMs] = useState(60_000);
  const [linkStatus, setLinkStatus] = useState("connecting");
  const [latest, setLatest] = useState(null);
  // {voltage,current,power} -> {min,max,avg} over the samples currently in the
  // window, already converted to the active display unit (raw is mA / mW).
  const [summary, setSummary] = useState(null);

  const currentUnit = getUnit("current", unitMode);
  const powerUnit = getUnit("power", unitMode);

  const bufferRef = useRef([]); // ascending {sys_ts, voltage, current, power}
  const chartRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const backoffRef = useRef(500);
  const unmountedRef = useRef(false);

  // Metric display-factors for the active units; the 200ms tick reads this
  // ref so live samples are pushed already converted to the chosen unit.
  const metricsRef = useRef(buildMetrics({ currentUnit: unitMode, powerUnit: unitMode }));

  // Built once (empty series) - all subsequent updates go through the
  // imperative chartRef.setOption path below, never re-triggering this.
  const initialOption = useMemo(
    () =>
      buildStackedOption([], {
        animate: false,
        currentUnit: unitMode,
        powerUnit: unitMode,
      }),
    [],
  );

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

      // min/max/avg over the (already unit-converted) window, one number per
      // metric so the tile can show "min – max · avg" in small text.
      const factor = Object.fromEntries(ms.map((m) => [m.key, m.factor]));
      const stat = (key) => {
        const f = factor[key];
        let min = Infinity,
          max = -Infinity,
          sum = 0;
        for (const s of buf) {
          const v = s[key] * f;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        return { min, max, avg: sum / buf.length };
      };
      setSummary({
        voltage: stat("voltage"),
        current: stat("current"),
        power: stat("power"),
      });
    }, RENDER_TICK_MS);
    return () => clearInterval(id);
  }, [windowMs, unitMode]);

  // When the unit toggle changes, push a fresh full option (new titles,
  // tooltips, and converted series) so the whole chart re-themes in place
  // without remounting the WebSocket. The first mount is skipped because
  // `initialOption` already seeded the chart with the active units.
  const firstUnitRenderRef = useRef(true);
  useEffect(() => {
    metricsRef.current = buildMetrics({ currentUnit: unitMode, powerUnit: unitMode });
    if (firstUnitRenderRef.current) {
      firstUnitRenderRef.current = false;
      return;
    }
    chartRef.current?.setOption(
      buildStackedOption(
        bufferRef.current.map((s) => ({ ...s })),
        { animate: false, currentUnit: unitMode, powerUnit: unitMode },
      ),
      { notMerge: true, lazyUpdate: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitMode]);

  // 3-state device status (matches the header pill): an unreachable backend
  // (health === null) reads as "未知" rather than the device being offline.
  const deviceState =
    health == null
      ? { label: "未知", tone: "default" }
      : health.device === true
        ? { label: "在线", tone: "good" }
        : { label: "离线", tone: "warning" };

  // "min - max | avg" for a metric's window summary (already unit-converted);
  // the unit itself stays on the main value, so these are bare numbers.
  const rangeText = (s, digits) =>
    s ? `${s.min.toFixed(digits)} - ${s.max.toFixed(digits)} | ${s.avg.toFixed(digits)}` : undefined;

  return (
    <div>
      <div className="stat-row">
        <StatTile
          label="电压"
          value={fmt(latest?.voltage, 3)}
          unit="V"
          dotColor={METRIC_COLORS.voltage}
          sublabel={rangeText(summary?.voltage, 3)}
        />
        <StatTile
          label="电流"
          value={formatValue(latest?.current, currentUnit)}
          unit={currentUnit.label}
          dotColor={METRIC_COLORS.current}
          sublabel={rangeText(summary?.current, currentUnit.digits)}
        />
        <StatTile
          label="功率"
          value={formatValue(latest?.power, powerUnit)}
          unit={powerUnit.label}
          dotColor={METRIC_COLORS.power}
          sublabel={rangeText(summary?.power, powerUnit.digits)}
        />
        <StatTile
          label="设备"
          value={deviceState.label}
          tone={deviceState.tone}
        />
        <StatTile
          label="链路"
          value={LINK_LABEL[linkStatus]}
          tone={LINK_TONE[linkStatus]}
          sublabel={health ? `查看人数 ${health.viewers}` : undefined}
        />
      </div>

      <div className="chart-card">
        <div className="chart-card__toolbar">
          <span className="chart-card__live">
            <span className="chart-card__live-dot" />
            实时
          </span>
          <label htmlFor="live-window" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            显示窗口
          </label>
          <select
            id="live-window"
            value={windowMs}
            onChange={(e) => setWindowMs(Number(e.target.value))}
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <EChart ref={chartRef} option={initialOption} height={480} />
      </div>
    </div>
  );
}
