# diascript — Design Spec

## Goal

A small, safe language for defining technical indicators as data, not code — so anyone (a user, an AI agent, this library's own author) can describe a new indicator without writing a function in the host language, and without ever running arbitrary code. Chart-library-agnostic and data-source-agnostic: the language itself never imports a charting library or a data-fetching mechanism.

## Why not just let people write JS/Python

The obvious implementation — let the user submit a function, `eval` or `Function()` it — is remote code execution. One malicious or hallucinated (if an AI agent is authoring indicators) script reaches whatever the host page/process can reach. A fixed, small grammar with a whitelisted set of operations makes that class of bug structurally impossible: there is no path from "indicator definition" to "arbitrary code runs," because the parser rejects anything outside the grammar before the evaluator ever sees it.

## Architecture

Three layers, each independently swappable and independently testable:

```
Data adapter  ──▶  Compute engine  ──▶  Render adapter
(fetch OHLCV)      (parse + evaluate)   (draw to a chart library)
```

### 1. Data adapter

An interface, not an implementation:

```ts
interface DataAdapter {
  getSeries(symbol: string, timeframe: string): Promise<OHLCV[]>;
}

interface OHLCV {
  time: number;   // unix seconds, bar close time
  open: number; high: number; low: number; close: number; volume: number;
}
```

The compute engine is constructed with one `DataAdapter`. It never fetches anything itself — every reference to `close`, `high`, etc. in a formula resolves against the *current* series (the one the indicator is attached to); a `series(symbol, timeframe, field)` primitive resolves through the SAME adapter for a different resolution/symbol, keeping multi-timeframe reads and single-timeframe reads identical from the engine's point of view. Anyone embedding `diascript` writes one small adapter against their own backend (a REST call, a local array, a WebSocket cache) — the engine doesn't care.

### 2. Compute engine

Two parts:

- **Parser** — turns a textual formula into an AST. Grammar is fixed and small (below); anything outside it is a parse error, not a runtime error, so invalid input never reaches evaluation.
- **Evaluator** — walks the AST and produces one or more output series. Pure function of (AST, OHLCV history, previously-computed values of this same indicator) — no I/O, no side effects, no access to anything not explicitly passed in.

### 3. Render adapter

A thin translation layer, one per charting library, mapping the engine's output vocabulary (below) to that library's actual draw calls. `diascript` ships a reference adapter for `klinecharts` (via its `registerIndicator`/custom-figure API); anyone else's chart library gets its own adapter, written against the same output vocabulary — the engine's output never changes based on which adapter consumes it.

## Grammar

Author-facing syntax (parsed, not eval'd):

```
rsi_veto = rsi(close, 14) < 30 or rsi(close, 14) > 70
macd_line = ema(close, 12) - ema(close, 26)
signal_line = ema(macd_line, 9)
atr_ema = ema(true_range(), 14)
custom_ma_diff = sma(close, 10) - sma(close, 50)
```

One formula per line, `name = expression`. A later line may reference an earlier line's name within the same definition (as `signal_line` references `macd_line` above) — this is how multi-output indicators like MACD (line + signal + histogram) are expressed as three related formulas, not one. A line that's only an intermediate helper (referenced by a later line, never rendered) is written bare, as above; a line meant to actually appear on the chart must be wrapped in one of the four output-shape functions (`line`/`band`/`marker`/`histogram`, defined below) — the wrapper is what tells the engine "this one is a real output," everything unwrapped is just working state.

### Primitives

**Series references** (resolve against the current instrument/timeframe unless wrapped in `series(...)`):
`open`, `high`, `low`, `close`, `volume`

**Windowed functions** — take a series expression and a length:
`sma(x, n)`, `ema(x, n)`, `wma(x, n)`, `stdev(x, n)`, `highest(x, n)`, `lowest(x, n)`, `sum(x, n)`

**Point-wise math:**
`+ - * /`, `abs(x)`, `min(a, b)`, `max(a, b)`

**Comparisons and logic** (produce a 0/1 series):
`> < >= <= == !=`, `and`, `or`, `not`

**Time references:**
- `ref(x, n)` — the value of expression `x`, `n` bars back. Works on any series, including raw price and other formulas.
- `prev(n)` (bare, no argument other than the lookback) — this formula's OWN previously-computed value, `n` bars back. This is what makes recursive indicators (RSI's Wilder smoothing, ATR, SuperTrend) expressible: `atr_smoothed = prev(1) * 13/14 + true_range() / 14` is a valid, self-referencing definition, evaluated bar-by-bar left to right (the engine guarantees this evaluation order — never evaluates bar N before bar N-1 for a formula that uses `prev`).

**Cross-resolution:**
- `series(symbol, timeframe, field)` — resolves through the `DataAdapter`, returns a series usable anywhere another series would be (so `sma(series("NIFTY 50", "1d", "close"), 20)` computes a daily-resolution SMA usable inside an indicator attached to a 5-minute chart).

**Built-in derived series** (thin wrappers over the primitives above, provided because they're common enough to name):
- `true_range()` — `max(high - low, abs(high - ref(close, 1)), abs(low - ref(close, 1)))`
- `typical_price()` — `(high + low + close) / 3`

### Non-goals (deliberately excluded, not a gap to fill later)

- **No loops, no user-defined functions, no recursion beyond `prev`'s single-formula self-reference.** `prev` covers every real recursive indicator this project has evidence for needing (RSI, ATR, SuperTrend, Wilder's smoothing family); a general recursive-function-call mechanism would reopen the unbounded-computation risk the whole point of a restricted grammar is meant to close.
- **No order placement, no strategy/backtest execution.** An indicator formula computes a value series. Anything that acts on that value (placing a trade, sizing a position) is a different system's job — this project has no `strategy.*` equivalent and none is planned. (The host application already has a separate system for this — a validated condition DSL for signal rules, and a paper-trading engine — deliberately kept separate.)
- **No arbitrary data structures.** No arrays/maps/matrices as a general facility — only the fixed OHLCV fields and named formula outputs. If a genuine need for a small fixed-size structure emerges (e.g. Ichimoku's five lines), it's modeled as multiple named formulas (as MACD is above), not a new data-structure primitive.

## Output vocabulary

The evaluator's result, and the only thing a render adapter ever consumes:

```ts
type IndicatorOutput =
  | { type: "line"; points: { time: number; value: number }[] }
  | { type: "band"; upper: { time: number; value: number }[]; lower: { time: number; value: number }[] }
  | { type: "marker"; points: { time: number; shape: string; color?: string }[] }
  | { type: "histogram"; points: { time: number; value: number }[] };
```

A top-level formula declares its own output shape explicitly, via one of four wrapper functions — no inference, no ambiguity about which of the four shapes a given formula produces:

```
rsi_line = line(rsi(close, 14))
bb_bands = band(sma(close, 20) + 2*stdev(close, 20), sma(close, 20) - 2*stdev(close, 20))
overbought_marker = marker(rsi(close, 14) > 70, "triangle-down", "red")

macd_raw = ema(close, 12) - ema(close, 26)
signal_raw = ema(macd_raw, 9)
macd_line = line(macd_raw)
signal_line = line(signal_raw)
macd_hist = histogram(macd_raw - signal_raw)
```

`line(x)` wraps any numeric series. `band(upper, lower)` takes two numeric series. `marker(condition, shape, color)` takes a boolean series (only points where it's true get a marker) plus a fixed shape/color. `histogram(x)` wraps any numeric series. The MACD example shows the full pattern: bare intermediate formulas (`macd_raw`, `signal_raw`) hold working state, and three wrapped top-level formulas declare what actually renders — each independently, with its own shape.

## Package layout

```
src/
  parser/     tokenizer, AST builder, grammar-level validation
  engine/     evaluator, primitive implementations, prev/ref bar-order guarantee
  adapters/
    data/     DataAdapter interface + a reference in-memory implementation (for tests, examples)
    render/
      klinecharts/   first render adapter
  spec/       formal grammar reference, worked examples (RSI, MACD, SuperTrend written in diascript, used as both documentation and golden-output tests)
```

## Error handling

Two failure classes, handled differently:

- **Parse-time errors** (unknown function name, wrong arity, malformed syntax) — rejected before any evaluation happens, with a message pointing at the offending token. This is the primary safety boundary: nothing outside the grammar ever reaches the evaluator.
- **Evaluation-time errors** (division by zero, insufficient history for a lookback at the start of a series) — degrade to `null`/`NaN` for that point rather than throwing and aborting the whole series computation, mirroring how a real chart shows "no data yet" for the first N bars of a moving average rather than erroring the whole chart.

## Testing

- Golden-value tests: known indicators (RSI, EMA, MACD) computed in `diascript` against a fixed OHLCV fixture, compared to values from an established reference (e.g. `pandas_ta`'s output on the same fixture) within a small tolerance.
- Grammar tests: every rejected-input case (unknown function, wrong arity, disallowed syntax) has a test asserting it's rejected at parse time, not evaluation time.
- `prev`/recursive-indicator tests: confirm bar-order evaluation guarantee (bar N never computed before bar N-1 for a `prev`-using formula) and confirm a stateful indicator (e.g. Wilder's ATR) matches its known reference values over a real fixture.
- Render adapter tests: given a fixed `IndicatorOutput`, assert the klinecharts adapter calls the expected `klinecharts` API with the expected shape (mocked, not a real chart instance).

## Out of scope for v1 (explicitly deferred, not abandoned)

- A Python interpreter for the same grammar (for backtesting/ML feature use) — the host application already has its own Python backtest engine; duplicating this grammar into a second interpreter is a later, separate project once there's a concrete need neither existing tool covers.
- A visual/no-code authoring UI for the grammar — v1 is the language + engine + one render adapter; an editor experience is a consumer's job, not this library's.
