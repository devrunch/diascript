# diascript — Formal Grammar

Companion to [the design spec](specs/2026-08-17-diascript-design.md), which explains *why* the language looks like this. This document is the precise reference: tokens, syntax, keywords, and the semantic rules that make every valid program provably terminating.

## Tokens

```
NUMBER      := digit+ ('.' digit+)?          # 14, 2.5, 0.618 — no hex, no scientific notation
STRING      := '"' char* '"'                 # "NSE", "#2196F3", "triangle-up"
IDENTIFIER  := letter (letter | digit | '_')* # user-chosen formula/input names
COMMENT     := '#' char* newline             # rest of line ignored
```

## Reserved words

Nothing outside this list may be used as a formula or input name — every one of these is a keyword, a primitive, an output wrapper, or a fixed namespace. Shadowing any of them is a parse error, not a warning: a formula named `sma` would make every later use of the real `sma()` ambiguous, and this language has no scoping rules sophisticated enough to disambiguate that safely.

**Declaration keyword:** `input`

**Logical operators:** `and`, `or`, `not`

**Series references:** `open`, `high`, `low`, `close`, `volume`

**Windowed functions:** `sma`, `ema`, `wma`, `stdev`, `highest`, `lowest`, `sum`

**Point-wise math:** `abs`, `min`, `max`

**Time/state:** `ref`, `prev`, `held`

**Cross-resolution:** `series`

**Built-in derived series:** `true_range`, `typical_price`, `rsi`

**Output wrappers:** `line`, `band`, `marker`, `histogram`, `barcolor`, `background`, `fill`

**Namespaces** (fixed, dotted access only — not general property access; `time`/`session`/`symbol`/`input` are the only four, and each only exposes the specific members listed in the design spec): `time`, `session`, `symbol`, `input`

**Input type constructors:** `int`, `float`, `source`, `color`

## Grammar (EBNF)

```ebnf
program        = { statement } ;
statement      = input_decl | formula_decl ;

input_decl     = "input" IDENTIFIER "=" input_type ;
input_type     = "int"   "(" NUMBER [ "," "min" "=" NUMBER ] [ "," "max" "=" NUMBER ] ")"
               | "float" "(" NUMBER [ "," "min" "=" NUMBER ] [ "," "max" "=" NUMBER ] ")"
               | "source" "(" series_ref ")"
               | "color" "(" STRING ")" ;

formula_decl   = IDENTIFIER "=" expression ;

expression     = logical_or ;
logical_or     = logical_and { "or" logical_and } ;
logical_and    = comparison { "and" comparison } ;
comparison     = additive [ ("<" | ">" | "<=" | ">=" | "==" | "!=") additive ] ;
additive       = multiplicative { ("+" | "-") multiplicative } ;
multiplicative = unary { ("*" | "/") unary } ;
unary          = "not" unary | "-" unary | primary ;
primary        = NUMBER
               | STRING
               | series_ref
               | namespaced_ref
               | function_call
               | IDENTIFIER                 (* reference to an earlier formula in this file *)
               | "(" expression ")" ;

series_ref     = "open" | "high" | "low" | "close" | "volume" ;
namespaced_ref = ("time" | "session" | "symbol" | "input") "." IDENTIFIER
                 [ "(" ")" ] ;             (* input.<name> has no parens; time/session/symbol members do *)
function_call  = FUNCTION_NAME "(" [ argument { "," argument } ] ")" ;
argument       = expression | IDENTIFIER "=" expression ;   (* the second form is a named arg, e.g. color=input.band_color *)
```

`FUNCTION_NAME` is any reserved word from *windowed functions*, *point-wise math*, *time/state*, *cross-resolution*, *built-in derived series*, or *output wrappers* above — never a user-chosen identifier. There is no way to call something that isn't on that fixed list; the parser rejects an unrecognized `FUNCTION_NAME` before evaluation is ever reached.

`fill`'s first two arguments are a special case worth calling out explicitly: they must be bare `IDENTIFIER`s naming two earlier `line`/`band`-wrapped formulas in this same file (an ordinary formula-reference `primary`, per the rule above — never a `STRING`), because `fill` needs the two ALREADY-COMPUTED output series, not a new expression to evaluate. Every other function's arguments are ordinary expressions; `fill`'s first two are the one place in the grammar where an argument must resolve to a previously-declared *output*, not just a previously-declared *formula*.

Named-argument keys (`min=`, `max=`, `color=`) are NOT general identifiers subject to the reserved-word rule — each is a fixed parameter name belonging to one specific function's own call signature, not something that could clash with a formula name:
- `int(default, min=…, max=…)` / `float(default, min=…, max=…)` — `min`, `max`
- `band(upper, lower, color=…)`, `marker(condition, shape, color=…)`, `barcolor(condition, colorIfTrue, colorIfFalse)` (positional, no named form), `background(condition, color=…)`, `fill(a, b, color=…)` — `color`

No other named keys exist anywhere in the grammar; a named argument using any key not listed here, for a function that doesn't define it, is a parse error.

## Semantic rules

These are the rules that make every valid program provably `O(bars)` — bounded, terminating, computable up front — without needing a runtime timeout or iteration cap:

1. **Single forward pass, one bar at a time.** Every formula is evaluated once per bar, bar 0 through the last available bar, in that order, every time. There is no other execution order to define.
2. **No forward references.** A formula may only reference an IDENTIFIER declared *earlier* in the same file. This makes a circular dependency a parse-time impossibility, not a runtime one — you cannot construct a cycle if every reference must point strictly backward in declaration order.
3. **Single assignment.** Every name is declared exactly once. There is no reassignment, no mutation of a formula's own definition mid-file. `held()` is the one primitive whose VALUE changes across bars — the FORMULA that computes it is still declared exactly once.
4. **`prev(n)` and `ref(x, n)` are bounded by the finite history that exists, never further.** At bar 0 through bar n-1, a `prev`/`ref` lookback that reaches before the start of history evaluates to `null` for that point (see Error handling in the design spec) rather than wrapping, erroring the whole computation, or blocking.
5. **`held(condition, value)` is exactly one state transition per bar** — check `condition`, either take the new `value` or carry the previous bar's held value forward. No nested `held()` calls change this cost; each one is still one check per bar, independent of every other `held()` in the file.
6. **Windowed functions' cost is the window length**, always a literal number or another already-bounded expression — never a value that could itself be unbounded, because nothing in this grammar can produce an unbounded value in the first place.
7. **Reserved words cannot be redeclared.** Enforced at parse time (see Reserved words above) — this is what keeps primitive names from being shadowed into something the grammar doesn't expect.
8. **Top-level output wrapping is explicit, never inferred.** A formula produces a visible chart output if and only if its top-level expression is one of `line`/`band`/`marker`/`histogram`/`barcolor`/`background`/`fill`. Every other formula is intermediate working state, computed but never rendered.

Together, rules 1–6 are why this language needs no loop construct and no user-defined recursive functions to be useful: every one of the "I need to iterate" cases that came up while designing this (recursive smoothing, arbitrary-duration state, cross-timeframe reads) is covered by a primitive whose own cost is fixed and provable, rather than by giving the author a general iteration construct whose termination the language could never guarantee.

See [`spec/examples/`](../spec/examples/) for a complex worked example exercising every one of these primitives together.
