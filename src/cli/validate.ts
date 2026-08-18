import { parse, ParseError } from "../index";
import { isOutputWrapper } from "../engine/outputs";

export type ValidateResult =
  | { valid: true; outputType: string }
  | { valid: false; error: { message: string; line?: number; col?: number } };

export function runValidate(source: string, outputName: string): ValidateResult {
  let program;
  try {
    program = parse(source);
  } catch (e) {
    if (e instanceof ParseError) {
      return { valid: false, error: { message: e.message, line: e.line, col: e.col } };
    }
    return { valid: false, error: { message: String(e) } };
  }

  const stmt = program.find((s) => s.kind === "formula" && s.name === outputName);
  if (!stmt || stmt.kind !== "formula" || !isOutputWrapper(stmt.expr)) {
    return {
      valid: false,
      error: { message: `'${outputName}' is not a rendered (wrapped) formula in this diascript source` },
    };
  }
  return { valid: true, outputType: (stmt.expr as { name: string }).name };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf("--output");
  const outputName = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
  if (!outputName) {
    process.stderr.write("Usage: diascript-validate --output <formulaName> < source.dia\n");
    process.exit(2);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const source = Buffer.concat(chunks).toString("utf-8");

  process.stdout.write(JSON.stringify(runValidate(source, outputName)) + "\n");
}

// Only run the CLI body when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
