import type { AnySchema, ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import aggregateSchema from "../schemas/aggregate-review.schema.json" with { type: "json" };
import fieldReviewSchema from "../schemas/field-review.schema.json" with { type: "json" };
import modelGraphSchema from "../schemas/model-graph.schema.json" with { type: "json" };

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export function validateModelGraph(value: unknown): ValidationResult {
  return validateWithSchema(modelGraphSchema, value);
}

export function validateFieldReview(value: unknown): ValidationResult {
  return validateWithSchema(fieldReviewSchema, value);
}

export function validateAggregateReview(value: unknown): ValidationResult {
  return validateWithSchema(aggregateSchema, value);
}

function validateWithSchema(schema: unknown, value: unknown): ValidationResult {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(fieldReviewSchema);
  const validate = ajv.compile(schema as AnySchema);
  const result = validate(value);
  if (typeof result !== "boolean") {
    throw new Error("async JSON Schema validation is not supported");
  }
  const ok = result;
  return {
    ok,
    errors: ok
      ? []
      : (validate.errors ?? []).map((error: ErrorObject) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
      ),
  };
}
