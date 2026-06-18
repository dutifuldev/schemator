import type { AggregateReview, FieldNode, FieldReview, ModelGraph } from "./types.js";
import { parentFieldPath, replaceLastFieldPathSegment } from "./field-path.js";

const simplifyingDecisions = new Set(["rename", "merge", "derive", "move", "defer", "remove"]);

export function hasSimplification(aggregate: AggregateReview): boolean {
  return aggregate.decisions.some((review) => review.confidence !== "low" && isGraphChangingSimplification(review));
}

export function applyAggregateToGraph(graph: ModelGraph, aggregate: AggregateReview): ModelGraph {
  const decisionsByModel = new Map<string, AggregateReview["decisions"]>();
  for (const decision of aggregate.decisions) {
    const list = decisionsByModel.get(decision.model) ?? [];
    list.push(decision);
    decisionsByModel.set(decision.model, list);
  }

  return {
    ...graph,
    models: graph.models.map((model) => {
      const decisions = decisionsByModel.get(model.id) ?? [];
      const renameMap = new Map(
        decisions
          .filter((decision) => decision.confidence !== "low" && decision.decision === "rename")
          .map((decision) => [decision.fieldPath, finalPathForRename(decision)]),
      );
      const renameNames = new Map(
        decisions
          .filter((decision) => decision.confidence !== "low" && decision.decision === "rename")
          .map((decision) => [decision.fieldPath, decision.finalName]),
      );
      const removed = new Set(
        decisions
          .filter((decision) =>
            decision.confidence !== "low" &&
            (decision.decision === "remove" || decision.decision === "derive" || decision.decision === "defer")
          )
          .map((decision) => decision.fieldPath),
      );
      const fields = model.fields
        .filter((field) => !isRemoved(field.path, removed))
        .map((field) => applyRenames(field, renameMap, renameNames));
      assertUniqueFieldPaths(model.id, fields);
      return {
        ...model,
        fields,
      };
    }),
  };
}

function isRemoved(path: string, removed: Set<string>): boolean {
  for (const removedPath of removed) {
    if (path === removedPath || path.startsWith(`${removedPath}.`) || path.startsWith(`${removedPath}[].`)) {
      return true;
    }
  }
  return false;
}

function isGraphChangingSimplification(review: FieldReview): boolean {
  if (!simplifyingDecisions.has(review.decision)) {
    return false;
  }
  if (review.decision === "rename") {
    return finalPathForRename(review) !== review.fieldPath;
  }
  return true;
}

function finalPathForRename(decision: FieldReview): string {
  const expectedFinalPath = replaceLastFieldPathSegment(decision.fieldPath, decision.finalName);
  const finalPath = decision.finalPath ?? expectedFinalPath;
  if (parentFieldPath(finalPath) !== parentFieldPath(decision.fieldPath)) {
    throw new Error(`rename cannot move field ${decision.model}.${decision.fieldPath} to ${finalPath}`);
  }
  if (finalPath !== expectedFinalPath) {
    throw new Error(`rename finalPath for ${decision.model}.${decision.fieldPath} must match finalName ${decision.finalName}`);
  }
  return finalPath;
}

function applyRenames(field: FieldNode, renameMap: Map<string, string>, renameNames: Map<string, string>): FieldNode {
  const nextPath = applyRenameMapToPath(field.path, renameMap);
  const exactRename = renameMap.get(field.path);
  return {
    ...field,
    path: nextPath,
    name: exactRename ? renameNames.get(field.path) ?? lastPathSegment(exactRename) : field.name,
    type: applyRenameMapToTypeText(field.type, field.path, renameMap, renameNames),
  };
}

export function applyRenameMapToPath(path: string, renameMap: Map<string, string>): string {
  let nextPath = path;
  const mappings = [...renameMap.entries()]
    .filter(([from]) => pathMatches(path, from))
    .sort((left, right) => right[0].length - left[0].length);
  for (const [from, to] of mappings) {
    nextPath = replacePathPrefix(nextPath, from, to);
  }
  return nextPath;
}

function assertUniqueFieldPaths(modelId: string, fields: FieldNode[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.path)) {
      throw new Error(`simplification produced duplicate field path ${modelId}.${field.path}`);
    }
    seen.add(field.path);
  }
}

function pathMatches(path: string, from: string): boolean {
  return path === from || path.startsWith(`${from}.`) || path.startsWith(`${from}[].`);
}

function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) {
    return to;
  }
  if (path.startsWith(`${from}.`) || path.startsWith(`${from}[].`)) {
    return `${to}${path.slice(from.length)}`;
  }
  return path;
}

function lastPathSegment(path: string): string {
  return path.split(".").at(-1) ?? path;
}

function applyRenameMapToTypeText(
  type: string,
  fieldPath: string,
  renameMap: Map<string, string>,
  renameNames: Map<string, string>,
): string {
  let next = type;
  for (const [from, to] of renameMap) {
    if (!isDescendantPath(from, fieldPath)) {
      continue;
    }
    const oldName = unescapeFieldPathSegment(lastPathSegment(from));
    const newName = renameNames.get(from) ?? unescapeFieldPathSegment(lastPathSegment(to));
    next = replaceTypePropertyName(next, oldName, newName);
  }
  return next;
}

function isDescendantPath(path: string, parent: string): boolean {
  return path.startsWith(`${parent}.`) || path.startsWith(`${parent}[].`);
}

function replaceTypePropertyName(type: string, oldName: string, newName: string): string {
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  if (!identifier.test(oldName) || !identifier.test(newName)) {
    return type;
  }
  return type.replace(
    new RegExp(`(^|[\\s{;,])${escapeRegExp(oldName)}(\\??\\s*:)`, "g"),
    `$1${newName}$2`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescapeFieldPathSegment(segment: string): string {
  return segment
    .replace(/~3/g, "]")
    .replace(/~2/g, "[")
    .replace(/~1/g, ".")
    .replace(/~0/g, "~");
}
