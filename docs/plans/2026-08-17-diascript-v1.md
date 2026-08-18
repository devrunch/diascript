# diascript v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working TypeScript library — parse a diascript formula file, evaluate it against real OHLCV history, and render the result through a klinecharts adapter — matching the design spec exactly.

**Architecture:** Tokenizer → recursive-descent parser → AST. A single per-bar recursive evaluator (`evaluateNodeAt(node, i, ctx)`) computes every formula bar-by-bar, 0 to last — this one evaluation model covers ordinary math, windowed functions, and the self-referencing `prev`/`held` primitives without needing separate code paths. Cross-resolution (`series()`) and symbol metadata (`session.*`/`symbol.*`) are resolved ONCE upfront via the async `DataAdapter`, then forward-filled into plain arrays the same length as the primary bar series — so the synchronous per-bar evaluator never awaits anything.

**Tech Stack:** TypeScript, Vitest, no runtime dependencies (parser and evaluator are hand-written, no parser-generator library, no math library).

**Spec:** `docs/specs/2026-08-17-diascript-design.md`, `docs/grammar.md`

## Global Constraints

- Every valid program must be provably `O(bars)` — no primitive may loop an unbounded number of times. `prev`/`ref` read at most `n` bars back (bounded by history length); `held` does exactly one check per bar; windowed functions' cost is their literal window length.
- No `eval`, no `Function()`, no dynamic code execution anywhere in the parser or evaluator.
- Reserved words (the full list in `docs/grammar.md`) can never be used as a formula or input name — enforced at parse time.
- No forward references — a formula may only reference a name declared earlier in the same file — enforced at parse time.
- `values` in `EvaluationResult` contains every named formula (wrapped or not); `outputs` contains only wrapped ones. Both are populated by every `evaluate()` call — there's no separate "debug mode."
- Diagnostics are aggregated per `(formula, message)` pair with a count, never one entry per bar.
- No comments narrating what bug something fixes — comments state non-obvious WHY only.

---

### Task 1: Project setup — AST types and tokenizer

**Files:**
- Create: `src/ast.ts`
- Create: `src/tokenizer.ts`
- Test: `src/tokenizer.test.ts`

**Interfaces:**
- Produces: `Token`, `TokenKind`, `tokenize(source: string): Token[]` — consumed by Task 2's parser.

- [x] **Step 1: Write the AST types**

```typescript
// src/ast.ts
export type ASTNode =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; name: string }
  | { kind: "namespaced"; namespace: string; member: string }
  | { kind: "call"; name: string; args: ASTNode[]; namedArgs: Record<string, ASTNode> }
  | { kind: "binary"; op: string; left: ASTNode; right: ASTNode }
  | { kind: "unary"; op: string; operand: ASTNode };

export type InputType = "int" | "float" | "source" | "color";

export interface InputDecl {
  kind: "input";
  name: string;
  type: InputType;
  defaultValue: number | string;
  min?: number;
  max?: number;
}

export interface FormulaDecl {
  kind: "formula";
  name: string;
  expr: ASTNode;
}

export type Statement = InputDecl | FormulaDecl;
export type Program = Statement[];
```

- [x] **Step 2: Write the failing tokenizer tests**

```typescript
// src/tokenizer.test.ts
import { describe, it, expect } from "vitest";
import { tokenize } from "./tokenizer";

describe("tokenize", () => {
  it("tokenizes numbers, identifiers, and operators", () => {
    const tokens = tokenize("fast_ema = ema(close, 20) - 2.5");
    expect(tokens.map(t => t.kind)).toEqual([
      "ident", "eq", "ident", "lparen", "ident", "comma", "number", "rparen",
      "minus", "number", "eof",
    ]);
  });

  it("tokenizes strings", () => {
    const tokens = tokenize('color("#2196F3")');
    expect(tokens[2]).toMatchObject({ kind: "string", value: "#2196F3" });
  });

  it("tokenizes dotted namespace access", () => {
    const tokens = tokenize("input.length");
    expect(tokens.map(t => t.kind)).toEqual(["ident", "dot", "ident", "eof"]);
  });

  it("tokenizes keywords distinctly from identifiers", () => {
    const tokens = tokenize("a and b or not c");
    expect(tokens.map(t => t.kind)).toEqual([
      "ident", "and", "ident", "or", "not", "ident", "eof",
    ]);
  });

  it("tokenizes all comparison and arithmetic operators", () => {
    const tokens = tokenize("a >= b <= c == d != e");
    expect(tokens.map(t => t.kind)).toEqual([
      "ident", "gte", "ident", "lte", "ident", "eq2", "ident", "neq", "ident", "eof",
    ]);
  });

  it("strips comments to end of line", () => {
    const tokens = tokenize("a = 1 # this is a comment\nb = 2");
    expect(tokens.map(t => t.kind)).toEqual(["ident", "eq", "number", "ident", "eq", "number", "eof"]);
  });

  it("reports the line and column of each token", () => {
    const tokens = tokenize("a = 1\nb = 2");
    expect(tokens[3]).toMatchObject({ kind: "ident", value: "b", line: 2, col: 1 });
  });

  it("throws with position info on an unrecognized character", () => {
    expect(() => tokenize("a = @")).toThrow(/line 1/);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npm test -- tokenizer`
Expected: FAIL — `Cannot find module './tokenizer'`

- [x] **Step 4: Write the tokenizer**

```typescript
// src/tokenizer.ts
export type TokenKind =
  | "number" | "string" | "ident"
  | "eq" | "eq2" | "neq" | "lt" | "gt" | "lte" | "gte"
  | "plus" | "minus" | "star" | "slash"
  | "lparen" | "rparen" | "comma" | "dot"
  | "and" | "or" | "not"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set(["and", "or", "not"]);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") { line++; col = 1; } else { col++; }
      i++;
    }
  };
  const push = (kind: TokenKind, value: string, startLine: number, startCol: number) =>
    tokens.push({ kind, value, line: startLine, col: startCol });

  while (i < source.length) {
    const ch = source[i];
    const startLine = line, startCol = col;

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { advance(); continue; }
    if (ch === "#") { while (i < source.length && source[i] !== "\n") advance(); continue; }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j++;
      const text = source.slice(i, j);
      advance(j - i);
      push("number", text, startLine, startCol);
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j++;
      const text = source.slice(i + 1, j);
      advance(j - i + 1);
      push("string", text, startLine, startCol);
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[a-zA-Z0-9_]/.test(source[j])) j++;
      const text = source.slice(i, j);
      advance(j - i);
      if (KEYWORDS.has(text)) push(text as TokenKind, text, startLine, startCol);
      else push("ident", text, startLine, startCol);
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === ">=") { advance(2); push("gte", two, startLine, startCol); continue; }
    if (two === "<=") { advance(2); push("lte", two, startLine, startCol); continue; }
    if (two === "==") { advance(2); push("eq2", two, startLine, startCol); continue; }
    if (two === "!=") { advance(2); push("neq", two, startLine, startCol); continue; }

    const single: Record<string, TokenKind> = {
      "=": "eq", "<": "lt", ">": "gt", "+": "plus", "-": "minus",
      "*": "star", "/": "slash", "(": "lparen", ")": "rparen",
      ",": "comma", ".": "dot",
    };
    if (single[ch]) { advance(); push(single[ch], ch, startLine, startCol); continue; }

    throw new Error(`Unexpected character '${ch}' at line ${startLine}, col ${startCol}`);
  }

  tokens.push({ kind: "eof", value: "", line, col });
  return tokens;
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- tokenizer`
Expected: PASS — 8 tests

- [x] **Step 6: Commit**

```bash
git add src/ast.ts src/tokenizer.ts src/tokenizer.test.ts
git commit -m "feat: AST types and tokenizer"
```

---

### Task 2: Parser

**Files:**
- Create: `src/parser.ts`
- Test: `src/parser.test.ts`

**Interfaces:**
- Consumes: `Token`, `tokenize` from Task 1
- Produces: `parse(source: string): Program`, `ParseError` (thrown, carries `line`/`col`/`message`) — consumed by Task 3's evaluator and every later task's tests.

**Reserved words** (from `docs/grammar.md` — copy exactly): `input`, `and`, `or`, `not`, `open`, `high`, `low`, `close`, `volume`, `sma`, `ema`, `wma`, `stdev`, `highest`, `lowest`, `sum`, `abs`, `min`, `max`, `ref`, `prev`, `held`, `series`, `true_range`, `typical_price`, `rsi`, `line`, `band`, `marker`, `histogram`, `barcolor`, `background`, `fill`, `time`, `session`, `symbol`, `int`, `float`, `source`, `color`.

