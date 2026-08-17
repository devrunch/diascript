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
