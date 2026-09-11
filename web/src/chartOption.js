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
const isDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

const INK = {
  secondary: isDark ? "#c3c2b7" : "#52514e",
  muted: "#898781",
  gridline: isDark ? "#2c2c2a" : "#e1e0d9",
  axisLine: isDark ? "#383835" : "#c3c2b7",
};

export const METRICS = [
  {
    key: "voltage",
    label: "电压 (V)",
    color: isDark ? "#3987e5" : "#2a78d6", // categorical slot 1
  },
  {
    key: "current",
    label: "电流 (mA)",
    color: isDark ? "#d95926" : "#eb6834", // categorical slot 2
  },
  {
    key: "power",
    label: "功率 (mW)",
    color: isDark ? "#199e70" : "#1baf7a", // categorical slot 3
  },
];

/**
 * Build a full ECharts option for the three-panel voltage/current/power
 * chart. `samples` is an array of {sys_ts, voltage, current, power},
 * expected in ascending time order.
 */
export function buildStackedOption(samples = [], { animate = false } = {}) {
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
      valueFormatter: (v) => (typeof v === "number" ? v.toFixed(3) : v),
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
      data: samples.map((s) => [s.sys_ts, s[m.key]]),
    })),
  };
}
