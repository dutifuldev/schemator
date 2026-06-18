import { join } from "node:path";
import type { FieldNode, FieldReview, ModelGraph, ReviewOptions } from "./types.js";
import { pathToFileNamePart, prepareGeneratedOutputDir, writeJson } from "./files.js";

export async function writeDeterministicReviews(
  graph: ModelGraph,
  outputDir: string,
  options: ReviewOptions = { strategy: "local" },
): Promise<FieldReview[]> {
  await prepareGeneratedOutputDir(outputDir, ".review.json");
  const reviews: FieldReview[] = [];
  for (const model of graph.models) {
    for (const field of model.fields) {
      const review = reviewField(model.id, field, options, hasNestedReviewContext(graph, model.id, field));
      reviews.push(review);
      const fileName = `${pathToFileNamePart(model.id)}.${pathToFileNamePart(field.path)}.review.json`;
      await writeJson(join(outputDir, fileName), review);
    }
  }
  return reviews;
}

export function reviewField(
  modelId: string,
  field: FieldNode,
  options: ReviewOptions,
  hasNestedContext = false,
): FieldReview {
  const rule = decisionRule(field, hasNestedContext);
  return {
    schemaVersion: 1,
    model: modelId,
    fieldPath: field.path,
    decision: rule.decision,
    finalName: rule.finalName,
    finalPath: field.path,
    finalType: rule.finalType ?? field.type,
    required: field.required,
    rationale: `${rule.rationale} The ${options.strategy} review is a conservative fallback; semantic rename/remove decisions require a model reviewer with project context.`,
    alternatives: rule.alternatives,
    simplestChoice: rule.simplestChoice,
    confidence: rule.confidence,
    questions: rule.questions,
    ...(rule.ownerBoundary ? { ownerBoundary: rule.ownerBoundary } : {}),
  };
}

type Rule = Pick<
  FieldReview,
  | "decision"
  | "finalName"
  | "rationale"
  | "alternatives"
  | "simplestChoice"
  | "confidence"
  | "questions"
  | "ownerBoundary"
> & {
  finalType?: string;
};

function decisionRule(field: FieldNode, hasNestedContext: boolean): Rule {
  if (field.objectLike && !hasNestedContext) {
    return {
      decision: "opaque",
      finalName: field.name,
      rationale:
        `\`${field.name}\` is object-like but has no extracted child fields, so the reviewer cannot safely simplify inside it.`,
      alternatives: [field.name, "closedFields", "remove"],
      simplestChoice: field.name,
      confidence: "medium",
      questions: [`Can ${field.path} be expanded into closed, named fields?`],
      ownerBoundary: "Unexpanded object boundary.",
    };
  }

  return {
    decision: "keep",
    finalName: field.name,
    rationale:
      `\`${field.name}\` is kept because the fallback reviewer does not make semantic field-specific changes.`,
    alternatives: alternativesFor(field),
    simplestChoice: field.name,
    confidence: "medium",
    questions: [],
  };
}

function alternativesFor(field: FieldNode): string[] {
  if (field.objectLike) {
    return [field.name, "opaque", "remove"];
  }
  return [field.name, "remove"];
}

function hasNestedReviewContext(graph: ModelGraph, modelId: string, field: FieldNode): boolean {
  const model = graph.models.find((candidate) => candidate.id === modelId);
  if (model?.fields.some((candidate) => candidate.path.startsWith(`${field.path}.`))) {
    return true;
  }
  if (model?.fields.some((candidate) => candidate.path.startsWith(`${field.path}[].`))) {
    return true;
  }
  if (field.ref) {
    const referenced = graph.models.find((candidate) => candidate.id === field.ref);
    return Boolean(referenced && referenced.fields.length > 0);
  }
  return false;
}
