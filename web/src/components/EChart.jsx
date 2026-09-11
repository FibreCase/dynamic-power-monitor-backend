import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as echarts from "echarts";

/**
 * Thin ECharts wrapper with two update paths:
 *  - declarative `option` prop: full replace (notMerge:true) whenever it
 *    changes - what HistoryView uses, one chart per query.
 *  - imperative `ref.setOption(partial, opts)`: lets a caller (LiveView)
 *    push cheap partial series-data patches at high frequency without ever
 *    going through React's render cycle.
 */
const EChart = forwardRef(function EChart({ option, height = 480 }, ref) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const chart = echarts.init(containerRef.current);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (option) {
      chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true });
    }
  }, [option]);

  useImperativeHandle(
    ref,
    () => ({
      setOption: (partial, opts) => chartRef.current?.setOption(partial, opts),
    }),
    [],
  );

  return <div ref={containerRef} style={{ width: "100%", height }} />;
});

export default EChart;
