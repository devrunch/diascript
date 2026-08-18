import { IndicatorOutput } from "../../../engine/types";

/** Structural subset of klinecharts' real Chart type — avoids a hard
 * dependency on the klinecharts package for this file alone. */
export interface KLineChartLike {
  registerIndicator(config: Record<string, unknown>): void;
}

export function renderToKlinecharts(chart: KLineChartLike, name: string, output: IndicatorOutput): void {
  switch (output.type) {
    case "line":
      chart.registerIndicator({
        name,
        figures: [{ key: "value", title: name, type: "line" }],
        calc: () => output.points.map(p => ({ time: p.time, value: p.value })),
      });
      return;
    case "band":
      chart.registerIndicator({
        name,
        figures: [
          { key: "upper", title: `${name}_upper`, type: "line" },
          { key: "lower", title: `${name}_lower`, type: "line" },
        ],
        calc: () => output.upper.map((p, i) => ({ time: p.time, upper: p.value, lower: output.lower[i].value })),
      });
      return;
    case "histogram":
      chart.registerIndicator({
        name,
        figures: [{ key: "value", title: name, type: "bar" }],
        calc: () => output.points.map(p => ({ time: p.time, value: p.value })),
      });
      return;
    case "marker":
      chart.registerIndicator({
        name,
        figures: [{ key: "shape", title: name, type: "shape" }],
        calc: () => output.points.map(p => ({ time: p.time, shape: p.shape, color: p.color })),
      });
      return;
    case "background":
      chart.registerIndicator({
        name,
        figures: [{ key: "color", title: name, type: "background" }],
        calc: () => output.points.map(p => ({ time: p.time, color: p.color })),
      });
      return;
    case "barcolor":
    case "fill":
      throw new Error(`Output type '${output.type}' is not yet supported by the klinecharts adapter`);
  }
}
