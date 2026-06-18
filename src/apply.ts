import type { AggregateReview, ModelGraph } from "./types.js";
import { replaceLastFieldPathSegment } from "./field-path.js";
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
      lines.push("Suggested rename:");
      lines.push("");
      lines.push(`- From: \`${sourceNameForDecision(graph, decision)}\``);
      lines.push(`- To: \`${decision.finalName}\``);
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
  if (renameMap) {
    return applyRenameMapToPath(decision.fieldPath, renameMap);
  }
  if (decision.decision === "rename") {
    return decision.finalPath ?? rawFinalPathForRename(decision);
  }
  return decision.finalPath ?? decision.fieldPath;
}

function rawFinalPathForRename(decision: AggregateReview["decisions"][number]): string {
  return replaceLastFieldPathSegment(decision.fieldPath, decision.finalName);
}

function sourceNameForDecision(graph: ModelGraph, decision: AggregateReview["decisions"][number]): string {
  const model = graph.models.find((candidate) => candidate.id === decision.model);
  return model?.fields.find((field) => field.path === decision.fieldPath)?.name ?? lastSegment(decision.fieldPath);
}

function lastSegment(path: string): string {
  return path.split(".").at(-1) ?? path;
}
