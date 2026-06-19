import { replaceLastFieldPathSegment } from "./field-path.js";
import type { AggregateReview, FieldReview } from "./types.js";

export function finalPathForRename(decision: FieldReview): string {
  return replaceLastFieldPathSegment(decision.fieldPath, decision.finalName);
}

export function rawFinalPathForDecision(decision: AggregateReview["decisions"][number]): string {
  return decision.finalPath ?? finalPathForRename(decision);
}

export function renameMapsByModel(
  decisions: AggregateReview["decisions"],
): Map<string, Map<string, string>> {
  const maps = new Map<string, Map<string, string>>();
  for (const decision of decisions) {
    if (decision.decision !== "rename") {
      continue;
    }
    const renameMap = maps.get(decision.model) ?? new Map<string, string>();
    renameMap.set(decision.fieldPath, rawFinalPathForDecision(decision));
    maps.set(decision.model, renameMap);
  }
  return maps;
}

export function finalPathForDecision(
  decision: AggregateReview["decisions"][number],
  renameMaps: Map<string, Map<string, string>>,
): string {
  const renameMap = renameMaps.get(decision.model);
  if (renameMap) {
    return applyRenameMapToPath(decision.fieldPath, renameMap);
  }
  if (decision.decision === "rename") {
    return rawFinalPathForDecision(decision);
  }
  return decision.finalPath ?? decision.fieldPath;
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
