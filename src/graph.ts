import type { AggregateReview, FieldNode, FieldReview, ModelGraph } from "./types.js";

const simplifyingDecisions = new Set(["rename", "merge", "derive", "move", "defer", "remove"]);

export function hasSimplification(aggregate: AggregateReview): boolean {
  return aggregate.decisions.some((review) => simplifyingDecisions.has(review.decision));
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
          .filter((decision) => decision.decision === "rename")
          .map((decision) => [decision.fieldPath, finalPathForRename(decision)]),
      );
      const removed = new Set(
        decisions
          .filter((decision) =>
            decision.decision === "remove" || decision.decision === "derive" || decision.decision === "defer"
          )
          .map((decision) => decision.fieldPath),
      );
      return {
        ...model,
        fields: model.fields
          .filter((field) => !isRemoved(field.path, removed))
          .map((field) => applyRenames(field, renameMap)),
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
  if (decision.finalPath) {
    return decision.finalPath;
  }
  const lastDot = decision.fieldPath.lastIndexOf(".");
  const prefix = lastDot === -1 ? "" : decision.fieldPath.slice(0, lastDot + 1);
  return `${prefix}${decision.finalName}`;
}

function applyRenames(field: FieldNode, renameMap: Map<string, string>): FieldNode {
  let nextPath = field.path;
  const mappings = [...renameMap.entries()]
    .filter(([from]) => pathMatches(field.path, from))
    .sort((left, right) => right[0].length - left[0].length);
  for (const [from, to] of mappings) {
    nextPath = replacePathPrefix(nextPath, from, to);
  }
  const segments = nextPath.split(".");
  const nextName = segments[segments.length - 1] ?? field.name;
  return {
    ...field,
    path: nextPath,
    name: nextName,
  };
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