**Function arities** (for arity validation — reject wrong argument count at parse time): `sma`/`ema`/`wma`/`stdev`/`highest`/`lowest`/`sum` = 2, `abs` = 1, `min`/`max` = 2, `ref` = 2, `prev` = 1, `held` = 2, `series` = 3, `true_range`/`typical_price` = 0, `rsi` = 2, `line`/`histogram` = 1, `band` = 2 (+ optional named `color`), `marker` = 3, `barcolor` = 3, `background` = 2 (+ optional named `color`... actually `background(condition, color)` is 2 positional, no named form), `fill` = 2 (+ optional named `color`, but per spec `fill(a, b, color)` — treat the third as a required positional `color`, matching `marker`/`barcolor`'s style, not a named optional — use exactly 3 positional args for `fill`).

- [x] **Step 1: Write the failing parser tests**

```typescript
// src/parser.test.ts
import { describe, it, expect } from "vitest";
import { parse, ParseError } from "./parser";

describe("parse", () => {
  it("parses a simple formula", () => {
    const program = parse("x = close");
    expect(program).toEqual([{ kind: "formula", name: "x", expr: { kind: "ident", name: "close" } }]);
  });

  it("parses arithmetic with correct precedence", () => {
    const program = parse("x = 2 + 3 * 4");
    const [{ expr }] = program as any;
    expect(expr).toEqual({
      kind: "binary", op: "+",
      left: { kind: "number", value: 2 },
      right: { kind: "binary", op: "*", left: { kind: "number", value: 3 }, right: { kind: "number", value: 4 } },
    });
  });

  it("parses a function call", () => {
    const program = parse("x = sma(close, 20)");
    const [{ expr }] = program as any;
    expect(expr).toEqual({
      kind: "call", name: "sma",
      args: [{ kind: "ident", name: "close" }, { kind: "number", value: 20 }],
      namedArgs: {},
    });
  });

  it("parses a named argument", () => {
    const program = parse('x = band(1, 2, color=input.c)');
    const [{ expr }] = program as any;
    expect(expr.namedArgs).toEqual({ color: { kind: "namespaced", namespace: "input", member: "c" } });
  });

  it("parses an input declaration", () => {
    const program = parse("input length = int(14, min=2, max=200)");
    expect(program).toEqual([{ kind: "input", name: "length", type: "int", defaultValue: 14, min: 2, max: 200 }]);
  });

  it("allows a later formula to reference an earlier one", () => {
    const program = parse("a = close\nb = a + 1");
    expect(program).toHaveLength(2);
  });

  it("rejects a forward reference", () => {
    expect(() => parse("a = b\nb = close")).toThrow(ParseError);
  });

  it("rejects redeclaring a reserved word as a formula name", () => {
    expect(() => parse("sma = close")).toThrow(ParseError);
  });

  it("rejects an unknown function name", () => {
    expect(() => parse("x = notarealfunction(close)")).toThrow(ParseError);
  });

  it("rejects a function called with the wrong number of arguments", () => {
    expect(() => parse("x = sma(close)")).toThrow(ParseError);
  });

  it("parses and/or/not with correct precedence (and binds tighter than or)", () => {
    // Uses real series refs, not bare undeclared names -- would trip no-forward-ref
    const program = parse("x = open and high or low");
    const [{ expr }] = program as any;
    expect(expr).toEqual({
      kind: "binary", op: "or",
      left: { kind: "binary", op: "and", left: { kind: "ident", name: "open" }, right: { kind: "ident", name: "high" } },
      right: { kind: "ident", name: "low" },
    });
  });

  it("parses a comparison", () => {
    const program = parse("x = close > 100");
    const [{ expr }] = program as any;
    expect(expr).toEqual({ kind: "binary", op: ">", left: { kind: "ident", name: "close" }, right: { kind: "number", value: 100 } });
  });

  it("parses parenthesized expressions", () => {
    const program = parse("x = (2 + 3) * 4");
    const [{ expr }] = program as any;
    expect((expr as any).left).toEqual({ kind: "binary", op: "+", left: { kind: "number", value: 2 }, right: { kind: "number", value: 3 } });
  });

  it("throws ParseError with line/col on a syntax error", () => {
    try {
      parse("x = +");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(1);
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- parser`
Expected: FAIL — `Cannot find module './parser'`

- [x] **Step 3: Write the parser**

```typescript
// src/parser.ts
import { tokenize, Token, TokenKind } from "./tokenizer";
import { ASTNode, Program, Statement, InputType } from "./ast";

export class ParseError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(`${message} (line ${line}, col ${col})`);
  }
}

const RESERVED = new Set([
  "input", "and", "or", "not",
  "open", "high", "low", "close", "volume",
  "sma", "ema", "wma", "stdev", "highest", "lowest", "sum",
  "abs", "min", "max", "ref", "prev", "held", "series",
  "true_range", "typical_price", "rsi",
  "line", "band", "marker", "histogram", "barcolor", "background", "fill",
  "time", "session", "symbol", "int", "float", "source", "color",
]);

const ARITY: Record<string, number> = {
  sma: 2, ema: 2, wma: 2, stdev: 2, highest: 2, lowest: 2, sum: 2,
  abs: 1, min: 2, max: 2, ref: 2, prev: 1, held: 2, series: 3,
  true_range: 0, typical_price: 0, rsi: 2,
  line: 1, histogram: 1, band: 2, marker: 3, barcolor: 3, background: 2, fill: 3,
};

const SERIES_REFS = new Set(["open", "high", "low", "close", "volume"]);
const NAMESPACES = new Set(["time", "session", "symbol", "input"]);

export function parse(source: string): Program {
  const tokens = tokenize(source);
  let pos = 0;
  const declared = new Set<string>();

  const peek = () => tokens[pos];
  const at = (kind: TokenKind) => peek().kind === kind;
  const advance = () => tokens[pos++];
  const expect = (kind: TokenKind, what: string): Token => {
    if (!at(kind)) throw new ParseError(`Expected ${what}`, peek().line, peek().col);
    return advance();
  };

  function parseProgram(): Program {
    const statements: Statement[] = [];
    while (!at("eof")) statements.push(parseStatement());
    return statements;
  }

  function parseStatement(): Statement {
    if (at("ident") && peek().value === "input") {
      advance();
      const nameTok = expect("ident", "input name");
      checkNameAllowed(nameTok);
      expect("eq", "'='");
      return parseInputType(nameTok.value);
    }
    const nameTok = expect("ident", "formula name");
    checkNameAllowed(nameTok);
    expect("eq", "'='");
    const expr = parseExpression();
    declared.add(nameTok.value);
    return { kind: "formula", name: nameTok.value, expr };
  }

  function checkNameAllowed(tok: Token) {
    if (RESERVED.has(tok.value)) throw new ParseError(`'${tok.value}' is a reserved word, cannot be used as a name`, tok.line, tok.col);
  }

  function parseInputType(name: string): Statement {
    const typeTok = expect("ident", "input type (int/float/source/color)");
    const type = typeTok.value as InputType;
    if (!["int", "float", "source", "color"].includes(type)) {
      throw new ParseError(`Unknown input type '${type}'`, typeTok.line, typeTok.col);
    }
    expect("lparen", "'('");
    let defaultValue: number | string;
    if (type === "source") {
      const ref = expect("ident", "a series reference");
      if (!SERIES_REFS.has(ref.value) && !declared.has(ref.value)) {
        throw new ParseError(`Unknown series reference '${ref.value}'`, ref.line, ref.col);
      }
      defaultValue = ref.value;
    } else if (type === "color") {
      defaultValue = expect("string", "a color string").value;
    } else {
      defaultValue = Number(expect("number", "a default number").value);
    }
    let min: number | undefined, max: number | undefined;
    while (at("comma")) {
      advance();
      const key = expect("ident", "'min' or 'max'").value;
      expect("eq", "'='");
      const val = Number(expect("number", "a number").value);
      if (key === "min") min = val; else if (key === "max") max = val;
      else throw new ParseError(`Unknown input parameter '${key}'`, peek().line, peek().col);
    }
    expect("rparen", "')'");
    if ((type === "int" || type === "float") && (min === undefined || max === undefined)) {
      throw new ParseError(`'${type}' input requires both min and max`, typeTok.line, typeTok.col);
    }
    declared.add(name);
    return { kind: "input", name, type, defaultValue, min, max };
  }

  function parseExpression(): ASTNode { return parseOr(); }

  function parseOr(): ASTNode {
    let left = parseAnd();
    while (at("or")) { advance(); left = { kind: "binary", op: "or", left, right: parseAnd() }; }
    return left;
  }
  function parseAnd(): ASTNode {
    let left = parseComparison();
    while (at("and")) { advance(); left = { kind: "binary", op: "and", left, right: parseComparison() }; }
    return left;
  }
  function parseComparison(): ASTNode {
    let left = parseAdditive();
    const ops: Partial<Record<TokenKind, string>> = { lt: "<", gt: ">", lte: "<=", gte: ">=", eq2: "==", neq: "!=" };
    if (ops[peek().kind]) { const op = ops[advance().kind]!; left = { kind: "binary", op, left, right: parseAdditive() }; }
    return left;
  }
  function parseAdditive(): ASTNode {
    let left = parseMultiplicative();
    while (at("plus") || at("minus")) { const op = advance().kind === "plus" ? "+" : "-"; left = { kind: "binary", op, left, right: parseMultiplicative() }; }
    return left;
  }
  function parseMultiplicative(): ASTNode {
    let left = parseUnary();
    while (at("star") || at("slash")) { const op = advance().kind === "star" ? "*" : "/"; left = { kind: "binary", op, left, right: parseUnary() }; }
    return left;
  }
  function parseUnary(): ASTNode {
    if (at("not")) { advance(); return { kind: "unary", op: "not", operand: parseUnary() }; }
    if (at("minus")) { advance(); return { kind: "unary", op: "-", operand: parseUnary() }; }
    return parsePrimary();
  }

  function parsePrimary(): ASTNode {
    const tok = peek();
    if (tok.kind === "number") { advance(); return { kind: "number", value: Number(tok.value) }; }
    if (tok.kind === "string") { advance(); return { kind: "string", value: tok.value }; }
    if (tok.kind === "lparen") { advance(); const e = parseExpression(); expect("rparen", "')'"); return e; }
    if (tok.kind === "ident") {
      advance();
      if (NAMESPACES.has(tok.value) && at("dot")) {
        advance();
        const member = expect("ident", "namespace member").value;
        if (at("lparen")) { advance(); expect("rparen", "')'"); }
        return { kind: "namespaced", namespace: tok.value, member };
      }
      if (at("lparen")) return parseCall(tok);
      if (SERIES_REFS.has(tok.value)) return { kind: "ident", name: tok.value };
      if (!declared.has(tok.value)) {
        throw new ParseError(`'${tok.value}' is not defined before this point`, tok.line, tok.col);
      }
      return { kind: "ident", name: tok.value };
    }
    throw new ParseError(`Unexpected token '${tok.value || tok.kind}'`, tok.line, tok.col);
  }

  function parseCall(nameTok: Token): ASTNode {
    if (!(nameTok.value in ARITY)) {
      throw new ParseError(`Unknown function '${nameTok.value}'`, nameTok.line, nameTok.col);
    }
    expect("lparen", "'('");
    const args: ASTNode[] = [];
    const namedArgs: Record<string, ASTNode> = {};
    if (!at("rparen")) {
      do {
        if (at("ident") && tokens[pos + 1]?.kind === "eq") {
          const key = advance().value;
          advance();
          namedArgs[key] = parseExpression();
        } else {
          args.push(parseExpression());
        }
      } while (at("comma") && advance());
    }
    expect("rparen", "')'");
    const expected = ARITY[nameTok.value];
    if (args.length !== expected) {
      throw new ParseError(`'${nameTok.value}' expects ${expected} argument(s), got ${args.length}`, nameTok.line, nameTok.col);
    }
    return { kind: "call", name: nameTok.value, args, namedArgs };
  }

  return parseProgram();
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- parser`
Expected: PASS — 14 tests

- [x] **Step 5: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat: recursive-descent parser with reserved-word and no-forward-ref enforcement"
```

---

### Task 3: Core evaluator — point-wise math and comparisons

**Files:**
- Create: `src/engine/types.ts`
- Create: `src/engine/evaluator.ts`
- Test: `src/engine/evaluator.test.ts`

**Interfaces:**
- Consumes: `ASTNode`, `Program` from Task 1/2
- Produces: `OHLCV`, `EvalContext`, `evaluateNodeAt(node, i, ctx): number | boolean` — the core per-bar recursive evaluator every later primitive plugs into. `evaluateFormulaSeries(expr, ctx): (number|boolean)[]` — runs the bar-by-bar loop for one formula.

- [x] **Step 1: Write the shared types**

```typescript
// src/engine/types.ts
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
}
```

- [x] **Step 2: Write the failing tests**

```typescript
// src/engine/evaluator.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 100 }));
}

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    bars: bars([1, 2, 3]),
    completed: new Map(),
    self: [],
    currentFormula: "x",
    inputs: {},
    externalSeries: new Map(),
    symbolTicker: "TEST",
    pushDiagnostic: () => {},
    ...overrides,
  };
}

