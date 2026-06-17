import type { AggregateReview, FieldNode, FieldReview, ModelGraph } from "./types.js";

const simplifyingDecisions = new Set(["rename", "merge", "derive", "move", "defer", "remove"]);

export function hasSimplification(aggregate: AggregateReview): boolean {
  return aggregate.decisions.some((review) => review.confidence !== "low" && simplifyingDecisions.has(review.decision));
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

function finalPathForRename(decision: FieldReview): string {
  const finalPath = decision.finalPath ?? finalPathFromName(decision.fieldPath, decision.finalName);
  if (parentPath(finalPath) !== parentPath(decision.fieldPath)) {
    throw new Error(`rename cannot move field ${decision.model}.${decision.fieldPath} to ${finalPath}`);
  }
  return finalPath;
}

function finalPathFromName(fieldPath: string, finalName: string): string {
  const lastDot = fieldPath.lastIndexOf(".");
  const prefix = lastDot === -1 ? "" : fieldPath.slice(0, lastDot + 1);
  return `${prefix}${finalName}`;
}

function parentPath(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.slice(0, lastDot);
}

function applyRenames(field: FieldNode, renameMap: Map<string, string>, renameNames: Map<string, string>): FieldNode {
  const nextPath = applyRenameMapToPath(field.path, renameMap);
  const exactRename = renameMap.get(field.path);
  return {
    ...field,
    path: nextPath,
    name: exactRename ? renameNames.get(field.path) ?? lastPathSegment(exactRename) : field.name,
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
