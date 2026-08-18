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
- `true_range()` — `max(high - low, abs(high - ref(close, 1)), abs(low - ref(close, 1)))`, except on the very first bar, where there is no previous close to compare against and the value is just `high - low` (the standard convention — found during implementation: routing the first-bar case through `ref(close, 1)`'s ordinary "insufficient history" `NaN` poisons the surrounding `max()`/`abs()` calls, since a `NaN` operand makes `max` return `NaN` regardless of the other arguments).
- `typical_price()` — `(high + low + close) / 3`
- `rsi(x, n)` — Wilder's RSI. Unlike the two above, this one is genuinely multi-step and recursive, not a one-liner — it's implemented internally as:
  ```
  change   = x - ref(x, 1)
  gain     = max(change, 0)
  loss     = max(-change, 0)
  avg_gain = prev(1) * (n-1)/n + gain/n
  avg_loss = prev(1) * (n-1)/n + loss/n
  rsi      = 100 - 100 / (1 + avg_gain/avg_loss)
  ```
  Shown here to prove it's expressible in the core grammar (an author COULD write this by hand), but shipped as one built-in call because re-deriving Wilder smoothing correctly every time it's needed is exactly the kind of trusted, host-implemented complexity that should live in the engine once, reviewed once, rather than in every formula author's own code.

**Held state (bounded stateful pattern tracking):**
- `held(condition, value)` — a memory cell that updates to `value` on any bar where `condition` is true, and otherwise carries forward whatever it held on the previous bar, indefinitely (not a fixed `n`-bar lookback like `prev`/`ref` — it can hold the same value for an unbounded number of bars until `condition` fires again). This is what "remember the last swing high until a new one forms" needs — `prev` only reaches back a fixed number of bars, but a swing high can persist for an arbitrary stretch:
  ```
  is_new_swing_high = high > highest(ref(high, 1), 5)
  swing_high = held(is_new_swing_high, high)
  ```
  Still bounded and safe: exactly one scalar of state per `held(...)` call site, no unbounded recursion, no arbitrary function calls — the state transition rule itself (`condition` → `value`, else carry forward) is fixed and can't be redefined by the formula author into something more general.

**Context (non-price):**
- `time.dayofweek()`, `time.hour()`, `time.minute()` — derived purely from the current bar's own `time` field (no adapter call — these are pure math over a timestamp already in hand).
- `session.is_open()` — whether the instrument's exchange session is open at this bar. Resolves through `DataAdapter.getSymbolMeta` (below) — an adapter that doesn't implement session knowledge simply has this always return `true`, degrading gracefully rather than erroring.
- `symbol.exchange()` — the current instrument's exchange (e.g. `"NSE"`), also via `getSymbolMeta`.
- `symbol.ticker()` — the current instrument's own symbol string. Exists specifically for the common "same instrument, different timeframe" pattern: `series(symbol.ticker(), "1d", "close")` reads the current symbol at daily resolution, without hardcoding a symbol name into the formula (matching Pine's `syminfo.tickerid` idiom).

  `DataAdapter` gains one more (optional) method for these two:
  ```ts
  interface DataAdapter {
    getSeries(symbol: string, timeframe: string): Promise<OHLCV[]>;
    getSymbolMeta?(symbol: string): Promise<{ exchange: string; sessionOpen(time: number): boolean }>;
  }
  ```

### Non-goals (deliberately excluded, not a gap to fill later)

