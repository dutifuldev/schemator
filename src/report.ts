import type { AggregateReview, ModelGraph } from "./types.js";

export function renderReport(graph: ModelGraph, aggregate: AggregateReview, finalGraph?: ModelGraph): string {
  const lines: string[] = [];
  lines.push("# Schemator Data Model Review");
  lines.push("");
  lines.push(`Source: \`${graph.source.path}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Fields reviewed: ${aggregate.summary.totalFields}`);
  lines.push(`- Kept: ${aggregate.summary.keep}`);
  lines.push(`- Renamed: ${aggregate.summary.rename}`);
  lines.push(`- Removed: ${aggregate.summary.remove}`);
  lines.push(`- Deferred: ${aggregate.summary.defer}`);
  lines.push(`- Derived instead of stored: ${aggregate.summary.derive}`);
  lines.push(`- Merged: ${aggregate.summary.merge}`);
  lines.push(`- Moved: ${aggregate.summary.move}`);
  lines.push(`- Opaque: ${aggregate.summary.opaque}`);
  lines.push(`- Coverage valid: ${aggregate.ok ? "yes" : "no"}`);
  lines.push("");

  if (aggregate.findings.length > 0) {
    lines.push("## Findings");
    lines.push("");
    for (const finding of aggregate.findings) {
      const target = finding.model ? ` ${finding.model}${finding.fieldPath ? `.${finding.fieldPath}` : ""}` : "";
      lines.push(`- ${finding.severity.toUpperCase()}${target}: ${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## Simplification Decisions");
  lines.push("");
  lines.push("| Model | Field | Decision | Final path | Confidence | Rationale |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const decision of aggregate.decisions) {
    lines.push(
      `| \`${escapePipe(decision.model)}\` | \`${escapePipe(decision.fieldPath)}\` | ${decision.decision} | \`${escapePipe(decision.finalPath ?? decision.finalName)}\` | ${decision.confidence} | ${escapePipe(decision.rationale)} |`,
    );
  }
  lines.push("");

  const graphForSchema = finalGraph ?? graph;
  lines.push("## Final Simplified Graph");
  lines.push("");
  for (const model of graphForSchema.models) {
    lines.push(`### ${model.id}`);
    lines.push("");
    if (model.fields.length === 0) {
      lines.push("_No fields._");
      lines.push("");
      continue;
    }
    lines.push("| Field | Type | Required | Object-like |");
    lines.push("| --- | --- | --- | --- |");
    for (const field of model.fields) {
      lines.push(
        `| \`${escapePipe(field.path)}\` | \`${escapePipe(field.type)}\` | ${field.required ? "yes" : "no"} | ${field.objectLike ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Lindy Schema Notes");
  lines.push("");
  lines.push(
    "Schemator favors small, boring, durable field names that describe stable data facts. Metaphors such as `recipe`, generic bags such as `extra`, and policy jargon such as `posture` are challenged because they tend to age poorly.",
  );
  lines.push("");
  return `${lines.join("\n")}`;
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
