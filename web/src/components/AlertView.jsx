import { useCallback, useEffect, useState } from "react";
import { fetchAlerts } from "../api";
import { getUnit, formatValue } from "../units";
import StatTile from "./StatTile";

const POLL_MS = 5000; // refresh cadence; events are low-frequency
const PAGE_LIMIT = 200;

// source column: 'device' = INA226 ALERT pin (hardware), 'host' = backend threshold.
const SOURCE_LABEL = { device: "设备告警", host: "后端阈值" };
const TYPE_LABEL = { 0x01: "过流" };

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function fmtTime(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export default function AlertView({ unitMode = "m" }) {
  const [rows, setRows] = useState(null); // null = never loaded yet
  const [error, setError] = useState(null);

  const currentUnit = getUnit("current", unitMode);
  const powerUnit = getUnit("power", unitMode);

  const load = useCallback(() => {
    fetchAlerts({ limit: PAGE_LIMIT })
      .then((data) => {
        setRows(data);
        setError(null);
      })
      .catch((err) => setError(String(err.message ?? err)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const total = rows?.length ?? 0;
  const deviceCount = rows?.filter((r) => r.source === "device").length ?? 0;
  const hostCount = rows?.filter((r) => r.source === "host").length ?? 0;

  return (
    <div>
      <div className="stat-row">
        <StatTile label="事件总数" value={rows == null ? "…" : total} tone={total > 0 ? "warning" : "default"} />
        <StatTile label="设备告警" value={rows == null ? "…" : deviceCount} sublabel="INA226 ALERT 引脚" />
        <StatTile label="后端阈值" value={rows == null ? "…" : hostCount} sublabel="后端电流判定" />
      </div>

      {error && <p className="empty-note">加载失败：{error}</p>}

      {rows == null ? (
        <p className="empty-note">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="empty-note">
          尚无过流事件 — 电流超过阈值时，两条检测路径（设备 ALERT 引脚 + 后端阈值）会各自记录一条。
        </p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>类型</th>
                <th>电压 (V)</th>
                <th>电流 ({currentUnit.label})</th>
                <th>功率 ({powerUnit.label})</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.sys_ts}-${i}`}>
                  <td>{fmtTime(r.sys_ts)}</td>
                  <td>{SOURCE_LABEL[r.source] ?? r.source}</td>
                  <td>{TYPE_LABEL[r.type] ?? `0x${r.type?.toString(16)}`}</td>
                  <td>{r.voltage?.toFixed(3)}</td>
                  <td>{formatValue(r.current, currentUnit)}</td>
                  <td>{formatValue(r.power, powerUnit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
