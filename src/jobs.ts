import { join } from "node:path";
import { pathToFileNamePart, prepareGeneratedOutputDir, writeText } from "./files.js";
import type { FieldNode, ModelGraph, ModelNode } from "./types.js";

export async function writeReviewJobs(graph: ModelGraph, outputDir: string): Promise<void> {
  await prepareGeneratedOutputDir(outputDir, ".prompt.md");
  for (const model of graph.models) {
    for (const field of model.fields) {
      const fileName = `${pathToFileNamePart(model.id)}.${pathToFileNamePart(field.path)}.prompt.md`;
      await writeText(join(outputDir, fileName), renderFieldPrompt(graph, model, field));
    }
  }
}

export function renderFieldPrompt(graph: ModelGraph, model: ModelNode, field: FieldNode): string {
  return [
    "# Schemator Field Review",
    "",
    "You are reviewing exactly one data-model field. Be skeptical. Prefer the smallest Lindy schema: boring names, durable concepts, no metaphors, no generic bags, and no fields without a current use case. Aim for a data model that can remain the same for the next ten or a hundred years.",
    "",
    "Return only valid JSON matching `schemas/field-review.schema.json`.",
    "",
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
    ...graph.models.map((candidate) => `- \`${candidate.id}\`: ${candidate.fields.length} fields`),
    "",
    "## Decision Rules",
    "",
    "- Use `keep` only when the field has earned its place.",
    "- Use `rename` when the concept is valid but the name is not durable.",
    "- Use `remove`, `derive`, `merge`, or `defer` when that produces a smaller viable model.",
    "- Use `opaque` only with a clear owner boundary.",
    "- Challenge `recipe`, `posture`, `extra`, `config`, `payload`, and other vague terms.",
    "",
  ].join("\n");
}
