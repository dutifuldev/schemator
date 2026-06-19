import type { AggregateReview, ModelGraph } from "./types.js";
import { diffGraphs, renderGraphDiff } from "./diff.js";
import { parentFieldPath } from "./field-path.js";
import { finalPathForDecision, renameMapsByModel } from "./rename.js";

export type ReductionArtifact = {
  changed: boolean;
  applied: Array<{
    decision: "rename" | "remove" | "derive" | "defer";
    model: string;
    fieldPath: string;
    finalPath?: string;
  }>;
  skipped: Array<{
    decision: AggregateReview["decisions"][number]["decision"];
    model: string;
    fieldPath: string;
    reason: "manual" | "no-op" | "frozen-rename" | "rename-conflict" | "removal-conflict" | "low-confidence";
  }>;
};

export type RunReportInput = {
  initialGraph: ModelGraph;
  finalGraph: ModelGraph;
  aggregates: AggregateReview[];
  reductions: ReductionArtifact[];
  stableIteration: number;
  stable: boolean;
};

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
  const renameMaps = renameMapsByModel(aggregate.decisions);
  for (const decision of aggregate.decisions) {
    lines.push(
      `| \`${escapePipe(decision.model)}\` | \`${escapePipe(decision.fieldPath)}\` | ${decision.decision} | \`${escapePipe(finalPathForDecision(decision, renameMaps))}\` | ${decision.confidence} | ${escapePipe(decision.rationale)} |`,
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
    "Schemator favors small, boring, durable field names that describe stable data facts. It challenges metaphorical, vague, redundant, or temporary implementation names while preserving intentional domain and declarative configuration vocabulary.",
  );
  lines.push("");
  return `${lines.join("\n")}`;
}

