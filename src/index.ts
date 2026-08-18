export { parse, ParseError } from "./parser";
export { evaluate } from "./engine/engine";
export { InMemoryDataAdapter } from "./adapters/data/in-memory";
export type { OHLCV, DataAdapter, IndicatorOutput, EvaluationResult, Diagnostic } from "./engine/types";

// renderToKlinecharts is NOT re-exported here on purpose — this file is the
// core, chart-library-agnostic entry point. Importing anything from "diascript"
// must never force resolution of klinecharts for a consumer who doesn't use
// that specific adapter. Import it from "diascript/klinecharts" instead.
