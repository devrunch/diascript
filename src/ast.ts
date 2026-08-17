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