export function renderRunReport(input: RunReportInput): string {
  const lines: string[] = [];
  const graphDiff = diffGraphs(input.initialGraph, input.finalGraph);
  const applied = input.reductions.flatMap((reduction, index) =>
    reduction.applied.map((decision) => ({ iteration: index + 1, ...decision }))
  );
  const skipped = input.reductions.flatMap((reduction, index) =>
    reduction.skipped.map((decision) => ({ iteration: index + 1, ...decision }))
  );
  const manual = skipped.filter((decision) => decision.reason === "manual");
  const nonManualSkipped = skipped.filter((decision) => decision.reason !== "manual");
  const warnings = consistencyWarnings(input.finalGraph, applied);

  lines.push("# Schemator Data Model Review");
  lines.push("");
  lines.push(`Source: \`${input.initialGraph.source.path}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Stable: ${input.stable ? "yes" : "no"}`);
  lines.push(`- Iterations: ${input.stableIteration}`);
  lines.push(`- Initial fields: ${graphDiff.initialFields}`);
  lines.push(`- Final fields: ${graphDiff.finalFields}`);
  lines.push(`- Applied changes: ${applied.length}`);
  lines.push(`- Skipped proposals: ${nonManualSkipped.length}`);
  lines.push(`- Manual structural proposals: ${manual.length}`);
  lines.push(`- Consistency warnings: ${warnings.length}`);
  lines.push("");

  appendAppliedChanges(lines, applied);
  appendManualProposals(lines, manual, input.aggregates);
  appendSkippedProposals(lines, nonManualSkipped);
  appendConsistencyWarnings(lines, warnings);
  lines.push(renderGraphDiff(graphDiff).trimEnd());
  lines.push("");
  appendFinalGraph(lines, input.finalGraph);
  lines.push("## Lindy Schema Notes");
  lines.push("");
  lines.push(
    "Schemator favors small, boring, durable field names that describe stable data facts. It challenges metaphorical, vague, redundant, or temporary implementation names while preserving intentional domain and declarative configuration vocabulary.",
  );
  lines.push("");
  return lines.join("\n");
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function appendAppliedChanges(
  lines: string[],
  applied: Array<ReductionArtifact["applied"][number] & { iteration: number }>,
): void {
  lines.push("## Applied Changes");
  lines.push("");
  if (applied.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }
  lines.push("| Iteration | Model | Field | Decision | Final path |");
  lines.push("| ---: | --- | --- | --- | --- |");
  for (const decision of applied) {
    lines.push(
      `| ${decision.iteration} | \`${escapePipe(decision.model)}\` | \`${escapePipe(decision.fieldPath)}\` | ${decision.decision} | \`${escapePipe(decision.finalPath ?? decision.fieldPath)}\` |`,
    );
  }
  lines.push("");
}

function appendManualProposals(
  lines: string[],
  manual: Array<ReductionArtifact["skipped"][number] & { iteration: number }>,
  aggregates: AggregateReview[],
): void {
  lines.push("## Manual Structural Proposals");
  lines.push("");
  if (manual.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }
  lines.push("| Iteration | Model | Field | Decision | Proposed final path | Rationale |");
  lines.push("| ---: | --- | --- | --- | --- | --- |");
  for (const proposal of manual) {
    const decision = matchingDecision(aggregates[proposal.iteration - 1], proposal);
    const finalPath = decision ? finalPathForDecision(decision, renameMapsByModel(aggregates[proposal.iteration - 1]?.decisions ?? [])) : proposal.fieldPath;
    lines.push(
      `| ${proposal.iteration} | \`${escapePipe(proposal.model)}\` | \`${escapePipe(proposal.fieldPath)}\` | ${proposal.decision} | \`${escapePipe(finalPath)}\` | ${escapePipe(decision?.rationale ?? "")} |`,
    );
  }
  lines.push("");
}

function appendSkippedProposals(
  lines: string[],
  skipped: Array<ReductionArtifact["skipped"][number] & { iteration: number }>,
): void {
  lines.push("## Skipped Proposals");
  lines.push("");
  if (skipped.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }
  lines.push("| Iteration | Model | Field | Decision | Reason |");
  lines.push("| ---: | --- | --- | --- | --- |");
  for (const proposal of skipped) {
    lines.push(
      `| ${proposal.iteration} | \`${escapePipe(proposal.model)}\` | \`${escapePipe(proposal.fieldPath)}\` | ${proposal.decision} | ${proposal.reason} |`,
    );
  }
  lines.push("");
}

function appendConsistencyWarnings(lines: string[], warnings: string[]): void {
  lines.push("## Consistency Warnings");
  lines.push("");
  if (warnings.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }
  for (const warning of warnings) {
    lines.push(`- ${warning}`);
  }
  lines.push("");
}

function appendFinalGraph(lines: string[], graph: ModelGraph): void {
  lines.push("## Final Simplified Graph");
  lines.push("");
  for (const model of graph.models) {
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
}

function matchingDecision(
  aggregate: AggregateReview | undefined,
  proposal: Pick<ReductionArtifact["skipped"][number], "model" | "fieldPath" | "decision">,
): AggregateReview["decisions"][number] | undefined {
  return aggregate?.decisions.find((decision) =>
    decision.model === proposal.model &&
    decision.fieldPath === proposal.fieldPath &&
    decision.decision === proposal.decision
  );
}

function consistencyWarnings(
  finalGraph: ModelGraph,
  applied: Array<ReductionArtifact["applied"][number] & { iteration: number }>,
): string[] {
  return [
    ...namingDriftWarnings(finalGraph),
    ...removedChildStillInParentTypeWarnings(finalGraph, applied),
  ];
}

function namingDriftWarnings(graph: ModelGraph): string[] {
  const fields = graph.models.flatMap((model) =>
    model.fields.map((field) => ({
      model: model.id,
      path: field.path,
      name: lastPathSegment(field.path),
    }))
  );
  const warnings: string[] = [];
  for (let leftIndex = 0; leftIndex < fields.length; leftIndex += 1) {
    const left = fields[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < fields.length; rightIndex += 1) {
      const right = fields[rightIndex];
      if (!right || left.name === right.name) {
        continue;
      }
      if (normalizedSelectorName(left.name) === normalizedSelectorName(right.name)) {
        warnings.push(
          `Possible naming drift: \`${left.model}.${left.path}\` and \`${right.model}.${right.path}\` use related names \`${left.name}\` / \`${right.name}\`.`,
        );
      }
    }
  }
  return warnings.slice(0, 25);
}

function removedChildStillInParentTypeWarnings(
  graph: ModelGraph,
  applied: Array<ReductionArtifact["applied"][number] & { iteration: number }>,
): string[] {
  const byKey = new Map(
    graph.models.flatMap((model) => model.fields.map((field) => [`${model.id}\u0000${field.path}`, field])),
  );
  const warnings: string[] = [];
  for (const decision of applied) {
    if (decision.decision === "rename") {
      continue;
    }
    const parentPath = parentFieldPath(decision.fieldPath);
    if (!parentPath) {
      continue;
    }
    const parent = byKey.get(`${decision.model}\u0000${parentPath}`);
    const childName = unescapeFieldPathSegment(lastPathSegment(decision.fieldPath));
    if (parent && containsPropertyName(parent.type, childName)) {
      warnings.push(
        `Removed/deferred child \`${decision.model}.${decision.fieldPath}\` still appears in parent type text for \`${decision.model}.${parentPath}\`.`,
      );
    }
  }
  return warnings;
}

function normalizedSelectorName(name: string): string {
  return name
    .replace(/Default$/, "")
    .replace(/Preset$/, "")
    .replace(/Mode$/, "")
    .replace(/Policy$/, "")
    .replace(/Id$/, "");
}

function containsPropertyName(type: string, property: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(property)}[?]?\\s*:`, "u").test(type);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastPathSegment(path: string): string {
  return path.split(".").at(-1)?.replace(/\[\]$/, "") ?? path;
}

function unescapeFieldPathSegment(segment: string): string {
  return segment
    .replace(/~3/g, "]")
    .replace(/~2/g, "[")
    .replace(/~1/g, ".")
    .replace(/~0/g, "~");
}
