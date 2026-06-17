import { join } from "node:path";
import type { FieldNode, FieldReview, ModelGraph, ReviewOptions } from "./types.js";
import { pathToFileNamePart, prepareGeneratedOutputDir, writeJson } from "./files.js";

export async function writeDeterministicReviews(
  graph: ModelGraph,
  outputDir: string,
  options: ReviewOptions = { strategy: "lindy" },
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
  const finalPath = rule.finalName === field.name
    ? field.path
    : replaceLastPathSegment(field.path, rule.finalName);
  return {
    schemaVersion: 1,
    model: modelId,
    fieldPath: field.path,
    decision: rule.decision,
    finalName: rule.finalName,
    finalPath,
    finalType: rule.finalType ?? field.type,
    required: field.required,
    rationale: `${rule.rationale} The ${options.strategy} review favors boring, durable names that describe stored facts instead of implementation metaphors.`,
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

  if (field.name === "promptRecipe") {
    return {
      decision: "rename",
      finalName: "systemPromptVariant",
      rationale:
        "`promptRecipe` is too metaphorical and implies arbitrary prompt construction. The field actually selects a closed, code-owned system prompt variant.",
      alternatives: ["systemPromptVariant", "promptContribution", "promptPreset", "remove"],
      simplestChoice: "systemPromptVariant",
      confidence: "high",
      questions: [],
    };
  }

  if (field.name === "recipe") {
    return {
      decision: "rename",
      finalName: "variant",
      rationale:
        "`recipe` is a process metaphor. Data schemas age better when they name the durable stored choice.",
      alternatives: ["variant", "preset", "mode"],
      simplestChoice: "variant",
      confidence: "medium",
      questions: [],
    };
  }

  if (field.name === "config" || field.name === "extra") {
    return {
      decision: "rename",
      finalName: field.name === "config" ? "settings" : "extensions",
      rationale:
        `\`${field.name}\` is a generic bag name. It should be narrowed or removed unless the owner boundary is explicit.`,
      alternatives: ["settings", "extensions", "metadata", "remove"],
      simplestChoice: field.name === "config" ? "settings" : "extensions",
      confidence: "medium",
      questions: [`Can ${field.path} be replaced by closed, named fields?`],
    };
  }

  if (field.name === "extends") {
    return {
      decision: "rename",
      finalName: "baseProfileId",
      rationale:
        "`extends` borrows inheritance vocabulary. `baseProfileId` states the stored relationship and is clearer in JSON data.",
      alternatives: ["baseProfileId", "parentProfileId", "base"],
      simplestChoice: "baseProfileId",
      confidence: "medium",
      questions: [],
    };
  }

  if (field.name === "contextPosture") {
    return {
      decision: "rename",
      finalName: "contextMode",
      rationale:
        "`posture` is policy jargon. `contextMode` is shorter and names the durable selector shape.",
      alternatives: ["contextMode", "contextProfile", "remove"],
      simplestChoice: "contextMode",
      confidence: "medium",
      questions: [],
    };
  }

  if (field.objectLike && field.type === "object" && field.name === "settings") {
    return {
      decision: "keep",
      finalName: field.name,
      rationale:
        "`settings` is acceptable only because nested fields are independently extracted and reviewed; it must not become an untyped escape hatch.",
      alternatives: ["closedSettings", "profileSettings", "remove"],
      simplestChoice: "settings",
      confidence: "medium",
      questions: [],
    };
  }

  return {
    decision: "keep",
    finalName: field.name,
    rationale:
      `\`${field.name}\` is specific enough for the current model and does not obviously duplicate or obscure another field.`,
    alternatives: alternativesFor(field),
    simplestChoice: field.name,
    confidence: "medium",
    questions: [],
  };
}

function alternativesFor(field: FieldNode): string[] {
  if (field.name.endsWith("Id")) {
    return [field.name, field.name.replace(/Id$/, "Ref")];
  }
  if (field.objectLike) {
    return [field.name, `${field.name}Ref`, "remove"];
  }
  return [field.name, "remove"];
}

function replaceLastPathSegment(path: string, finalName: string): string {
  const segments = path.split(".");
  segments[segments.length - 1] = finalName;
  return segments.join(".");
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
