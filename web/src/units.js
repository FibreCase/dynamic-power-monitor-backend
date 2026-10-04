// Display units for current and power. The wire/WS/DB always carry current
// in mA and power in mW (see protocol.py and the WebSocket contract); this
// module is purely presentational and converts for display only.
//
// `m` = milliwatt/milliampere (the raw stored unit), `S` = SI base unit
// (ampere / watt). The dashboard defaults to SI (A / W); a stored preference
// overrides it.
export const DEFAULT_UNIT_MODE = "S";

export const CURRENT_UNITS = [
  { id: "m", label: "mA", factor: 1, digits: 2, si: "A", siFactor: 0.001, siDigits: 3 },
  { id: "S", label: "A", factor: 0.001, digits: 3, si: null },
];

export const POWER_UNITS = [
  { id: "m", label: "mW", factor: 1, digits: 2, si: "W", siFactor: 0.001, siDigits: 2 },
  { id: "S", label: "W", factor: 0.001, digits: 2, si: null },
];

// Resolve a unit definition by id; an unknown/missing id falls back to the
// default (SI) entry so a stale or corrupted preference can't crash the view.
export function getUnit(kind, id) {
  const list = kind === "current" ? CURRENT_UNITS : POWER_UNITS;
  return list.find((u) => u.id === id) ?? list.find((u) => u.id === DEFAULT_UNIT_MODE) ?? list[0];
}

// Convert a raw mA / mW value to the selected display unit and format it.
// Returns "--" for a missing value so the empty state reads the same way
// elsewhere in the dashboard.
export function formatValue(rawValue, unit) {
  if (typeof rawValue !== "number") return "--";
  return (rawValue * unit.factor).toFixed(unit.digits);
}
