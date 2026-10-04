import { useCallback, useEffect, useState } from "react";
import { fetchAlerts } from "../api";
import { DEFAULT_UNIT_MODE, getUnit, formatValue } from "../units";
import { useT } from "../i18n";
import StatTile from "./StatTile";

const POLL_MS = 5000; // refresh cadence; events are low-frequency
const PAGE_LIMIT = 200;

// source column: 'device' = INA226 ALERT pin (hardware), 'host' = backend threshold.
const SOURCE_KEY = { device: "alerts.source.device", host: "alerts.source.host" };
const TYPE_KEY = { 0x01: "alerts.type.ocp" };

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

export default function AlertView({ unitMode = DEFAULT_UNIT_MODE }) {
  const t = useT();
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
        <StatTile label={t("alerts.total")} value={rows == null ? "…" : total} tone={total > 0 ? "warning" : "default"} />
        <StatTile label={t("alerts.device")} value={rows == null ? "…" : deviceCount} sublabel={t("alerts.deviceSub")} />
        <StatTile label={t("alerts.host")} value={rows == null ? "…" : hostCount} sublabel={t("alerts.hostSub")} />
      </div>

      {error && <p className="empty-note">{t("alerts.loadError", { err: error })}</p>}

      {rows == null ? (
        <p className="empty-note">{t("alerts.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="empty-note">{t("alerts.empty")}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("col.time")}</th>
                <th>{t("col.source")}</th>
                <th>{t("col.type")}</th>
                <th>{t("col.withUnit", { metric: t("metric.voltage"), unit: "V" })}</th>
                <th>{t("col.withUnit", { metric: t("metric.current"), unit: currentUnit.label })}</th>
                <th>{t("col.withUnit", { metric: t("metric.power"), unit: powerUnit.label })}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.sys_ts}-${i}`}>
                  <td>{fmtTime(r.sys_ts)}</td>
                  <td>{SOURCE_KEY[r.source] ? t(SOURCE_KEY[r.source]) : r.source}</td>
                  <td>{TYPE_KEY[r.type] ? t(TYPE_KEY[r.type]) : `0x${r.type?.toString(16)}`}</td>
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
