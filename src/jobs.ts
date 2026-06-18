import { join } from "node:path";
import { pathToFileNamePart, prepareGeneratedOutputDir, writeText } from "./files.js";
import type { FieldNode, ModelGraph, ModelNode } from "./types.js";

export type FieldPromptOptions = {
  projectContext?: string;
};

export async function writeReviewJobs(
  graph: ModelGraph,
  outputDir: string,
  options: FieldPromptOptions = {},
): Promise<void> {
  await prepareGeneratedOutputDir(outputDir, ".prompt.md");
  for (const model of graph.models) {
    for (const field of model.fields) {
      const fileName = `${pathToFileNamePart(model.id)}.${pathToFileNamePart(field.path)}.prompt.md`;
      await writeText(join(outputDir, fileName), renderFieldPrompt(graph, model, field, options));
    }
  }
}

export function renderFieldPrompt(
  graph: ModelGraph,
  model: ModelNode,
  field: FieldNode,
  options: FieldPromptOptions = {},
): string {
  return [
    "# Schemator Field Review",
    "",
    "You are reviewing exactly one data-model field. Be skeptical. Prefer the smallest Lindy schema: boring names, durable concepts, no metaphors, no generic bags, and no fields without a current use case. Aim for a data model that can remain the same for the next ten or a hundred years.",
    "",
    "Return only valid JSON matching `schemas/field-review.schema.json`.",
    "",
    ...projectContextSection(options.projectContext),
    "## Field Under Review",
    "",
    `- Model: \`${model.id}\``,
    `- Field path: \`${field.path}\``,
    `- Field name: \`${field.name}\``,
    `- Type: \`${field.type}\``,
    `- Required: ${field.required ? "yes" : "no"}`,
    `- Object-like: ${field.objectLike ? "yes" : "no"}`,
    "",
    "## Model Fields",
    "",
    ...model.fields.map((candidate) =>
      `- \`${candidate.path}\`: \`${candidate.type}\`${candidate.required ? "" : " (optional)"}`
    ),
    "",
    "## Full Graph Context",
    "",
    ...graph.models.flatMap(renderGraphModelContext),
    "",
    "## Decision Rules",
    "",
    "- Use `keep` only when the field has earned its place.",
    "- Use `rename` when the concept is valid but the name is not durable.",
    "- When a metaphorical or vague name clearly represents a closed selector, preset, variant, or reference, prefer a durable selector/reference name over `defer`.",
    "- Use `remove`, `derive`, `merge`, or `defer` when that produces a smaller viable model.",
    "- Use `opaque` only with a clear owner boundary.",
    "- Challenge names that are metaphorical, vague, redundant, or tied to a temporary implementation detail.",
    "- Preserve established declarative configuration vocabulary when the project context says that vocabulary is intentional.",
    "",
  ].join("\n");
}

function projectContextSection(projectContext: string | undefined): string[] {
  if (projectContext === undefined || projectContext.trim().length === 0) {
    return [];
  }
  return [
    "## Project And Task Context",
    "",
    projectContext.trimEnd(),
    "",
  ];
}

function renderGraphModelContext(model: ModelNode): string[] {
  if (model.fields.length === 0) {
    return [`- \`${model.id}\`: no fields`];
  }
  return [
    `- \`${model.id}\`:`,
    ...model.fields.map((field) =>
      `  - \`${field.path}\`: \`${field.type}\`${field.required ? "" : " (optional)"}`
    ),
  ];
}
