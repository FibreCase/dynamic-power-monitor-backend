// Shared ECharts option builder for the voltage/current/power trio.
//
// Three stacked single-axis grids (small multiples), not a dual/triple-axis
// chart: the three metrics have unrelated scales, so sharing an axis would
// visually correlate noise between them that isn't real (dataviz skill,
// "never a dual-axis chart"). Colors are the dataviz reference palette's
// categorical slots 1-3, which the palette explicitly validates as safe for
// an all-pairs (small-multiples) layout of exactly three series.
//
// ECharts renders to a <canvas>, so it can't just read CSS custom
// properties - colors are picked once from a prefers-color-scheme check at
// module load. (There's no in-app theme toggle, so this doesn't need to be
// reactive - a live OS theme flip won't re-theme an already-open chart
// without a reload, an accepted v1 scope cut.)
import { getUnit } from "./units";

const isDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

const INK = {
  secondary: isDark ? "#c3c2b7" : "#52514e",
  muted: "#898781",
  gridline: isDark ? "#2c2c2a" : "#e1e0d9",
  axisLine: isDark ? "#383835" : "#c3c2b7",
};

export const METRIC_COLORS = {
  voltage: isDark ? "#3987e5" : "#2a78d6", // categorical slot 1
  current: isDark ? "#d95926" : "#eb6834", // categorical slot 2
  power: isDark ? "#199e70" : "#1baf7a", // categorical slot 3
  temperature: isDark ? "#c98500" : "#eda100", // categorical slot 4
};

/**
 * One [ts, value] point for a sample, guarding a missing/non-finite value into
 * a null so ECharts draws a gap. This matters for temperature: rows written
 * before the column existed, and any sample from a device whose internal sensor
 * is unavailable, carry no temperature (JSON null) - without the guard
 * `null * 1` would plot a bogus 0 degC.
 */
export function samplePoint(sample, key, factor = 1) {
  const v = sample[key];
  return [sample.sys_ts, typeof v === "number" && Number.isFinite(v) ? v * factor : null];
}

// Build the three metric descriptors with labels that reflect the active
// display units (mA/mW vs A/W). Rebuilt whenever the unit toggle changes.
export function buildMetrics({ currentUnit = "m", powerUnit = "m" }) {
  const cu = getUnit("current", currentUnit);
  const pu = getUnit("power", powerUnit);
  return [
    { key: "voltage", label: `电压 (V)`, color: METRIC_COLORS.voltage, factor: 1, digits: 3, unit: "V" },
    { key: "current", label: `电流 (${cu.label})`, color: METRIC_COLORS.current, factor: cu.factor, digits: cu.digits, unit: cu.label },
    { key: "power", label: `功率 (${pu.label})`, color: METRIC_COLORS.power, factor: pu.factor, digits: pu.digits, unit: pu.label },
  ];
}

/**
 * Build a full ECharts option for the three-panel voltage/current/power
 * chart. `samples` is an array of {sys_ts, voltage, current, power},
 * expected in ascending time order. `currentUnit` / `powerUnit` select the
 * display units (raw values are mA / mW); defaults to mA / mW.
 */
export function buildStackedOption(
  samples = [],
  { animate = false, currentUnit = "m", powerUnit = "m" } = {},
) {
  const METRICS = buildMetrics({ currentUnit, powerUnit });
  const n = METRICS.length;
  const gap = 8;
  const h = (100 - gap * (n - 1)) / n;

  return {
    animation: animate,
    backgroundColor: "transparent",
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
    },
    grid: METRICS.map((_, i) => ({
      left: 56,
      right: 24,
      top: `${i * (h + gap) + 9}%`,
      height: `${h}%`,
    })),
    title: METRICS.map((m, i) => ({
      text: `{dot|●} ${m.label}`,
      textStyle: {
        rich: { dot: { color: m.color } },
        color: INK.secondary,
        fontSize: 12,
        fontWeight: "normal",
      },
      left: 56,
      top: `${i * (h + gap) + 1}%`,
    })),
    xAxis: METRICS.map((_, i) => ({
      gridIndex: i,
      type: "time",
      axisLabel: { show: i === n - 1, color: INK.muted },
      axisTick: { show: i === n - 1 },
      axisLine: { lineStyle: { color: INK.axisLine } },
      splitLine: { show: false },
    })),
    yAxis: METRICS.map((_, i) => ({
      gridIndex: i,
      type: "value",
      scale: true,
      axisLabel: { color: INK.muted },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: INK.gridline } },
    })),
    series: METRICS.map((m, i) => ({
      name: m.label,
      type: "line",
      xAxisIndex: i,
      yAxisIndex: i,
      showSymbol: false,
      sampling: "lttb",
      lineStyle: { width: 2, color: m.color },
      areaStyle: { color: m.color, opacity: 0.1 },
      itemStyle: { color: m.color },
      // Per-series tooltip so each value carries its own unit's precision
      // and suffix (e.g. "0.512 A" vs "512.00 mA").
      tooltip: {
        valueFormatter: (v) =>
          typeof v === "number" ? `${v.toFixed(m.digits)} ${m.unit}` : v,
      },
      data: samples.map((s) => samplePoint(s, m.key, m.factor)),
    })),
  };
}

/**
 * Single-series temperature chart, rendered in its own card below the
 * voltage/current/power chart.
 *
 * Deliberately NOT a fourth panel of `buildStackedOption`: that chart is small
 * multiples, which the palette validates on the all-pairs list, and a 4th slot
 * puts slot-4 yellow next to slot-2 orange - a pair that fails the all-pairs
 * floor (normal-vision dE 13.7 light / CVD 4.8 dark). Temperature is also a
 * different quantity on its own scale, so per the dataviz rules it gets its own
 * chart rather than sharing the trio's axes. As a lone series its yellow is
 * unpaired (validator: pass), and the title + tile label are its relief labels.
 */
export function buildTemperatureOption(samples = [], { animate = false } = {}) {
  const color = METRIC_COLORS.temperature;
  return {
    animation: animate,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      valueFormatter: (v) => (typeof v === "number" ? `${v.toFixed(1)} °C` : "—"),
    },
    grid: { left: 56, right: 24, top: 30, bottom: 28 },
    title: {
      text: "{dot|●} 温度 (°C)",
      textStyle: {
        rich: { dot: { color } },
        color: INK.secondary,
        fontSize: 12,
        fontWeight: "normal",
      },
      left: 56,
      top: 4,
    },
    xAxis: {
      type: "time",
      axisLabel: { color: INK.muted },
      axisTick: { color: INK.muted },
      axisLine: { lineStyle: { color: INK.axisLine } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: INK.muted },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: INK.gridline } },
    },
    series: [
      {
        name: "温度 (°C)",
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        connectNulls: false, // leave a gap where the device reported no temperature
        lineStyle: { width: 2, color },
        areaStyle: { color, opacity: 0.1 },
        itemStyle: { color },
        tooltip: {
          valueFormatter: (v) => (typeof v === "number" ? `${v.toFixed(1)} °C` : "—"),
        },
        data: samples.map((s) => samplePoint(s, "temperature")),
      },
    ],
  };
}