describe("evaluateFormulaSeries — point-wise math and comparisons", () => {
  it("evaluates raw series references", () => {
    const [{ expr }] = parse("x = close") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([1, 2, 3]);
  });

  it("evaluates arithmetic", () => {
    const [{ expr }] = parse("x = close * 2 + 1") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([3, 5, 7]);
  });

  it("evaluates abs/min/max", () => {
    expect(evaluateFormulaSeries((parse("x = abs(close - 2)") as any)[0].expr, ctx())).toEqual([1, 0, 1]);
    expect(evaluateFormulaSeries((parse("x = min(close, 2)") as any)[0].expr, ctx())).toEqual([1, 2, 2]);
    expect(evaluateFormulaSeries((parse("x = max(close, 2)") as any)[0].expr, ctx())).toEqual([2, 2, 3]);
  });

  it("evaluates comparisons to booleans", () => {
    expect(evaluateFormulaSeries((parse("x = close > 1") as any)[0].expr, ctx())).toEqual([false, true, true]);
  });

  it("evaluates and/or/not", () => {
    const c = ctx();
    expect(evaluateFormulaSeries((parse("x = close > 1 and close < 3") as any)[0].expr, c)).toEqual([false, true, false]);
    expect(evaluateFormulaSeries((parse("x = close > 1 or close < 1") as any)[0].expr, c)).toEqual([false, true, true]);
    expect(evaluateFormulaSeries((parse("x = not (close > 1)") as any)[0].expr, c)).toEqual([true, false, false]);
  });

  it("resolves a reference to an earlier, already-completed formula", () => {
    const c = ctx({ completed: new Map([["y", [10, 20, 30]]]) });
    const [decl1, decl2] = parse("y = close\nx = y + 1") as any;
    expect(evaluateFormulaSeries(decl2.expr, c)).toEqual([11, 21, 31]);
  });

  it("divide-by-zero degrades to NaN and pushes a diagnostic", () => {
    const diagnostics: string[] = [];
    const c = ctx({ bars: bars([0, 1, 2]), pushDiagnostic: (m) => diagnostics.push(m) });
    const result = evaluateFormulaSeries((parse("x = 1 / close") as any)[0].expr, c);
    expect(result[0]).toBeNaN();
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npm test -- evaluator`
Expected: FAIL — `Cannot find module './evaluator'`

- [x] **Step 4: Write the evaluator**

```typescript
// src/engine/evaluator.ts
import { ASTNode } from "../ast";
import { EvalContext } from "./types";

export function evaluateFormulaSeries(expr: ASTNode, ctx: EvalContext): (number | boolean)[] {
  const result: (number | boolean)[] = [];
  for (let i = 0; i < ctx.bars.length; i++) {
    ctx.self = result;
    result.push(evaluateNodeAt(expr, i, ctx));
  }
  return result;
}

export function evaluateNodeAt(node: ASTNode, i: number, ctx: EvalContext): number | boolean {
  switch (node.kind) {
    case "number": return node.value;
    case "string": throw new Error("A string literal cannot be evaluated as a series value");
    case "ident": return evaluateIdent(node.name, i, ctx);
    case "namespaced": return evaluateNamespaced(node, i, ctx);
    case "unary": return evaluateUnary(node, i, ctx);
    case "binary": return evaluateBinary(node, i, ctx);
    case "call": return evaluateCall(node, i, ctx);
  }
}

function evaluateIdent(name: string, i: number, ctx: EvalContext): number {
  const seriesFields: Record<string, keyof (typeof ctx.bars)[number]> = {
    open: "open", high: "high", low: "low", close: "close", volume: "volume",
  };
  if (name in seriesFields) return ctx.bars[i][seriesFields[name]];
  const completed = ctx.completed.get(name);
  if (completed) return completed[i] as number;
  const external = ctx.externalSeries.get(name);
  if (external) return external[i];
  throw new Error(`Unresolved identifier '${name}' at evaluation time — this is a parser bug, not a user error`);
}

function evaluateNamespaced(node: Extract<ASTNode, { kind: "namespaced" }>, i: number, ctx: EvalContext): number | boolean {
  if (node.namespace === "input") {
    const v = ctx.inputs[node.member];
    if (typeof v !== "number") throw new Error(`input.${node.member} is not a numeric input`);
    return v;
  }
  if (node.namespace === "time") {
    const date = new Date(ctx.bars[i].time * 1000);
    if (node.member === "dayofweek") return date.getUTCDay();
    if (node.member === "hour") return date.getUTCHours();
    if (node.member === "minute") return date.getUTCMinutes();
  }
  if (node.namespace === "session" && node.member === "is_open") {
    return ctx.sessionOpen ? ctx.sessionOpen(ctx.bars[i].time) : true;
  }
  if (node.namespace === "symbol") {
    if (node.member === "exchange") throw new Error("symbol.exchange() returns a string; only valid as an argument, not a series value");
    if (node.member === "ticker") throw new Error("symbol.ticker() returns a string; only valid as an argument, not a series value");
  }
  throw new Error(`Unknown namespaced reference ${node.namespace}.${node.member}`);
}

function evaluateUnary(node: Extract<ASTNode, { kind: "unary" }>, i: number, ctx: EvalContext): number | boolean {
  const v = evaluateNodeAt(node.operand, i, ctx);
  if (node.op === "not") return !v;
  if (node.op === "-") return -(v as number);
  throw new Error(`Unknown unary operator '${node.op}'`);
}

function evaluateBinary(node: Extract<ASTNode, { kind: "binary" }>, i: number, ctx: EvalContext): number | boolean {
  if (node.op === "and") return !!evaluateNodeAt(node.left, i, ctx) && !!evaluateNodeAt(node.right, i, ctx);
  if (node.op === "or") return !!evaluateNodeAt(node.left, i, ctx) || !!evaluateNodeAt(node.right, i, ctx);
  const l = evaluateNodeAt(node.left, i, ctx) as number;
  const r = evaluateNodeAt(node.right, i, ctx) as number;
  switch (node.op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/":
      if (r === 0) { ctx.pushDiagnostic(`division by zero`, i); return NaN; }
      return l / r;
    case "<": return l < r;
    case ">": return l > r;
    case "<=": return l <= r;
    case ">=": return l >= r;
    case "==": return l === r;
    case "!=": return l !== r;
    default: throw new Error(`Unknown binary operator '${node.op}'`);
  }
}

function evaluateCall(node: Extract<ASTNode, { kind: "call" }>, i: number, ctx: EvalContext): number | boolean {
  const arg = (n: number) => evaluateNodeAt(node.args[n], i, ctx) as number;
  switch (node.name) {
    case "abs": return Math.abs(arg(0));
    case "min": return Math.min(arg(0), arg(1));
    case "max": return Math.max(arg(0), arg(1));
    default:
      throw new Error(`'${node.name}' is not handled by the core evaluator — implemented in a later task`);
  }
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- evaluator`
Expected: PASS — 7 tests

- [x] **Step 6: Commit**

```bash
git add src/engine/types.ts src/engine/evaluator.ts src/engine/evaluator.test.ts
git commit -m "feat: core per-bar evaluator — point-wise math and comparisons"
```

---

### Task 4: Windowed functions

**Files:**
- Modify: `src/engine/evaluator.ts` (extend `evaluateCall`)
- Create: `src/engine/windowed.ts`
- Test: `src/engine/windowed.test.ts`

**Interfaces:**
- Consumes: `evaluateNodeAt`, `EvalContext` from Task 3
- Produces: `sma`, `ema`, `wma`, `stdev`, `highest`, `lowest`, `sum` — each `(seriesUpToI: number[], n: number, i: number) => number`, wired into `evaluateCall`'s switch.

Each function operates on the ALREADY-COMPUTED-UP-TO-`i` values of its series argument (built by recursively calling `evaluateNodeAt` for indices `i-n+1..i`, not the whole array — v1 favors correctness/simplicity over performance, recomputing on each call rather than maintaining a running accumulator).

- [x] **Step 1: Write the failing tests**

```typescript
// src/engine/windowed.test.ts
import { describe, it, expect } from "vitest";
import { sma, ema, wma, stdev, highest, lowest, sum } from "./windowed";

describe("windowed functions", () => {
  const series = [1, 2, 3, 4, 5];

  it("sma averages the last n values", () => {
    expect(sma(series, 3, 4)).toBeCloseTo((3 + 4 + 5) / 3);
    expect(sma(series, 3, 1)).toBeNaN(); // not enough history yet (needs index >= n-1)
  });

  it("ema weights recent values more heavily and matches a known reference value", () => {
    // 3-period EMA over [1,2,3,4,5], alpha = 2/(3+1) = 0.5
    // seed = sma(indices 0..2) = 2; then at k=3: 0.5*4 + 0.5*2 = 3; at k=4: 0.5*5 + 0.5*3 = 4
    expect(ema(series, 3, 4)).toBeCloseTo(4);
  });

  it("wma weights linearly by recency", () => {
    // weights 1,2,3 over [3,4,5] (index 4, n=3): (3*1+4*2+5*3)/(1+2+3) = 26/6
    expect(wma(series, 3, 4)).toBeCloseTo(26 / 6);
  });

  it("stdev computes population stdev over the window", () => {
    const window = [3, 4, 5];
    const mean = 4;
    const expected = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / 3);
    expect(stdev(series, 3, 4)).toBeCloseTo(expected);
  });

  it("highest/lowest find the max/min over the window", () => {
    expect(highest(series, 3, 4)).toBe(5);
    expect(lowest(series, 3, 4)).toBe(3);
  });

  it("sum totals the window", () => {
    expect(sum(series, 3, 4)).toBe(3 + 4 + 5);
  });

  it("all windowed functions return NaN before enough history exists", () => {
    expect(sma(series, 3, 0)).toBeNaN();
    expect(highest(series, 3, 0)).toBeNaN();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- windowed`
Expected: FAIL — `Cannot find module './windowed'`

- [x] **Step 3: Write the windowed functions**

```typescript
// src/engine/windowed.ts
function windowSlice(series: number[], n: number, i: number): number[] | null {
  if (i - n + 1 < 0) return null;
  return series.slice(i - n + 1, i + 1);
}

export function sma(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  if (!w) return NaN;
  return w.reduce((a, b) => a + b, 0) / n;
}

export function ema(series: number[], n: number, i: number): number {
  if (i < n - 1) return NaN;
  const alpha = 2 / (n + 1);
  let value = sma(series, n, n - 1);
  for (let k = n; k <= i; k++) value = alpha * series[k] + (1 - alpha) * value;
  return value;
}

export function wma(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  if (!w) return NaN;
  let weightedSum = 0, weightTotal = 0;
  for (let k = 0; k < n; k++) { const weight = k + 1; weightedSum += w[k] * weight; weightTotal += weight; }
  return weightedSum / weightTotal;
}

export function stdev(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  if (!w) return NaN;
  const mean = w.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
}

export function highest(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  return w ? Math.max(...w) : NaN;
}

export function lowest(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  return w ? Math.min(...w) : NaN;
}

export function sum(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  return w ? w.reduce((a, b) => a + b, 0) : NaN;
}
```

- [x] **Step 4: Wire into the evaluator**

In `src/engine/evaluator.ts`, add the import and extend `evaluateCall`'s switch. Windowed functions need the FULL series-so-far of their first argument, built by evaluating it at every index up to `i` (not just at `i`) — add a helper:

```typescript
// add near the top of evaluator.ts
import { sma, ema, wma, stdev, highest, lowest, sum } from "./windowed";

function seriesUpTo(node: ASTNode, i: number, ctx: EvalContext): number[] {
  const out: number[] = [];
  for (let k = 0; k <= i; k++) out.push(evaluateNodeAt(node, k, ctx) as number);
  return out;
}
```

In `evaluateCall`'s `switch`, before the `default` case. Each result is checked for `NaN` (insufficient history) and pushes a diagnostic when it occurs, matching the design spec's requirement that insufficient-history degradation is recorded the same way division-by-zero is:

```typescript
    case "sma": case "ema": case "wma": case "stdev": case "highest": case "lowest": case "sum": {
      const windowFns = { sma, ema, wma, stdev, highest, lowest, sum };
      const result = windowFns[node.name](seriesUpTo(node.args[0], i, ctx), arg(1), i);
      if (Number.isNaN(result)) ctx.pushDiagnostic(`${node.name}(): insufficient history`, i);
      return result;
    }
```

(This replaces having one `case` line per function — grouping them keeps the NaN-check-and-diagnostic logic in one place instead of repeated seven times.)

(Note: `arg(1)` evaluates the second argument, the window length `n`, at index `i` — since `n` is always a plain number literal per the grammar, this just returns that literal.)

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- windowed`
Expected: PASS — 7 tests

Run: `npm test` (full suite, confirm nothing broke)
Expected: PASS — all tests

- [x] **Step 6: Commit**

```bash
git add src/engine/windowed.ts src/engine/windowed.test.ts src/engine/evaluator.ts
git commit -m "feat: windowed functions — sma/ema/wma/stdev/highest/lowest/sum"
```

---

### Task 5: `ref()` and `prev()`

**Files:**
- Modify: `src/engine/evaluator.ts`
- Test: `src/engine/time-refs.test.ts`

**Interfaces:**
- Consumes: `EvalContext.self` (Task 3) for `prev`'s self-reference
- Produces: `ref`/`prev` cases in `evaluateCall`

- [x] **Step 1: Write the failing tests**

```typescript
// src/engine/time-refs.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 100 }));
}
function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    bars: bars([10, 20, 30, 40]), completed: new Map(), self: [], currentFormula: "x",
    inputs: {}, externalSeries: new Map(), symbolTicker: "TEST", pushDiagnostic: () => {},
    ...overrides,
  };
}

describe("ref() and prev()", () => {
  it("ref(x, n) reads n bars back", () => {
    const [{ expr }] = parse("x = ref(close, 1)") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([NaN, 10, 20, 30]);
  });

  it("ref(x, 0) is the current bar", () => {
    const [{ expr }] = parse("x = ref(close, 0)") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([10, 20, 30, 40]);
  });

  it("prev(n) reads this formula's own value n bars back, enabling recursion", () => {
    // a running total: this_bar_close + previous_running_total
    const [{ expr }] = parse("x = close + prev(1)") as any;
    const result = evaluateFormulaSeries(expr, ctx());
    expect(result[0]).toBe(10); // prev(1) at bar 0 has no history -> treated as 0
    expect(result[1]).toBe(30); // 20 + 10
    expect(result[2]).toBe(60); // 30 + 30
    expect(result[3]).toBe(100); // 40 + 60
  });

  it("prev(n) before enough history defaults to 0, not NaN, so recursive formulas can bootstrap", () => {
    const [{ expr }] = parse("x = prev(1) * 0.9 + close * 0.1") as any;
    const result = evaluateFormulaSeries(expr, ctx());
    expect(result[0]).toBeCloseTo(1); // prev(1)=0 -> 0*0.9 + 10*0.1 = 1
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- time-refs`
Expected: FAIL — `ref`/`prev` hit the evaluator's default `throw`

- [x] **Step 3: Extend the evaluator**

In `src/engine/evaluator.ts`'s `evaluateCall`, add before `default`:

```typescript
    case "ref": {
      const n = arg(1);
      const idx = i - n;
      if (idx < 0) { ctx.pushDiagnostic(`ref(): insufficient history`, i); return NaN; }
      return evaluateNodeAt(node.args[0], idx, ctx) as number;
    }
    case "prev": {
      const n = arg(0);
      const idx = i - n;
      return idx < 0 ? 0 : (ctx.self[idx] as number);
    }
```

`ref`'s lookback is arbitrary — it can look back into ANY expression (including raw price), re-evaluated at the earlier index, so out-of-range degrades to `NaN` (the "insufficient history" case from the design spec's Error handling section). `prev`'s lookback is specifically THIS formula's own running series (`ctx.self`) — defaulting to `0` rather than `NaN` before enough history exists is what lets a recursive formula (Wilder smoothing, a running total) bootstrap from bar 0 instead of being permanently `NaN`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- time-refs`
Expected: PASS — 4 tests

- [x] **Step 5: Commit**

```bash
git add src/engine/evaluator.ts src/engine/time-refs.test.ts
git commit -m "feat: ref() and prev() — bounded lookback and self-referencing recursion"
```

---

### Task 6: `held()`

**Files:**
- Modify: `src/engine/evaluator.ts`
- Test: `src/engine/held.test.ts`

**Interfaces:**
- Consumes: `ctx.self` (same mechanism as `prev`)
- Produces: `held` case in `evaluateCall`

- [x] **Step 1: Write the failing tests**

```typescript
// src/engine/held.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 100 }));
}
function ctx(): EvalContext {
  return {
    bars: bars([1, 5, 5, 5, 9, 9]), completed: new Map(), self: [], currentFormula: "x",
    inputs: {}, externalSeries: new Map(), symbolTicker: "TEST", pushDiagnostic: () => {},
  };
}

describe("held()", () => {
  it("updates on the condition and carries forward indefinitely otherwise", () => {
    // condition: close > ref(close, 1) (a new high vs the prior bar)
    const [{ expr }] = parse("x = held(close > ref(close, 1), close)") as any;
    const result = evaluateFormulaSeries(expr, ctx());
    // bar0: no prior bar -> condition false -> holds default 0
    // bar1: 5 > 1 -> true -> holds 5
    // bar2: 5 > 5 -> false -> still holds 5
    // bar3: 5 > 5 -> false -> still holds 5
    // bar4: 9 > 5 -> true -> holds 9
    // bar5: 9 > 9 -> false -> still holds 9
    expect(result).toEqual([0, 5, 5, 5, 9, 9]);
  });

  it("persists across many bars, not just a fixed lookback", () => {
    const longBars = bars([10, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const [{ expr }] = parse("x = held(close > ref(close, 1), close)") as any;
    const ctxLong: EvalContext = { bars: longBars, completed: new Map(), self: [], currentFormula: "x", inputs: {}, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
    const result = evaluateFormulaSeries(expr, ctxLong);
    // bar0: 10, no prior -> condition false -> 0
    // bar1: 1 > 10 false -> still 0 ... every subsequent bar condition stays false -> holds 0 all the way through
    expect(result[9]).toBe(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- held`
Expected: FAIL

- [x] **Step 3: Extend the evaluator**

In `src/engine/evaluator.ts`'s `evaluateCall`, add:

```typescript
    case "held": {
      const condition = evaluateNodeAt(node.args[0], i, ctx);
      if (condition) return evaluateNodeAt(node.args[1], i, ctx) as number;
      return i === 0 ? 0 : (ctx.self[i - 1] as number);
    }
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- held`
Expected: PASS — 2 tests

- [x] **Step 5: Commit**

```bash
git add src/engine/evaluator.ts src/engine/held.test.ts
git commit -m "feat: held() — arbitrary-duration stateful pattern tracking"
```

---

### Task 7: Built-in derived series — `true_range`, `typical_price`, `rsi`

**Files:**
- Modify: `src/engine/evaluator.ts`
- Test: `src/engine/derived.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-6
- Produces: `true_range`/`typical_price`/`rsi` cases in `evaluateCall`

`rsi(x, n)` is implemented by literally parsing and evaluating the Wilder-smoothing sub-expressions shown in the design spec, using the SAME machinery as any other formula — proving the language can express it, per the design doc's own claim.

- [x] **Step 1: Write the failing tests**

```typescript
// src/engine/derived.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bar(o: number, h: number, l: number, c: number, t: number): OHLCV {
  return { time: t, open: o, high: h, low: l, close: c, volume: 100 };
}
function ctx(bars: OHLCV[]): EvalContext {
  return { bars, completed: new Map(), self: [], currentFormula: "x", inputs: {}, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
}

describe("built-in derived series", () => {
  it("true_range is max(high-low, |high-prevClose|, |low-prevClose|)", () => {
    const bars = [bar(10, 12, 9, 11, 0), bar(11, 15, 10, 14, 1)];
    const [{ expr }] = parse("x = true_range()") as any;
    const result = evaluateFormulaSeries(expr, ctx(bars));
    expect(result[0]).toBe(12 - 9); // no prior close -> just high-low
    expect(result[1]).toBeCloseTo(Math.max(15 - 10, Math.abs(15 - 11), Math.abs(10 - 11)));
  });

  it("typical_price is (h+l+c)/3", () => {
    const bars = [bar(10, 12, 9, 11, 0)];
    const [{ expr }] = parse("x = typical_price()") as any;
    expect(evaluateFormulaSeries(expr, ctx(bars))[0]).toBeCloseTo((12 + 9 + 11) / 3);
  });

  it("rsi is 100 for a series with no losses at all", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, i, i, i + 1, i)); // strictly increasing
    const [{ expr }] = parse("x = rsi(close, 14)") as any;
    const result = evaluateFormulaSeries(expr, ctx(bars));
    expect(result[19]).toBeCloseTo(100, 0);
  });

  it("rsi is 0 for a series with no gains at all", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(20 - i, 20 - i, 20 - i, 20 - i - 1, i)); // strictly decreasing
    const [{ expr }] = parse("x = rsi(close, 14)") as any;
    const result = evaluateFormulaSeries(expr, ctx(bars));
    expect(result[19]).toBeCloseTo(0, 0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- derived`
Expected: FAIL

- [x] **Step 3: Extend the evaluator**

In `src/engine/evaluator.ts`, add a helper that parses a small internal formula string once (module load time) and reuses its AST — `rsi` needs two SEPARATE self-referencing accumulators (`avg_gain`, `avg_loss`), which the single-`ctx.self`-per-formula design (Tasks 3-6) doesn't directly support for a call embedded inside another formula. Implement `rsi` as its own tiny nested evaluation, each with its own `self` array, rather than trying to force two accumulators into one `ctx.self`:

```typescript
import { parse } from "../parser";

const TRUE_RANGE_EXPR = (parse("x = max(high - low, max(abs(high - ref(close, 1)), abs(low - ref(close, 1))))") as any)[0].expr;
const TYPICAL_PRICE_EXPR = (parse("x = (high + low + close) / 3") as any)[0].expr;

function rsiAt(n: number, i: number, ctx: EvalContext, sourceNode: ASTNode): number {
  // Two independent recursive accumulators — each needs its own running
  // series, so this runs its own tiny bar-by-bar loop rather than reusing
  // ctx.self (which belongs to the OUTER formula calling rsi(), not to rsi's
  // own internal state).
  const gains: number[] = [], losses: number[] = [], avgGain: number[] = [], avgLoss: number[] = [];
  for (let k = 0; k <= i; k++) {
    const cur = evaluateNodeAt(sourceNode, k, ctx) as number;
    const prevVal = k === 0 ? cur : (evaluateNodeAt(sourceNode, k - 1, ctx) as number);
    const change = cur - prevVal;
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
    const prevAvgGain = k === 0 ? 0 : avgGain[k - 1];
    const prevAvgLoss = k === 0 ? 0 : avgLoss[k - 1];
    avgGain.push(prevAvgGain * (n - 1) / n + gains[k] / n);
    avgLoss.push(prevAvgLoss * (n - 1) / n + losses[k] / n);
  }
  const ag = avgGain[i], al = avgLoss[i];
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}
```

Add to `evaluateCall`'s switch:

```typescript
    case "true_range": return evaluateNodeAt(TRUE_RANGE_EXPR, i, ctx) as number;
    case "typical_price": return evaluateNodeAt(TYPICAL_PRICE_EXPR, i, ctx) as number;
    case "rsi": return rsiAt(arg(1), i, ctx, node.args[0]);
```

Note: `true_range`'s reference implementation above uses `ref(close, 1)` directly rather than the design spec's literal `abs(high - ref(close,1))` nested form — same result, restructured slightly to fit two-argument `max()`; verify the test's expected values match regardless of the exact nesting.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- derived`
Expected: PASS — 4 tests

Run: `npm test` (full suite)
Expected: PASS — all tests

- [x] **Step 5: Commit**

```bash
git add src/engine/evaluator.ts src/engine/derived.test.ts
git commit -m "feat: true_range, typical_price, rsi — rsi proven expressible via prev-style recursion"
```

---

### Task 8: Inputs

**Files:**
- Create: `src/engine/inputs.ts`
- Test: `src/engine/inputs.test.ts`

**Interfaces:**
- Consumes: `InputDecl` from Task 1
- Produces: `resolveInputs(decls: InputDecl[], overrides?: Record<string, number | string>): Record<string, number | string>` — consumed by Task 12's orchestration.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/engine/inputs.test.ts
import { describe, it, expect } from "vitest";
import { resolveInputs } from "./inputs";
import type { InputDecl } from "../ast";

describe("resolveInputs", () => {
  const decls: InputDecl[] = [
    { kind: "input", name: "length", type: "int", defaultValue: 14, min: 2, max: 200 },
    { kind: "input", name: "band_color", type: "color", defaultValue: "#2196F3" },
  ];

  it("uses defaults when no overrides given", () => {
    expect(resolveInputs(decls)).toEqual({ length: 14, band_color: "#2196F3" });
  });

  it("applies a valid override", () => {
    expect(resolveInputs(decls, { length: 9 })).toEqual({ length: 9, band_color: "#2196F3" });
  });

  it("rejects an override below min", () => {
    expect(() => resolveInputs(decls, { length: 1 })).toThrow(/min/);
  });

  it("rejects an override above max", () => {
    expect(() => resolveInputs(decls, { length: 500 })).toThrow(/max/);
  });

  it("rejects an override for a name that isn't declared", () => {
    expect(() => resolveInputs(decls, { nonexistent: 1 })).toThrow(/not declared/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- inputs`
Expected: FAIL — `Cannot find module './inputs'`

- [ ] **Step 3: Write `resolveInputs`**

```typescript
// src/engine/inputs.ts
import { InputDecl } from "../ast";

export function resolveInputs(
  decls: InputDecl[],
  overrides: Record<string, number | string> = {},
): Record<string, number | string> {
  const declared = new Set(decls.map(d => d.name));
  for (const key of Object.keys(overrides)) {
    if (!declared.has(key)) throw new Error(`Input '${key}' is not declared in this script`);
  }
  const resolved: Record<string, number | string> = {};
  for (const decl of decls) {
    const value = key in overrides ? overrides[decl.name] : decl.defaultValue;
    if ((decl.type === "int" || decl.type === "float") && typeof value === "number") {
      if (decl.min !== undefined && value < decl.min) throw new Error(`Input '${decl.name}' below min (${decl.min})`);
      if (decl.max !== undefined && value > decl.max) throw new Error(`Input '${decl.name}' above max (${decl.max})`);
    }
    resolved[decl.name] = value;
  }
  return resolved;
}
```

(Fix the `key in overrides` typo to `decl.name in overrides` while implementing — the loop variable is `decl`, not `key`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- inputs`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/engine/inputs.ts src/engine/inputs.test.ts
git commit -m "feat: input resolution with bounds enforcement"
```

---

### Task 9: `DataAdapter` interface and in-memory reference implementation

**Files:**
- Create: `src/adapters/data/in-memory.ts`
- Test: `src/adapters/data/in-memory.test.ts`

**Interfaces:**
- Consumes: `DataAdapter`, `OHLCV` from Task 3's `types.ts`
- Produces: `InMemoryDataAdapter` — consumed by Task 10 and Task 14's end-to-end test.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/adapters/data/in-memory.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryDataAdapter } from "./in-memory";

describe("InMemoryDataAdapter", () => {
  it("returns the series registered for a symbol/timeframe pair", async () => {
    const bars = [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    const adapter = new InMemoryDataAdapter();
    adapter.register("NIFTY 50", "1d", bars);
    expect(await adapter.getSeries("NIFTY 50", "1d")).toEqual(bars);
  });

  it("throws for an unregistered symbol/timeframe pair", async () => {
    const adapter = new InMemoryDataAdapter();
    await expect(adapter.getSeries("NOPE", "1d")).rejects.toThrow();
  });

  it("returns registered symbol meta, or undefined behavior if none registered", async () => {
    const adapter = new InMemoryDataAdapter();
    adapter.registerMeta("RELIANCE", "NSE", (t) => t > 100);
    const meta = await adapter.getSymbolMeta!("RELIANCE");
    expect(meta.exchange).toBe("NSE");
    expect(meta.sessionOpen(50)).toBe(false);
    expect(meta.sessionOpen(150)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- in-memory`
Expected: FAIL — `Cannot find module './in-memory'`

- [ ] **Step 3: Write the adapter**

```typescript
// src/adapters/data/in-memory.ts
import { DataAdapter, OHLCV } from "../../engine/types";

/** A reference DataAdapter for tests and examples — not meant for production
 * use, just proves the interface and gives every other task something real
 * to test against without a network call. */
export class InMemoryDataAdapter implements DataAdapter {
  private series = new Map<string, OHLCV[]>();
  private meta = new Map<string, { exchange: string; sessionOpen(time: number): boolean }>();

  register(symbol: string, timeframe: string, bars: OHLCV[]): void {
    this.series.set(`${symbol}:${timeframe}`, bars);
  }

  registerMeta(symbol: string, exchange: string, sessionOpen: (time: number) => boolean): void {
    this.meta.set(symbol, { exchange, sessionOpen });
  }

  async getSeries(symbol: string, timeframe: string): Promise<OHLCV[]> {
    const key = `${symbol}:${timeframe}`;
    const bars = this.series.get(key);
    if (!bars) throw new Error(`No series registered for ${key}`);
    return bars;
  }

  async getSymbolMeta(symbol: string) {
    const meta = this.meta.get(symbol);
    if (!meta) throw new Error(`No symbol meta registered for ${symbol}`);
    return meta;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- in-memory`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/adapters/data/in-memory.ts src/adapters/data/in-memory.test.ts
git commit -m "feat: InMemoryDataAdapter — reference DataAdapter for tests and examples"
```

---

### Task 10: `series()` cross-resolution and context primitives

**Files:**
- Create: `src/engine/prefetch.ts`
- Modify: `src/engine/evaluator.ts`
- Test: `src/engine/prefetch.test.ts`

**Interfaces:**
- Consumes: `DataAdapter` (Task 3/9), `Program` (Task 2)
- Produces: `prefetchExternalSeries(program: Program, primaryBars: OHLCV[], adapter: DataAdapter, symbolTicker: string): Promise<{ externalSeries: Map<string, number[]>; sessionOpen?: (t:number)=>boolean; exchange?: string }>` — walks the AST once collecting every `series()`/`session.*`/`symbol.exchange` usage, resolves them via the async adapter ONCE, forward-fills to the primary bar length. Consumed by Task 12's orchestration, which populates `EvalContext` with the result before the synchronous per-bar evaluation runs.

**`series(symbol, timeframe, field)` and `symbol.exchange()`/`session.is_open()` are NEVER evaluated by the synchronous per-bar evaluator directly** — they're resolved once here, upfront, and the results are placed into `ctx.externalSeries`/`ctx.sessionOpen`/`ctx.exchange` so the per-bar evaluator only ever does synchronous array lookups.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/engine/prefetch.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { prefetchExternalSeries } from "./prefetch";
import { InMemoryDataAdapter } from "../adapters/data/in-memory";
import type { OHLCV } from "./types";

function bars(times: number[]): OHLCV[] {
  return times.map(t => ({ time: t, open: t, high: t, low: t, close: t, volume: 1 }));
}

describe("prefetchExternalSeries", () => {
  it("forward-fills a lower-resolution series to align with the primary bars", async () => {
    const adapter = new InMemoryDataAdapter();
    // Daily bars at t=0 and t=100; primary (5-min) bars run from t=0 to t=150
    adapter.register("TEST", "1d", bars([0, 100]).map((b, idx) => ({ ...b, close: idx === 0 ? 10 : 20 })));
    const primary = bars([0, 30, 60, 90, 120, 150]);
    const program = parse('x = series("TEST", "1d", "close")');

    const { externalSeries } = await prefetchExternalSeries(program, primary, adapter, "TEST");

    const key = [...externalSeries.keys()][0];
    expect(externalSeries.get(key)).toEqual([10, 10, 10, 10, 20, 20]);
  });

  it("resolves session/exchange meta once via getSymbolMeta", async () => {
    const adapter = new InMemoryDataAdapter();
    adapter.registerMeta("TEST", "NSE", (t) => t >= 50);
    const primary = bars([0, 100]);
    const program = parse("x = session.is_open()");

    const { sessionOpen, exchange } = await prefetchExternalSeries(program, primary, adapter, "TEST");

    expect(exchange).toBe("NSE");
    expect(sessionOpen!(0)).toBe(false);
    expect(sessionOpen!(100)).toBe(true);
  });

  it("does nothing if the program uses no external series or context", async () => {
    const adapter = new InMemoryDataAdapter();
    const program = parse("x = close");
    const { externalSeries } = await prefetchExternalSeries(program, bars([0]), adapter, "TEST");
    expect(externalSeries.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- prefetch`
Expected: FAIL — `Cannot find module './prefetch'`

- [ ] **Step 3: Write `prefetchExternalSeries`**

```typescript
// src/engine/prefetch.ts
import { ASTNode, Program } from "../ast";
import { DataAdapter, OHLCV } from "./types";

interface SeriesCall { symbol: string; timeframe: string; field: string }

function walk(node: ASTNode, found: { series: SeriesCall[]; needsSessionOrExchange: boolean }): void {
  if (node.kind === "call" && node.name === "series") {
    const [symbolNode, tfNode, fieldNode] = node.args;
    if (symbolNode.kind === "string" && tfNode.kind === "string" && fieldNode.kind === "string") {
      found.series.push({ symbol: symbolNode.value, timeframe: tfNode.value, field: fieldNode.value });
    }
    // symbol.ticker() as the first arg is resolved by the caller before walking, not here.
  }
  if (node.kind === "namespaced" && (node.namespace === "session" || (node.namespace === "symbol" && node.member === "exchange"))) {
    found.needsSessionOrExchange = true;
  }
  if (node.kind === "binary") { walk(node.left, found); walk(node.right, found); }
  if (node.kind === "unary") walk(node.operand, found);
  if (node.kind === "call") for (const a of node.args) walk(a, found);
}

function forwardFill(source: OHLCV[], field: string, primary: OHLCV[]): number[] {
  const result: number[] = [];
  let ptr = 0;
  for (const bar of primary) {
    while (ptr + 1 < source.length && source[ptr + 1].time <= bar.time) ptr++;
    result.push((source[ptr] as any)[field]);
  }
  return result;
}

export async function prefetchExternalSeries(
  program: Program,
  primaryBars: OHLCV[],
  adapter: DataAdapter,
  symbolTicker: string,
): Promise<{ externalSeries: Map<string, number[]>; sessionOpen?: (t: number) => boolean; exchange?: string }> {
  const found = { series: [] as SeriesCall[], needsSessionOrExchange: false };
  for (const stmt of program) if (stmt.kind === "formula") walk(stmt.expr, found);

  const externalSeries = new Map<string, number[]>();
  for (const call of found.series) {
    const symbol = call.symbol === symbolTicker ? symbolTicker : call.symbol; // symbol.ticker() already substituted by the caller
    const source = await adapter.getSeries(symbol, call.timeframe);
    const key = `series(${call.symbol},${call.timeframe},${call.field})`;
    externalSeries.set(key, forwardFill(source, call.field, primaryBars));
  }

  let sessionOpen: ((t: number) => boolean) | undefined;
  let exchange: string | undefined;
  if (found.needsSessionOrExchange && adapter.getSymbolMeta) {
    const meta = await adapter.getSymbolMeta(symbolTicker);
    sessionOpen = meta.sessionOpen;
    exchange = meta.exchange;
  }

  return { externalSeries, sessionOpen, exchange };
}
```

- [ ] **Step 4: Wire `series()` and `symbol.exchange()`/`symbol.ticker()` into the evaluator**

In `src/engine/evaluator.ts`'s `evaluateCall`, add:

```typescript
    case "series": {
      const symbolArg = node.args[0].kind === "namespaced" && node.args[0].namespace === "symbol" && node.args[0].member === "ticker"
        ? ctx.symbolTicker
        : (node.args[0] as any).value;
      const timeframe = (node.args[1] as any).value;
      const field = (node.args[2] as any).value;
      const key = `series(${symbolArg},${timeframe},${field})`;
      const series = ctx.externalSeries.get(key);
      if (!series) { ctx.pushDiagnostic(`series(${symbolArg}, ${timeframe}, ${field}) was not prefetched`, i); return NaN; }
      return series[i];
    }
```

And in `evaluateNamespaced`, replace the `symbol.exchange`/`symbol.ticker` throws (these are only meaningful as string-typed ARGUMENTS to `series()`, handled above — evaluating them as a plain series value directly is a genuine misuse, so the throw stays for that case) — no change needed there, the `series` case above already special-cases reading `symbol.ticker()` out of the AST without calling `evaluateNodeAt` on it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- prefetch`
Expected: PASS — 3 tests

Run: `npm test` (full suite)
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/engine/prefetch.ts src/engine/prefetch.test.ts src/engine/evaluator.ts
git commit -m "feat: series() multi-timeframe reads and session/exchange context, resolved once upfront"
```

---

### Task 11: Output wrappers

**Files:**
- Create: `src/engine/outputs.ts`
- Test: `src/engine/outputs.test.ts`

**Interfaces:**
- Consumes: `IndicatorOutput` (Task 3), evaluated series
- Produces: `buildOutput(name: string, node: CallNode, series: (number|boolean)[], bars: OHLCV[]): IndicatorOutput | null` — consumed by Task 12's orchestration. Returns `null` for a bare (unwrapped) formula.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/engine/outputs.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import { buildOutput } from "./outputs";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
}
function ctx(bars: OHLCV[]): EvalContext {
  return { bars, completed: new Map(), self: [], currentFormula: "x", inputs: {}, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
}

describe("buildOutput", () => {
  it("returns null for a bare (unwrapped) formula", () => {
    const [{ expr }] = parse("x = close") as any;
    expect(buildOutput("x", expr, bars([1]))).toBeNull();
  });

  it("wraps a line() output", () => {
    const [{ expr }] = parse("x = line(close)") as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "line", points: [{ time: 0, value: 1 }, { time: 1, value: 2 }],
    });
  });

  it("wraps a band() output with upper and lower", () => {
    const [{ expr }] = parse("x = band(close + 1, close - 1)") as any;
    const b = bars([10]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "band", upper: [{ time: 0, value: 11 }], lower: [{ time: 0, value: 9 }],
    });
  });

  it("wraps a band() with a color, including an input.<name> color reference (not just a string literal)", () => {
    const [{ expr }] = parse('x = band(close + 1, close - 1, color=input.c)') as any;
    const b = bars([10]);
    const ctx: EvalContext = { bars: b, completed: new Map(), self: [], currentFormula: "x", inputs: { c: "#2196F3" }, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
    const result = buildOutput("x", expr, b, ctx);
    expect((result as any).color).toBe("#2196F3");
  });

  it("wraps a marker() output, only at points where the condition is true", () => {
    const [{ expr }] = parse('x = marker(close > 1, "triangle-up", "green")') as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "marker", points: [{ time: 1, shape: "triangle-up", color: "green" }],
    });
  });

  it("wraps a histogram() output", () => {
    const [{ expr }] = parse("x = histogram(close)") as any;
    expect(buildOutput("x", expr, bars([5]))).toEqual({ type: "histogram", points: [{ time: 0, value: 5 }] });
  });

  it("wraps a barcolor() output", () => {
    const [{ expr }] = parse('x = barcolor(close > 1, "green", "red")') as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "barcolor", points: [{ time: 0, color: "red" }, { time: 1, color: "green" }],
    });
  });

  it("wraps a background() output, only at points where the condition is true", () => {
    const [{ expr }] = parse('x = background(close > 1, "#eee")') as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "background", points: [{ time: 1, color: "#eee" }],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- outputs`
Expected: FAIL — `Cannot find module './outputs'`

- [ ] **Step 3: Write `buildOutput`**

```typescript
// src/engine/outputs.ts
import { ASTNode } from "../ast";
import { evaluateNodeAt } from "./evaluator";
import { EvalContext, IndicatorOutput, OHLCV } from "./types";

const OUTPUT_WRAPPERS = new Set(["line", "band", "marker", "histogram", "barcolor", "background", "fill"]);

export function isOutputWrapper(expr: ASTNode): expr is Extract<ASTNode, { kind: "call" }> {
  return expr.kind === "call" && OUTPUT_WRAPPERS.has(expr.name);
}

export function buildOutput(name: string, expr: ASTNode, bars: OHLCV[], ctx?: EvalContext): IndicatorOutput | null {
  if (!isOutputWrapper(expr)) return null;
  const context = ctx ?? { bars, completed: new Map(), self: [], currentFormula: name, inputs: {}, externalSeries: new Map(), symbolTicker: "", pushDiagnostic: () => {} };

  switch (expr.name) {
    case "line": {
      const series = evalArgSeries(expr.args[0], bars, context);
      return { type: "line", points: bars.map((b, i) => ({ time: b.time, value: series[i] })) };
    }
    case "histogram": {
      const series = evalArgSeries(expr.args[0], bars, context);
      return { type: "histogram", points: bars.map((b, i) => ({ time: b.time, value: series[i] })) };
    }
    case "band": {
      const upper = evalArgSeries(expr.args[0], bars, context);
      const lower = evalArgSeries(expr.args[1], bars, context);
      const colorNode = expr.namedArgs.color;
      const color = colorNode ? evaluateStringArg(colorNode, context) : undefined;
      return {
        type: "band",
        upper: bars.map((b, i) => ({ time: b.time, value: upper[i] })),
        lower: bars.map((b, i) => ({ time: b.time, value: lower[i] })),
        ...(color !== undefined ? { color } : {}),
      };
    }
    case "marker": {
      const condition = evalArgSeries(expr.args[0], bars, context) as unknown as boolean[];
      const shape = evaluateStringArg(expr.args[1], context);
      const color = evaluateStringArg(expr.args[2], context);
      return {
        type: "marker",
        points: bars.filter((_, i) => condition[i]).map(b => ({ time: b.time, shape, color })),
      };
    }
    case "barcolor": {
      const condition = evalArgSeries(expr.args[0], bars, context) as unknown as boolean[];
      const colorTrue = evaluateStringArg(expr.args[1], context);
      const colorFalse = evaluateStringArg(expr.args[2], context);
      return {
        type: "barcolor",
        points: bars.map((b, i) => ({ time: b.time, color: condition[i] ? colorTrue : colorFalse })),
      };
    }
    case "background": {
      const condition = evalArgSeries(expr.args[0], bars, context) as unknown as boolean[];
      const color = evaluateStringArg(expr.args[1], context);
      return {
        type: "background",
        points: bars.filter((_, i) => condition[i]).map(b => ({ time: b.time, color })),
      };
    }
    case "fill": {
      const a = (expr.args[0] as any).name as string;
      const b = (expr.args[1] as any).name as string;
      const color = evaluateStringArg(expr.args[2], context);
      return { type: "fill", between: [a, b], color };
    }
  }
  return null;
}

function evalArgSeries(node: ASTNode, bars: OHLCV[], ctx: EvalContext): (number | boolean)[] {
  const result: (number | boolean)[] = [];
  const localCtx = { ...ctx, self: result };
  for (let i = 0; i < bars.length; i++) result.push(evaluateNodeAt(node, i, localCtx));
  return result;
}

/** Colors and shapes are string-valued — outside evaluateNodeAt's number|boolean
 * return type on purpose, since the per-bar numeric evaluator never needs a
 * string. This handles the two places a string CAN legally appear: a plain
 * literal ("red"), or an input.<name> reference to a color-type input. */
function evaluateStringArg(node: ASTNode, ctx: EvalContext): string {
  if (node.kind === "string") return node.value;
  if (node.kind === "namespaced" && node.namespace === "input") {
    const v = ctx.inputs[node.member];
    if (typeof v !== "string") throw new Error(`input.${node.member} is not a color/string input`);
    return v;
  }
  throw new Error("Expected a string literal or an input.<name> color reference");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- outputs`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/engine/outputs.ts src/engine/outputs.test.ts
git commit -m "feat: output wrappers — line/band/marker/histogram/barcolor/background/fill"
```

---

### Task 12: Full `evaluate()` orchestration

**Files:**
- Create: `src/engine/engine.ts`
- Test: `src/engine/engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-11
- Produces: `evaluate(source: string, bars: OHLCV[], adapter: DataAdapter, symbolTicker: string, inputOverrides?): Promise<EvaluationResult>` — the top-level public API, consumed by Task 13's render adapter and Task 14's end-to-end test.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/engine/engine.test.ts
import { describe, it, expect } from "vitest";
import { evaluate } from "./engine";
import { InMemoryDataAdapter } from "../adapters/data/in-memory";
import type { OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
}

describe("evaluate", () => {
  it("populates values for every formula, wrapped or not", async () => {
    const result = await evaluate("helper = close * 2\nout = line(helper)", bars([1, 2]), new InMemoryDataAdapter(), "T");
    expect(result.values.helper).toEqual([2, 4]);
    expect(result.values.out).toBeDefined();
  });

  it("populates outputs only for wrapped formulas", async () => {
    const result = await evaluate("helper = close * 2\nout = line(helper)", bars([1, 2]), new InMemoryDataAdapter(), "T");
    expect(Object.keys(result.outputs)).toEqual(["out"]);
  });

  it("resolves inputs, applying overrides", async () => {
    const result = await evaluate(
      "input length = int(14, min=2, max=200)\nout = line(sma(close, input.length))",
      bars([1, 2, 3]), new InMemoryDataAdapter(), "T", { length: 2 },
    );
    expect(result.values.out).toBeDefined();
  });

  it("aggregates diagnostics per (formula, message), not one per bar", async () => {
    const result = await evaluate("out = line(1 / (close - close))", bars([1, 1, 1, 1, 1]), new InMemoryDataAdapter(), "T");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].count).toBe(5);
    expect(result.diagnostics[0].firstBarIndex).toBe(0);
    expect(result.diagnostics[0].lastBarIndex).toBe(4);
  });

  it("resolves a fill() output's referenced names against the already-built outputs", async () => {
    const result = await evaluate(
      "a = line(close)\nb = line(close + 1)\nc = fill(a, b, \"blue\")",
      bars([1]), new InMemoryDataAdapter(), "T",
    );
    expect(result.outputs.c).toEqual({ type: "fill", between: ["a", "b"], color: "blue" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- engine.test`
Expected: FAIL — `Cannot find module './engine'`

- [ ] **Step 3: Write the orchestration**

```typescript
// src/engine/engine.ts
import { parse } from "../parser";
import { InputDecl } from "../ast";
import { evaluateFormulaSeries } from "./evaluator";
import { resolveInputs } from "./inputs";
import { prefetchExternalSeries } from "./prefetch";
import { buildOutput, isOutputWrapper } from "./outputs";
import { DataAdapter, Diagnostic, EvalContext, EvaluationResult, OHLCV } from "./types";

export async function evaluate(
  source: string,
  bars: OHLCV[],
  adapter: DataAdapter,
  symbolTicker: string,
  inputOverrides: Record<string, number | string> = {},
): Promise<EvaluationResult> {
  const program = parse(source);
  const inputDecls = program.filter((s): s is InputDecl => s.kind === "input");
  const inputs = resolveInputs(inputDecls, inputOverrides);
  const { externalSeries, sessionOpen, exchange } = await prefetchExternalSeries(program, bars, adapter, symbolTicker);

  const values: Record<string, (number | boolean)[]> = {};
  const outputs: Record<string, ReturnType<typeof buildOutput> & object> = {} as any;
  const diagCounts = new Map<string, Diagnostic>();

  const completed = new Map<string, (number | boolean)[]>();

  for (const stmt of program) {
    if (stmt.kind !== "formula") continue;
    const ctx: EvalContext = {
      bars, completed, self: [], currentFormula: stmt.name, inputs, externalSeries,
      sessionOpen, exchange, symbolTicker,
      pushDiagnostic: (message: string, barIndex: number) => {
        const key = `${stmt.name}::${message}`;
        const existing = diagCounts.get(key);
        if (existing) { existing.count++; existing.lastBarIndex = barIndex; }
        else diagCounts.set(key, { formula: stmt.name, message, severity: "warning", count: 1, firstBarIndex: barIndex, lastBarIndex: barIndex });
      },
    };
    const series = evaluateFormulaSeries(stmt.expr, ctx);
    values[stmt.name] = series;
    completed.set(stmt.name, series);

    if (isOutputWrapper(stmt.expr)) {
      const output = buildOutput(stmt.name, stmt.expr, bars, ctx);
      if (output) outputs[stmt.name] = output;
    }
  }

  return { outputs, values, diagnostics: [...diagCounts.values()] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- engine.test`
Expected: PASS — 5 tests

Run: `npm test` (full suite)
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts src/engine/engine.test.ts
git commit -m "feat: evaluate() — full orchestration, values/outputs/diagnostics"
```

---

### Task 13: klinecharts render adapter

**Files:**
- Create: `src/adapters/render/klinecharts/adapter.ts`
- Test: `src/adapters/render/klinecharts/adapter.test.ts`

**Interfaces:**
- Consumes: `IndicatorOutput` (Task 3)
- Produces: `renderToKlinecharts(chart: KLineChartLike, name: string, output: IndicatorOutput): void`

Since this project has no runtime dependency on `klinecharts` itself (v1 doesn't want a hard dependency for a library other projects will embed alongside their OWN klinecharts install), define a minimal structural interface matching the real klinecharts `registerIndicator`/figure API, and test against a mock implementing that interface — not a real `klinecharts` instance.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/adapters/render/klinecharts/adapter.test.ts
import { describe, it, expect, vi } from "vitest";
import { renderToKlinecharts } from "./adapter";
import type { IndicatorOutput } from "../../../engine/types";

describe("renderToKlinecharts", () => {
  it("registers a line output as a klinecharts line-type indicator", () => {
    const registerIndicator = vi.fn();
    const chart = { registerIndicator };
    const output: IndicatorOutput = { type: "line", points: [{ time: 0, value: 1 }] };

    renderToKlinecharts(chart as any, "myline", output);

    expect(registerIndicator).toHaveBeenCalledWith(expect.objectContaining({ name: "myline" }));
  });

  it("registers a band output with two figures", () => {
    const registerIndicator = vi.fn();
    const chart = { registerIndicator };
    const output: IndicatorOutput = {
      type: "band",
      upper: [{ time: 0, value: 2 }],
      lower: [{ time: 0, value: 1 }],
    };

    renderToKlinecharts(chart as any, "myband", output);

    const call = registerIndicator.mock.calls[0][0];
    expect(call.figures).toHaveLength(2);
  });

  it("registers a marker output as shape-type figures", () => {
    const registerIndicator = vi.fn();
    const chart = { registerIndicator };
    const output: IndicatorOutput = { type: "marker", points: [{ time: 0, shape: "triangle-up", color: "green" }] };

    renderToKlinecharts(chart as any, "mymarker", output);

    expect(registerIndicator).toHaveBeenCalled();
  });

  it("throws for an output type klinecharts has no direct primitive for, rather than silently dropping it", () => {
    const chart = { registerIndicator: vi.fn() };
    const output: IndicatorOutput = { type: "barcolor", points: [{ time: 0, color: "red" }] };
    // barcolor recolors the candle itself, not a separate indicator pane —
    // v1's adapter documents this as unsupported rather than pretending to draw it.
    expect(() => renderToKlinecharts(chart as any, "x", output)).toThrow(/not yet supported/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- klinecharts`
Expected: FAIL — `Cannot find module './adapter'`

- [ ] **Step 3: Write the adapter**

```typescript
// src/adapters/render/klinecharts/adapter.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- klinecharts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/adapters/render/klinecharts/adapter.ts src/adapters/render/klinecharts/adapter.test.ts
git commit -m "feat: klinecharts render adapter — line/band/histogram/marker/background"
```

---

### Task 14: End-to-end golden test

**Files:**
- Test: `src/e2e.test.ts`
- Modify: `src/index.ts` (public exports)

**Interfaces:**
- Consumes: `evaluate` (Task 12), `spec/examples/trend-regime.dia` (already committed to the repo)

- [ ] **Step 1: Write the failing end-to-end test**

```typescript
// src/e2e.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "./engine/engine";
import { InMemoryDataAdapter } from "./adapters/data/in-memory";
import type { OHLCV } from "./engine/types";

function syntheticBars(n: number, startTime: number, stepSeconds: number): OHLCV[] {
  const bars: OHLCV[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += Math.sin(i / 10) * 2;
    bars.push({ time: startTime + i * stepSeconds, open: price, high: price + 1, low: price - 1, close: price, volume: 1000 });
  }
  return bars;
}

describe("end-to-end: trend-regime.dia", () => {
  it("evaluates the full worked example against synthetic data without throwing", async () => {
    const source = readFileSync(new URL("../spec/examples/trend-regime.dia", import.meta.url), "utf-8");
    const fiveMin = syntheticBars(200, 0, 300);
    const daily = syntheticBars(30, 0, 86400);

    const adapter = new InMemoryDataAdapter();
    adapter.register("TESTSYM", "1d", daily);
    adapter.registerMeta("TESTSYM", "NSE", () => true);

    const result = await evaluate(source, fiveMin, adapter, "TESTSYM");

    expect(result.outputs.fast_line).toBeDefined();
    expect(result.outputs.slow_line).toBeDefined();
    expect(result.outputs.band_out).toBeDefined();
    expect(result.outputs.entry_marker).toBeDefined();
    expect(result.outputs.regime_bg).toBeDefined();
    expect(result.outputs.trend_fill).toEqual({ type: "fill", between: ["fast_line", "slow_line"], color: "#90caf9" });

    expect(result.values.swing_high).toHaveLength(200);
    expect(result.values.entry_long).toHaveLength(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- e2e`
Expected: FAIL — likely a parse or reference error the first time this real example is actually run end-to-end; fix whatever surfaces (this is the first time `trend-regime.dia` has ever actually been parsed/evaluated by real code — expect at least one real bug here, e.g. a missed primitive wiring or an arity mismatch).

- [ ] **Step 3: Write the public exports**

```typescript
// src/index.ts
export { parse, ParseError } from "./parser";
export { evaluate } from "./engine/engine";
export { InMemoryDataAdapter } from "./adapters/data/in-memory";
export { renderToKlinecharts } from "./adapters/render/klinecharts/adapter";
export type { OHLCV, DataAdapter, IndicatorOutput, EvaluationResult, Diagnostic } from "./engine/types";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- e2e`
Expected: PASS. If Step 2 surfaced a real bug, this step is "fix the bug, then confirm pass" — document what was actually wrong in the commit message (this is exactly the kind of thing unit tests in isolation can't catch, and the reason this task exists).

Run: `npm test` (full suite)
Expected: PASS — all tests across all 14 tasks

Run: `npm run build`
Expected: clean TypeScript compile, no errors

- [ ] **Step 5: Commit**

```bash
git add src/e2e.test.ts src/index.ts
git commit -m "test: end-to-end evaluation of the full worked example, public API exports"
```
