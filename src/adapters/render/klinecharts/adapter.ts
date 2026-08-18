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
      // Confirmed via the real klinecharts types: candle coloring is a
      // global up/down compare-rule (CandleBarColor: compareRule/upColor/
      // downColor), set once via chart.setStyles — there's no per-bar,
      // arbitrary-condition recolor hook the way an indicator figure has.
      // Not a research gap — genuinely no matching primitive exists.
      throw new Error(`Output type '${output.type}' is not yet supported by the klinecharts adapter`);
    case "fill":
      // `type: "polygon"` figures and a custom draw callback (real API:
      // IndicatorDrawCallback gets ctx/xAxis/yAxis with real
      // convertToPixel(value) methods) COULD draw this. The real blocker:
      // fill's output only carries `between: [name, name]` — the actual
      // point data for those two other outputs isn't available here, since
      // this function renders one output at a time. Drawing it needs
      // either a second `allOutputs` parameter or a different entry point
      // that sees every output for a script at once — a signature change,
      // not a missing figure type. Left unsupported rather than shipping
      // an unverified custom-canvas drawing on top of an incomplete signature.
      throw new Error(`Output type '${output.type}' is not yet supported by the klinecharts adapter`);
  }
}
