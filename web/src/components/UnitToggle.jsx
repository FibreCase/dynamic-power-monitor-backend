// Global current/power unit toggle. Current and power always switch together
// (mA↔A and mW↔W) since they share the same milli/base choice. Renders as a
// compact segmented control that fits the header row.
export default function UnitToggle({ mode, onChange }) {
  const options = [
    { id: "m", label: "mA · mW" },
    { id: "S", label: "A · W" },
  ];
  return (
    <div className="unit-toggle" role="group" aria-label="电流与功率单位">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={mode === o.id ? "active" : ""}
          onClick={() => onChange(o.id)}
          aria-pressed={mode === o.id}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
