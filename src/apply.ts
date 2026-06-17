import type { AggregateReview, ModelGraph } from "./types.js";
import { applyRenameMapToPath } from "./graph.js";

export function renderPatchPlan(graph: ModelGraph, aggregate: AggregateReview): string {
  const lines: string[] = [];
  const renameMaps = renameMapsByModel(aggregate);
  lines.push(`# Schemator Simplification Patch Plan`);
  lines.push("");
  lines.push(`Source: ${graph.source.path}`);
  lines.push("");

  const changes = aggregate.decisions.filter((decision) => decision.decision !== "keep" && decision.decision !== "opaque");
  if (changes.length === 0) {
    lines.push("No schema simplifications were proposed.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("This is a source-editing plan, not an auto-applied patch. Apply these changes to the schema source, then rerun `schemator run`.");
  lines.push("");
  for (const decision of changes) {
    lines.push(`## ${decision.model}.${decision.fieldPath}`);
    lines.push("");
    lines.push(`- Decision: ${decision.decision}`);
    lines.push(`- Final path: ${finalPathForDecision(decision, renameMaps)}`);
    lines.push(`- Confidence: ${decision.confidence}`);
    lines.push(`- Rationale: ${decision.rationale}`);
    lines.push("");
    if (decision.decision === "rename") {
      lines.push("Suggested textual replacement:");
      lines.push("");
      lines.push("```diff");
      lines.push(`- ${lastSegment(decision.fieldPath)}${optionalMarker(decision.required)}:`);
      lines.push(`+ ${decision.finalName}${optionalMarker(decision.required)}:`);
      lines.push("```");
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function renameMapsByModel(aggregate: AggregateReview): Map<string, Map<string, string>> {
  const maps = new Map<string, Map<string, string>>();
  for (const decision of aggregate.decisions) {
    if (decision.decision !== "rename") {
      continue;
    }
    const renameMap = maps.get(decision.model) ?? new Map<string, string>();
    renameMap.set(decision.fieldPath, rawFinalPathForRename(decision));
    maps.set(decision.model, renameMap);
  }
  return maps;
}

function finalPathForDecision(
  decision: AggregateReview["decisions"][number],
  renameMaps: Map<string, Map<string, string>>,
): string {
  const renameMap = renameMaps.get(decision.model);
  if (decision.decision === "rename" && renameMap) {
    return applyRenameMapToPath(decision.fieldPath, renameMap);
  }
  return decision.finalPath ?? decision.finalName;
}

function rawFinalPathForRename(decision: AggregateReview["decisions"][number]): string {
  if (decision.finalPath) {
    return decision.finalPath;
  }
  const lastDot = decision.fieldPath.lastIndexOf(".");
  const prefix = lastDot === -1 ? "" : decision.fieldPath.slice(0, lastDot + 1);
  return `${prefix}${decision.finalName}`;
}

function lastSegment(path: string): string {
  return path.split(".").at(-1) ?? path;
}

function optionalMarker(required: boolean): string {
  return required ? "" : "?";
}
