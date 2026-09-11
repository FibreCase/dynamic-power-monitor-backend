// Presentational stat tile: label (+ optional metric-color dot) / value+unit
// / optional sublabel. `tone` drives a status-colored left border for
// connectivity tiles (dataviz: status color always paired with a label,
// never carrying meaning alone via color alone).
export default function StatTile({ label, value, unit, sublabel, tone = "default", dotColor }) {
  return (
    <div className={`stat-tile stat-tile--${tone}`}>
      <div className="stat-tile__label">
        {dotColor && <span className="stat-tile__dot" style={{ background: dotColor }} />}
        {label}
      </div>
      <div className="stat-tile__value">
        {value}
        {unit && <span className="stat-tile__unit">{unit}</span>}
      </div>
      {sublabel && <div className="stat-tile__sublabel">{sublabel}</div>}
    </div>
  );
}
