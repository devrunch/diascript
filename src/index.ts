export { parse, ParseError } from "./parser.js";
export { evaluate } from "./engine/engine.js";
export { InMemoryDataAdapter } from "./adapters/data/in-memory.js";
export type { OHLCV, DataAdapter, IndicatorOutput, EvaluationResult, Diagnostic } from "./engine/types.js";

// registerDiascriptIndicator/attachDiascriptIndicator are NOT re-exported here
// on purpose — this file is the core, chart-library-agnostic entry point.
// Importing anything from "diascript" must never force resolution of
// klinecharts for a consumer who doesn't use that specific adapter. Import
// them from "diascript/klinecharts" instead.
