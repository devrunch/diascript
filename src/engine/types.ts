import type { ASTNode } from "../ast";

export interface OHLCV {
  time: number;
  open: number; high: number; low: number; close: number; volume: number;
}

export interface Diagnostic {
  formula: string;
  message: string;
  severity: "warning";
  count: number;
  firstBarIndex: number;
  lastBarIndex: number;
}

export interface DataAdapter {
  getSeries(symbol: string, timeframe: string): Promise<OHLCV[]>;
  getSymbolMeta?(symbol: string): Promise<{ exchange: string; sessionOpen(time: number): boolean }>;
}

export type IndicatorOutput =
  | { type: "line"; points: { time: number; value: number }[] }
  | { type: "band"; upper: { time: number; value: number }[]; lower: { time: number; value: number }[]; color?: string }
  | { type: "marker"; points: { time: number; shape: string; color?: string }[] }
  | { type: "histogram"; points: { time: number; value: number }[] }
  | { type: "barcolor"; points: { time: number; color: string }[] }
  | { type: "background"; points: { time: number; color: string }[] }
  | { type: "fill"; between: [string, string]; color: string };

export interface EvaluationResult {
  outputs: Record<string, IndicatorOutput>;
  values: Record<string, (number | boolean)[]>;
  diagnostics: Diagnostic[];
}

/** Everything one formula's per-bar evaluation needs. `self` grows as bars are
 * evaluated — safe for prev()/held() to read indices behind the current one. */
export interface EvalContext {
  bars: OHLCV[];
  completed: Map<string, (number | boolean)[]>;
  self: (number | boolean)[];
  currentFormula: string;
  inputs: Record<string, number | string>;
  /** Pre-resolved, forward-filled to `bars.length` — populated once upfront by Task 10, empty otherwise. */
  externalSeries: Map<string, number[]>;
  sessionOpen?: (time: number) => boolean;
  exchange?: string;
  symbolTicker: string;
  /** barIndex is the bar this diagnostic occurred at — required so the
   * aggregator (Task 12) can track first/lastBarIndex correctly; without it
   * there's no way to know which bar a deeply-nested call happened on. */
  pushDiagnostic: (message: string, barIndex: number) => void;
  /** Memoizes a windowed function's inner-argument series by AST node
   * identity — without this, every windowed call recomputed its whole inner
   * series from scratch on every bar (O(bars) work times O(bars) calls =
   * O(bars^2) per call site), which gets genuinely too slow past a few
   * thousand bars. Lazily created; a fresh Map per formula (engine.ts builds
   * a new EvalContext per formula), so no cross-formula staleness risk. */
  _windowCache?: Map<ASTNode, number[]>;
  /** Same purpose as _windowCache, for rsi()'s two internal recursive
   * accumulators — kept on ctx rather than a module-level WeakMap so all
   * per-evaluation memoization lives in one consistent place. */
  _rsiCache?: Map<ASTNode, { avgGain: number[]; avgLoss: number[] }>;
}
