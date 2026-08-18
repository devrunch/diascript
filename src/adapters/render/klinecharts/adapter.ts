import { registerIndicator, type Chart, type IndicatorTemplate, type KLineData } from "klinecharts";
import { parse } from "../../../parser.js";
import { evaluate } from "../../../engine/engine.js";
import { isOutputWrapper } from "../../../engine/outputs.js";
import { DataAdapter, IndicatorOutput } from "../../../engine/types.js";

/** klinecharts calls `calc` every time ITS OWN data changes (new bar, live
 * tick, panning to load more history) — passing the current `dataList` fresh
 * each time. An earlier version of this adapter took an already-computed
 * `IndicatorOutput` and closed over it in `calc`, which meant the indicator
 * would never update after its first render: a live tick or a newly-loaded
 * bar would never reach it. Fixed: `calc` now re-runs `evaluate()` against
 * whatever `dataList` klinecharts hands it, every time it's called —
 * `evaluate` being async is exactly what klinecharts' own `calc` signature
 * expects (`Promise<D[]> | D[]`), so no extra plumbing is needed for that.
 *
 * One diascript source can define several wrapped (rendered) formulas —
 * `outputName` picks which one this particular klinecharts indicator
 * registration renders; call this once per wrapped output you want visible. */
export interface KlinechartsIndicatorOptions {
  source: string;
  outputName: string;
  adapter: DataAdapter;
  symbolTicker: string;
  inputOverrides?: Record<string, number | string>;
}

function toOHLCV(dataList: KLineData[]) {
  return dataList.map(k => ({
    time: k.timestamp / 1000, // klinecharts uses millisecond timestamps; diascript uses seconds
    open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0,
  }));
}

function toMs(seconds: number): number {
  return seconds * 1000;
}

/** A given output's shape (line vs band vs marker vs...) is fixed by which
 * wrapper function decorates it in the source — determinable by inspecting
 * the parsed AST alone, no evaluation (no data, no async) required. This is
 * what lets `figures` be known synchronously, before the first `calc` ever
 * runs, instead of guessing and correcting later. */
function outputTypeOf(source: string, outputName: string): IndicatorOutput["type"] {
  const program = parse(source);
  const stmt = program.find(s => s.kind === "formula" && s.name === outputName);
  if (!stmt || stmt.kind !== "formula" || !isOutputWrapper(stmt.expr)) {
    throw new Error(`'${outputName}' is not a rendered (wrapped) formula in this diascript source`);
  }
  return stmt.expr.name as IndicatorOutput["type"];
}

function figuresFor(type: IndicatorOutput["type"]): IndicatorTemplate["figures"] {
  switch (type) {
    case "line": return [{ key: "value", title: "value", type: "line" }];
    case "histogram": return [{ key: "value", title: "value", type: "bar" }];
    case "band": return [
      { key: "upper", title: "upper", type: "line" },
      { key: "lower", title: "lower", type: "line" },
    ];
    case "marker": return [{ key: "shape", title: "shape", type: "circle" }];
    case "background": return [{ key: "color", title: "color", type: "rect" }];
    case "barcolor": case "fill":
      throw new Error(`Output type '${type}' is not yet supported by the klinecharts adapter`);
  }
}

function calcResultFor(output: IndicatorOutput): Record<string, unknown>[] {
  switch (output.type) {
    case "line": return output.points.map(p => ({ time: toMs(p.time), value: p.value }));
    case "histogram": return output.points.map(p => ({ time: toMs(p.time), value: p.value }));
    case "band": return output.upper.map((p, i) => ({ time: toMs(p.time), upper: p.value, lower: output.lower[i].value }));
    case "marker": return output.points.map(p => ({ time: toMs(p.time), shape: p.shape, color: p.color }));
    case "background": return output.points.map(p => ({ time: toMs(p.time), color: p.color }));
    case "barcolor": case "fill":
      throw new Error(`Output type '${output.type}' is not yet supported by the klinecharts adapter`);
  }
}

/** The reactive half of the adapter, pulled out as its own function so it's
 * directly testable — two different `dataList`s must produce different
 * results, which is the whole point of this adapter over the earlier
 * frozen-snapshot version, and klinecharts itself exposes no way to read a
 * registered indicator's `calc` back out for testing once it's been handed in. */
export function buildCalc(options: KlinechartsIndicatorOptions) {
  const { source, outputName, adapter, symbolTicker, inputOverrides } = options;
  return async (dataList: KLineData[]) => {
    const bars = toOHLCV(dataList);
    const result = await evaluate(source, bars, adapter, symbolTicker, inputOverrides);
    const output = result.outputs[outputName];
    return output ? calcResultFor(output) : [];
  };
}

/** Registers `name` as a real klinecharts indicator type, backed by a
 * diascript source. Call once per indicator name (not per chart) — like
 * klinecharts' own registerIndicator, this is a global type registration,
 * separate from attaching it to any particular chart instance. */
export function registerDiascriptIndicator(name: string, options: KlinechartsIndicatorOptions): void {
  const outputType = outputTypeOf(options.source, options.outputName);
  registerIndicator({
    name,
    figures: figuresFor(outputType),
    calc: buildCalc(options),
  });
}

/** Attaches a previously-registered diascript indicator to one chart
 * instance — the same two-step split klinecharts' own indicators use
 * (register the type once, createIndicator per chart that wants it). */
export function attachDiascriptIndicator(chart: Chart, name: string): void {
  chart.createIndicator(name);
}
