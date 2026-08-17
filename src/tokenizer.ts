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