- **No loops, no user-defined functions, no recursion beyond `prev`'s single-formula self-reference and `held`'s fixed carry-forward rule.** Both cover every real recursive/stateful indicator this project has evidence for needing (RSI, ATR, SuperTrend, Wilder's smoothing, swing-point tracking); a general recursive-function-call mechanism would reopen the unbounded-computation risk the whole point of a restricted grammar is meant to close.
- **No order placement, no strategy/backtest execution.** An indicator formula computes a value series. Anything that acts on that value (placing a trade, sizing a position) is a different system's job — this project has no `strategy.*` equivalent and none is planned. (The host application already has a separate system for this — a validated condition DSL for signal rules, and a paper-trading engine — deliberately kept separate.)
- **No arbitrary data structures.** No arrays/maps/matrices as a general facility — only the fixed OHLCV fields and named formula outputs. If a genuine need for a small fixed-size structure emerges (e.g. Ichimoku's five lines), it's modeled as multiple named formulas (as MACD is above), not a new data-structure primitive.

## Output vocabulary

The evaluator's result, and the only thing a render adapter ever consumes:

```ts
type IndicatorOutput =
  | { type: "line"; points: { time: number; value: number }[] }
  | { type: "band"; upper: { time: number; value: number }[]; lower: { time: number; value: number }[] }
  | { type: "marker"; points: { time: number; shape: string; color?: string }[] }
  | { type: "histogram"; points: { time: number; value: number }[] }
  | { type: "barcolor"; points: { time: number; color: string }[] }
  | { type: "background"; points: { time: number; color: string }[] }
  | { type: "fill"; between: [string, string]; color: string };
```

`barcolor(condition, colorIfTrue, colorIfFalse)` — recolors the actual candle/bar itself on bars where `condition` is true (Pine's `barcolor()`). `background(condition, color)` — shades the chart's background on bars where `condition` is true (Pine's `bgcolor()`). `fill(a, b, color)` — takes two already-declared `line`/`band` outputs (referenced the same way any earlier formula is referenced — a bare identifier, not a string) and fills the region between them (Pine's `fill()`); this is why outputs are named formulas rather than anonymous — `fill` just points at two of them instead of re-deriving the two series itself.

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

## Inputs (user-configurable parameters)

An indicator definition declares its own configurable parameters up front — a host application's settings panel reads this declaration to render the right control (a number field, a source-series picker, a color swatch) automatically, the same way Pine's `input.*` calls generate TradingView's settings dialog:

```
input length = int(14, min=2, max=200)
input source = source(close)
input band_color = color("#2196F3")

rsi_line = line(rsi(input.length, input.source))
bb_bands = band(input.source + 2*stdev(input.source, 20), input.source - 2*stdev(input.source, 20), color=input.band_color)
```

Four input types, matching the four things an indicator commonly needs configured: `int(default, min, max)`, `float(default, min, max)`, `source(default)` (picks among `open`/`high`/`low`/`close`/`volume` or another named formula), `color(default)`. Every input has a required default and (for `int`/`float`) required bounds — this is the same "no unbounded value" discipline the condition DSL's `PARAM_BOUNDS` already established for signal-rule parameters, applied here to indicator parameters instead. Referenced inside the formula body as `input.<name>`.

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

## Debugging & diagnostics

Rendering and inspection are deliberately separate surfaces. `line()`/`band()`/etc. control what's VISIBLE on a chart; they say nothing about what's INSPECTABLE. Evaluating a script returns both:

```ts
interface EvaluationResult {
  outputs: Record<string, IndicatorOutput>;      // only wrapped formulas — the render surface
  values: Record<string, (number | boolean)[]>;  // every named formula, wrapped or not
  diagnostics: Diagnostic[];
}
```

`values` contains every formula in the file, by name, as a plain array aligned to the bar history — `uptrend`, `entry_long`, any bare intermediate — regardless of whether it was ever wrapped in an output function. The evaluator computes all of these internally anyway (wrapped formulas are the exception, not the rule, in most real scripts); exposing them costs nothing extra and means debugging *any* named value never requires editing the script to temporarily wrap it. This matters most for an AI agent authoring or fixing a script: it can evaluate once and inspect every intermediate by name, the same way it wrote the formula, rather than needing a separate "make this visible first" step.

Evaluation-time degradations (division by zero, insufficient history for a lookback, a `series()` call the adapter couldn't resolve, a missing `getSymbolMeta` defaulting `session.is_open()` to `true`) still degrade to `null`/`NaN` per point — never abort the computation — but each ALSO records a `Diagnostic`:

```ts
interface Diagnostic {
  formula: string;       // which named formula this is about
  message: string;       // human/agent-readable explanation
  severity: "warning";   // nothing here ever aborts evaluation
  count: number;         // how many bars this occurred on
  firstBarIndex: number;
  lastBarIndex: number;
}
```

One entry per distinct `(formula, reason)` pair, aggregated with a count — not one entry per bar. History can be thousands of bars long; a single bad symbol shouldn't produce thousands of identical diagnostics. This is the same bounded-by-construction discipline the rest of the grammar already follows, applied to the diagnostics list itself.

## Testing

- Golden-value tests: known indicators (RSI, EMA, MACD) computed in `diascript` against a fixed OHLCV fixture, compared to values from an established reference (e.g. `pandas_ta`'s output on the same fixture) within a small tolerance.
- Grammar tests: every rejected-input case (unknown function, wrong arity, disallowed syntax) has a test asserting it's rejected at parse time, not evaluation time.
- `prev`/recursive-indicator tests: confirm bar-order evaluation guarantee (bar N never computed before bar N-1 for a `prev`-using formula) and confirm a stateful indicator (e.g. Wilder's ATR) matches its known reference values over a real fixture.
- `held()` tests: a value set once persists across many subsequent bars where the condition is false, and updates the instant the condition is true again — including a fixture long enough to prove it isn't secretly bounded to some fixed lookback.
- Context primitive tests: `time.dayofweek/hour/minute` against known timestamps; `session.is_open`/`symbol.exchange` both against a real `getSymbolMeta` implementation and against an adapter that omits it (must degrade to `true`/empty rather than error).
- Input tests: bounds enforcement (`int`/`float` reject a value outside `min`/`max` at parse/construction time, not silently clamp or ignore), and a `source` input correctly rebinding a formula to a different series when the host changes it.
- New output-type tests: `barcolor`/`background`/`fill` each produce the documented shape from a small fixture formula, and the klinecharts adapter maps each to the correct API call.
- Render adapter tests: given a fixed `IndicatorOutput`, assert the klinecharts adapter calls the expected `klinecharts` API with the expected shape (mocked, not a real chart instance).
- Diagnostics tests: a formula that degrades on many bars (e.g. a lookback exceeding available history for the first N bars) produces exactly ONE aggregated `Diagnostic` with the correct `count`/`firstBarIndex`/`lastBarIndex`, not one entry per bar. `values` contains an unwrapped intermediate formula's full series even when `outputs` is empty for it.

## Out of scope for v1 (explicitly deferred, not abandoned)

- A Python interpreter for the same grammar (for backtesting/ML feature use) — the host application already has its own Python backtest engine; duplicating this grammar into a second interpreter is a later, separate project once there's a concrete need neither existing tool covers.
- A visual/no-code authoring UI for the grammar — v1 is the language + engine + one render adapter; an editor experience is a consumer's job, not this library's.
