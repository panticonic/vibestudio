import { parse } from "acorn";
import { analyze } from "eslint-scope";

export interface RetainedFunctionAnalysis {
  /** Identifiers resolved outside the function expression and all nested scopes. */
  freeNames: string[];
}

type ExpressionProgram = Parameters<typeof analyze>[0] & {
  body: Array<{
    type: string;
    expression?: { type?: string };
  }>;
};

/**
 * Parse exactly one portable function expression and report its lexical
 * dependencies. Object/class method shorthand is deliberately not rewritten:
 * doing so can change `super`, `this`, and private-name semantics.
 */
export function analyzeRetainedFunctionSource(source: string): RetainedFunctionAnalysis {
  let program: ExpressionProgram;
  try {
    program = parse(`(${source}\n)`, {
      ecmaVersion: "latest",
      sourceType: "script",
      ranges: true,
    }) as unknown as ExpressionProgram;
  } catch (error) {
    throw new Error(
      `Retained executable source is not a function expression: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const statement = program.body[0];
  const expressionType =
    statement?.type === "ExpressionStatement" ? statement.expression?.type : null;
  if (
    program.body.length !== 1 ||
    (expressionType !== "FunctionExpression" && expressionType !== "ArrowFunctionExpression")
  ) {
    throw new Error("Retained executable source must contain exactly one function expression");
  }

  const scopeManager = analyze(program, {
    ecmaVersion: 2022,
    sourceType: "script",
    impliedStrict: true,
    optimistic: false,
    ignoreEval: false,
    nodejsScope: false,
  });
  return {
    freeNames: [
      ...new Set(
        (scopeManager.globalScope?.through ?? []).map((reference) => reference.identifier.name)
      ),
    ].sort(),
  };
}
