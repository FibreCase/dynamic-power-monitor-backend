import { useMemo, useState } from "react";
import { fetchHistory } from "../api";
import { buildStackedOption, buildTemperatureOption, METRIC_COLORS } from "../chartOption";
import { getUnit, formatValue } from "../units";
import EChart from "./EChart";
import StatTile from "./StatTile";

const DEFAULT_LIMIT = 500;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function fmtTime(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function aggregate(rows) {
  if (rows.length === 0) return null;
  const agg = (key) =>
    rows.reduce(
      (a, r) => ({
        min: Math.min(a.min, r[key]),
        max: Math.max(a.max, r[key]),
        sum: a.sum + r[key],
      }),
      { min: Infinity, max: -Infinity, sum: 0 },
    );
  const n = rows.length;
  const withAvg = (a) => ({ ...a, avg: a.sum / n });
  return {
    count: n,
    voltage: withAvg(agg("voltage")),
    current: withAvg(agg("current")),
    power: withAvg(agg("power")),
    temperature: aggregateOptional(rows, "temperature"),
  };
}

// Temperature is optional: rows written before the column existed, and any
// sample from a device without a working internal sensor, carry none. Aggregate
// over only the rows that have a real value (null when none do), so the tile is
// simply omitted rather than showing NaN.
function aggregateOptional(rows, key) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  return n ? { min, max, avg: sum / n } : null;
}

export default function HistoryView({ unitMode = "m" }) {
  const [form, setForm] = useState({ start: "", end: "", limit: DEFAULT_LIMIT });
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [error, setError] = useState(null);

  const currentUnit = getUnit("current", unitMode);
  const powerUnit = getUnit("power", unitMode);

  const ascRows = useMemo(() => rows.slice().reverse(), [rows]);
  const stats = useMemo(() => aggregate(rows), [rows]);
  const chartOption = useMemo(
    () =>
      buildStackedOption(ascRows, {
        animate: true,
        currentUnit: unitMode,
        powerUnit: unitMode,
      }),
    [ascRows, unitMode],
  );
  const tempOption = useMemo(
    () => buildTemperatureOption(ascRows, { animate: true }),
    [ascRows],
  );

  async function onSubmit(e) {
    e.preventDefault();
    setStatus("loading");
    setError(null);
    try {
      const startTs = form.start ? new Date(form.start).getTime() : undefined;
      const endTs = form.end ? new Date(form.end).getTime() : undefined;
      const data = await fetchHistory({ startTs, endTs, limit: form.limit });
      setRows(data);
      setStatus("idle");
    } catch (err) {
      setError(String(err.message ?? err));
      setStatus("error");
    }
  }

  return (
    <div>
      <form className="query-form" onSubmit={onSubmit}>
        <label>
          起始时间
          <input
            type="datetime-local"
            value={form.start}
            onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
          />
        </label>
        <label>
          结束时间
          <input
            type="datetime-local"
            value={form.end}
            onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
          />
        </label>
        <label>
          条数上限
          <input
            type="number"
            min={1}
            max={5000}
            value={form.limit}
            onChange={(e) => setForm((f) => ({ ...f, limit: Number(e.target.value) }))}
          />
        </label>
        <button type="submit" disabled={status === "loading"}>
          {status === "loading" ? "查询中…" : "查询"}
        </button>
        {status === "error" && <span className="form-error">{error}</span>}
      </form>

      {stats && (
        <div className="stat-row">
          <StatTile label="记录数" value={stats.count} />
          <StatTile
            label="电压均值"
            value={stats.voltage.avg.toFixed(3)}
            unit="V"
            sublabel={`${stats.voltage.min.toFixed(3)} – ${stats.voltage.max.toFixed(3)}`}
            dotColor={METRIC_COLORS.voltage}
          />
          <StatTile
            label="电流均值"
            value={formatValue(stats.current.avg, currentUnit)}
            unit={currentUnit.label}
            sublabel={`${formatValue(stats.current.min, currentUnit)} – ${formatValue(stats.current.max, currentUnit)}`}
            dotColor={METRIC_COLORS.current}
          />
          <StatTile
            label="功率均值"
            value={formatValue(stats.power.avg, powerUnit)}
            unit={powerUnit.label}
            sublabel={`${formatValue(stats.power.min, powerUnit)} – ${formatValue(stats.power.max, powerUnit)}`}
            dotColor={METRIC_COLORS.power}
          />
          {stats.temperature && (
            <StatTile
              label="温度均值"
              value={stats.temperature.avg.toFixed(1)}
              unit="°C"
              sublabel={`${stats.temperature.min.toFixed(1)} – ${stats.temperature.max.toFixed(1)}`}
              dotColor={METRIC_COLORS.temperature}
            />
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="empty-note">尚无查询结果 — 设置时间范围（留空表示不限）后点击“查询”。</p>
      ) : (
        <>
          <div className="chart-card">
            <EChart option={chartOption} height={480} />
          </div>

          <div className="chart-card">
            <EChart option={tempOption} height={180} />
          </div>

          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>电压 (V)</th>
                  <th>电流 ({currentUnit.label})</th>
                  <th>功率 ({powerUnit.label})</th>
                  <th>温度 (°C)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.sys_ts}-${i}`}>
                    <td>{fmtTime(r.sys_ts)}</td>
                    <td>{r.voltage.toFixed(3)}</td>
                    <td>{formatValue(r.current, currentUnit)}</td>
                    <td>{formatValue(r.power, powerUnit)}</td>
                    <td>{r.temperature == null ? "—" : r.temperature.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
