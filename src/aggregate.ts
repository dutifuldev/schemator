import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./files.js";
import type { AggregateFinding, AggregateReview, Decision, FieldReview, ModelGraph } from "./types.js";

const decisions: Decision[] = [
  "keep",
  "rename",
  "merge",
  "derive",
  "move",
  "defer",
  "remove",
  "opaque",
];

export async function readReviews(reviewDir: string): Promise<FieldReview[]> {
  const entries = await readdir(reviewDir, { withFileTypes: true });
  const reviews: FieldReview[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const value = await readJson(join(reviewDir, entry.name));
    reviews.push(assertFieldReview(value, entry.name));
  }
  return reviews.sort((left, right) =>
    `${left.model}\0${left.fieldPath}`.localeCompare(`${right.model}\0${right.fieldPath}`)
  );
}

export function aggregateReviews(graph: ModelGraph, reviews: FieldReview[]): AggregateReview {
  const findings: AggregateFinding[] = [];
  const reviewByKey = new Map(reviews.map((review) => [reviewKey(review.model, review.fieldPath), review]));
  const fieldKeys = new Set<string>();

  for (const model of graph.models) {
    for (const field of model.fields) {
      const key = reviewKey(model.id, field.path);
      fieldKeys.add(key);
      const review = reviewByKey.get(key);
      if (!review) {
        findings.push({
          severity: "error",
          model: model.id,
          fieldPath: field.path,
          message: "Extracted field is missing a review.",
        });
        continue;
      }
      if (field.objectLike && review.decision !== "opaque" && !hasNestedCoverage(graph, model.id, field.path, field.ref)) {
        findings.push({
          severity: "error",
          model: model.id,
          fieldPath: field.path,
          message: "Object-like field needs nested field reviews or an explicit opaque decision.",
        });
      }
    }
  }

  for (const review of reviews) {
    const key = reviewKey(review.model, review.fieldPath);
    if (!fieldKeys.has(key)) {
      findings.push({
        severity: "error",
        model: review.model,
        fieldPath: review.fieldPath,
        message: "Review references a field that was not extracted.",
      });
    }
  }

  return {
    schemaVersion: 1,
    ok: findings.every((finding) => finding.severity !== "error"),
    summary: summarize(reviews),
    decisions: reviews,
    findings,
  };
}

function hasNestedCoverage(graph: ModelGraph, modelId: string, fieldPath: string, ref: string | undefined): boolean {
  const model = graph.models.find((candidate) => candidate.id === modelId);
  if (model?.fields.some((field) => field.path.startsWith(`${fieldPath}.`))) {
    return true;
  }
  if (model?.fields.some((field) => field.path.startsWith(`${fieldPath}[].`))) {
    return true;
  }
  if (ref) {
    const referenced = graph.models.find((candidate) => candidate.id === ref);
    return Boolean(referenced && referenced.fields.length > 0);
  }
  return false;
}

function summarize(reviews: FieldReview[]): Record<Decision | "totalFields", number> {
  const summary: Record<Decision | "totalFields", number> = {
    totalFields: reviews.length,
    keep: 0,
    rename: 0,
    merge: 0,
    derive: 0,
    move: 0,
    defer: 0,
    remove: 0,
    opaque: 0,
  };
  for (const review of reviews) {
    summary[review.decision] += 1;
  }
  return summary;
}

function reviewKey(model: string, fieldPath: string): string {
  return `${model}\0${fieldPath}`;
}

function assertFieldReview(value: unknown, fileName: string): FieldReview {
  if (!isRecord(value)) {
    throw new Error(`${fileName} is not a JSON object`);
  }
  const decision = value["decision"];
  const confidence = value["confidence"];
  if (!decisions.includes(decision as Decision)) {
    throw new Error(`${fileName} has invalid decision`);
  }
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new Error(`${fileName} has invalid confidence`);
  }
  const alternatives = value["alternatives"];
  const questions = value["questions"];
  return {
    schemaVersion: 1,
    model: requireString(value, "model", fileName),
    fieldPath: requireString(value, "fieldPath", fileName),
    decision: decision as Decision,
    finalName: requireString(value, "finalName", fileName),
    ...(typeof value["finalPath"] === "string" ? { finalPath: value["finalPath"] } : {}),
    finalType: requireString(value, "finalType", fileName),
    required: requireBoolean(value, "required", fileName),
    rationale: requireString(value, "rationale", fileName),
    alternatives: Array.isArray(alternatives)
      ? alternatives.filter((item): item is string => typeof item === "string")
      : [],
    simplestChoice: requireString(value, "simplestChoice", fileName),
    confidence,
    questions: Array.isArray(questions) ? questions.filter((item): item is string => typeof item === "string") : [],
    ...(typeof value["ownerBoundary"] === "string" ? { ownerBoundary: value["ownerBoundary"] } : {}),
  };
}

function requireString(value: Record<string, unknown>, key: string, fileName: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`${fileName} missing string ${key}`);
  }
  return field;
}

function requireBoolean(value: Record<string, unknown>, key: string, fileName: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`${fileName} missing boolean ${key}`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
