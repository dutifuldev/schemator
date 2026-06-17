import type { AggregateReview, ModelGraph } from "./types.js";

export function renderPatchPlan(graph: ModelGraph, aggregate: AggregateReview): string {
  const lines: string[] = [];
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
    lines.push(`- Final path: ${decision.finalPath ?? decision.finalName}`);
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

function lastSegment(path: string): string {
  return path.split(".").at(-1) ?? path;
}

function optionalMarker(required: boolean): string {
  return required ? "" : "?";
}
