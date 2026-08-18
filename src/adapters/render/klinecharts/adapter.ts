import { registerIndicator, type Chart, type IndicatorTemplate } from "klinecharts";
import { IndicatorOutput } from "../../../engine/types";

/** klinecharts' real shape: `registerIndicator` is a MODULE-LEVEL function
 * that defines an indicator TYPE once (not a chart method) — a separate
 * `chart.createIndicator(name)` call then attaches a registered type to one
 * specific chart. The earlier version of this adapter assumed both steps
 * were one `chart.registerIndicator(config)` call, which doesn't exist on
 * the real Chart type at all — found by installing klinecharts for real and
 * reading its actual .d.ts rather than continuing to trust the guess. */
export function renderToKlinecharts(chart: Chart, name: string, output: IndicatorOutput): void {
  const template = buildTemplate(name, output);
  registerIndicator(template);
  chart.createIndicator(name);
}

function buildTemplate(name: string, output: IndicatorOutput): IndicatorTemplate {
  switch (output.type) {
    case "line":
      return {
        name,
        figures: [{ key: "value", title: name, type: "line" }],
        calc: () => output.points.map(p => ({ time: p.time, value: p.value })),
      };
    case "band":
      return {
        name,
        figures: [
          { key: "upper", title: `${name}_upper`, type: "line" },
          { key: "lower", title: `${name}_lower`, type: "line" },
        ],
        calc: () => output.upper.map((p, i) => ({ time: p.time, upper: p.value, lower: output.lower[i].value })),
      };
    case "histogram":
      return {
        name,
        figures: [{ key: "value", title: name, type: "bar" }],
        calc: () => output.points.map(p => ({ time: p.time, value: p.value })),
      };
    case "marker":
      return {
        name,
        figures: [{ key: "shape", title: name, type: "circle" }],
        calc: () => output.points.map(p => ({ time: p.time, shape: p.shape, color: p.color })),
      };
    case "background":
      return {
        name,
        figures: [{ key: "color", title: name, type: "rect" }],
        calc: () => output.points.map(p => ({ time: p.time, color: p.color })),
      };
    case "barcolor":
    case "fill":
      // klinecharts has no confirmed built-in figure type for recoloring
      // the candle itself or filling between two series — real gap, not
      // yet closed, rather than a guessed figure `type` string shipped
      // without verifying it actually renders anything.
      throw new Error(`Output type '${output.type}' is not yet supported by the klinecharts adapter`);
  }
}
