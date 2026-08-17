# diascript

A small, safe DSL for defining technical indicators as data, not code — chart-library-agnostic and data-source-agnostic by design. Early stage: architecture decided, implementation not started.

## Why

An indicator is a mathematical formula: windowed math over a price series (moving averages, stdev, highest/lowest), point-wise math (+ − × ÷, comparisons), a lookback (value N bars ago), and — for recursive indicators like RSI or ATR — a reference to the indicator's own previous value. A small, fixed set of primitives built from those pieces covers the vast majority of real indicators, without needing arbitrary code execution (no `eval`, no sandboxing arms race).

## Architecture

Three separable layers, each swappable independently:

1. **Data adapter** — a small interface (`getSeries(symbol, timeframe)`) that fetches OHLCV at a given resolution. Implement one against any backend; this is also how multi-timeframe reads stay clean — the engine asks the adapter for a different-resolution series, never fetches anything itself.
2. **Compute engine** — the actual DSL: parser + safe evaluator + primitives (`sma`, `ema`, `wma`, `stdev`, `highest`, `lowest`, `sum`, `ref`, `prev`, arithmetic, comparisons). Pure math, zero rendering knowledge, zero I/O.
3. **Render adapter** — one thin adapter per charting library, translating a small standard output vocabulary (`{type: "line", points}`, `{type: "band", upper, lower}`, `{type: "marker", points, shape, color}`, `{type: "histogram", points}`) into that library's actual draw calls. Swapping charting libraries never touches the compute engine.

TypeScript, runs client-side — same execution model Pine Script uses in TradingView. No Python interpreter planned; backtesting over historical data is a separate, already-solved problem (existing Python backtest engines), not something this project needs to duplicate.

## Status

Design phase. Primitive set, output vocabulary, and the first render adapter (klinecharts) are being worked out before implementation starts.

## License

MIT
