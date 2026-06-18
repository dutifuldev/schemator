import type { AggregateReview, FieldNode, FieldReview, ModelGraph } from "./types.js";
import { parentFieldPath, replaceLastFieldPathSegment } from "./field-path.js";

const simplifyingDecisions = new Set(["rename", "derive", "defer", "remove"]);

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
      const removed = new Set(
        decisions
          .filter((decision) => isAutoApplicableRemoval(decision, decisions))
          .map((decision) => decision.fieldPath),
      );
      const activeFields = model.fields.filter((field) => !isRemoved(field.path, removed));
      const renameMap = applicableRenameMap(activeFields, decisions);
      const renameNames = applicableRenameNames(decisions, renameMap);
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

function applicableRenameMap(fields: FieldNode[], decisions: AggregateReview["decisions"]): Map<string, string> {
  const renameMap = new Map<string, string>();
  for (const decision of sortedRenameDecisions(decisions)) {
    const candidateMap = new Map(renameMap);
    candidateMap.set(decision.fieldPath, finalPathForRename(decision));
    if (hasUniquePaths(fields.map((field) => applyRenameMapToPath(field.path, candidateMap)))) {
      renameMap.set(decision.fieldPath, finalPathForRename(decision));
    }
  }
  return renameMap;
}

function applicableRenameNames(
  decisions: AggregateReview["decisions"],
  renameMap: Map<string, string>,
): Map<string, string> {
  return new Map(
    decisions
      .filter((decision) => decision.decision === "rename" && renameMap.has(decision.fieldPath))
      .map((decision) => [decision.fieldPath, decision.finalName]),
  );
}

function sortedRenameDecisions(decisions: AggregateReview["decisions"]): FieldReview[] {
  return decisions
    .filter((decision) => decision.confidence !== "low" && decision.decision === "rename")
    .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence));
}

function confidenceRank(confidence: FieldReview["confidence"]): number {
  if (confidence === "high") {
    return 3;
  }
  if (confidence === "medium") {
    return 2;
  }
  return 1;
}

function hasUniquePaths(paths: string[]): boolean {
  return new Set(paths).size === paths.length;
}

function isAutoApplicableRemoval(decision: FieldReview, decisions: AggregateReview["decisions"]): boolean {
  return (
    decision.confidence !== "low" &&
    (decision.decision === "remove" || decision.decision === "derive" || decision.decision === "defer") &&
    !decisions.some((candidate) =>
      candidate.model === decision.model &&
      candidate.fieldPath !== decision.fieldPath &&
      isDescendantPath(candidate.fieldPath, decision.fieldPath) &&
      candidate.decision !== "remove" &&
      candidate.decision !== "derive" &&
      candidate.decision !== "defer"
    )
  );
}

function isRemoved(path: string, removed: Set<string>): boolean {
  for (const removedPath of removed) {
    if (path === removedPath || path.startsWith(`${removedPath}.`) || path.startsWith(`${removedPath}[].`)) {
      return true;
    }
  }
  return false;
}

function isDescendantPath(path: string, parent: string): boolean {
  return path.startsWith(`${parent}.`) || path.startsWith(`${parent}[].`);
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
  return replaceLastFieldPathSegment(decision.fieldPath, decision.finalName);
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
    if (!isDirectTypeChildPath(from, fieldPath)) {
      continue;
    }
    const oldName = unescapeFieldPathSegment(lastPathSegment(from));
    const newName = renameNames.get(from) ?? unescapeFieldPathSegment(lastPathSegment(to));
    next = replaceDirectTypePropertyName(next, oldName, newName);
  }
  return next;
}

function isDirectTypeChildPath(path: string, parent: string): boolean {
  const pathParent = parentFieldPath(path);
  return pathParent === parent || pathParent === `${parent}[]`;
}

function replaceDirectTypePropertyName(type: string, oldName: string, newName: string): string {
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  if (!identifier.test(oldName) || !identifier.test(newName)) {
    return type;
  }
  let next = "";
  let cursor = 0;
  let braceDepth = 0;
  let quote: string | null = null;
  for (let index = 0; index < type.length; index += 1) {
    const char = type[index];
    if (quote) {
      if (char === "\\" && index + 1 < type.length) {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (
      braceDepth === 1 &&
      type.startsWith(oldName, index) &&
      hasPropertyNameBoundaryBefore(type, index) &&
      propertyNameEndIndex(type, index + oldName.length) !== null
    ) {
      next += `${type.slice(cursor, index)}${newName}`;
      index += oldName.length - 1;
      cursor = index + 1;
    }
  }
  return cursor === 0 ? type : `${next}${type.slice(cursor)}`;
}

function hasPropertyNameBoundaryBefore(type: string, index: number): boolean {
  return index === 0 || /[\s{;,]/.test(type[index - 1] ?? "");
}

function propertyNameEndIndex(type: string, index: number): number | null {
  let cursor = index;
  if (type[cursor] === "?") {
    cursor += 1;
  }
  while (/\s/.test(type[cursor] ?? "")) {
    cursor += 1;
  }
  return type[cursor] === ":" ? cursor : null;
}

function unescapeFieldPathSegment(segment: string): string {
  return segment
    .replace(/~3/g, "]")
    .replace(/~2/g, "[")
    .replace(/~1/g, ".")
    .replace(/~0/g, "~");
}
