import { parse } from "@babel/parser";
import {
  parseDurableWorkReady,
  type DurableWorkQueue,
} from "../packages/shared/src/durableWork.js";

/** Product executable metadata comes from literal class declarations, never
 * from evaluating an owner or guessing capabilities from its class name. */
export function readDurableWorkDeclaration(
  source: string,
  className: string,
  fileName: string
): DurableWorkQueue[] {
  const file = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "decorators-legacy"],
  });
  const owner = file.program.body
    .map((statement) =>
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    )
    .find(
      (statement) => statement?.type === "ClassDeclaration" && statement.id?.name === className
    );
  const declaration =
    owner?.type === "ClassDeclaration"
      ? owner.body.body.find(
          (member) =>
            member.type === "ClassProperty" &&
            member.static &&
            member.key.type === "Identifier" &&
            member.key.name === "durableWorkQueues"
        )
      : undefined;
  let value = declaration?.type === "ClassProperty" ? declaration.value : undefined;
  if (value?.type === "TSAsExpression") value = value.expression;
  if (
    value?.type !== "ArrayExpression" ||
    value.elements.some((entry) => entry?.type !== "StringLiteral")
  )
    throw new Error(`${fileName}:${className} must declare literal static durableWorkQueues`);
  return parseDurableWorkReady(
    value.elements.map((entry) => (entry?.type === "StringLiteral" ? entry.value : undefined))
  );
}
