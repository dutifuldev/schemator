import type { FieldNode, ModelNode, SourceSpan } from "../types.js";

type JsonSchemaLike = {
  title?: unknown;
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  $ref?: unknown;
};

export function extractJsonSchemaModel(
  value: unknown,
  modelId: string,
  source: SourceSpan,
): ModelNode {
  const fields: FieldNode[] = [];
  visitSchemaObject(value, modelId, "", fields, source, value);
  return {
    id: modelId,
    kind: "object",
    source,
    fields,
  };
}

function visitSchemaObject(
  value: unknown,
  modelId: string,
  parentPath: string,
  fields: FieldNode[],
  source: SourceSpan,
  root: unknown,
): void {
  const schema = asSchema(value);
  if (!schema || !isRecord(schema.properties)) {
    return;
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );

  for (const [name, child] of Object.entries(schema.properties)) {
    const childSchema = asSchema(child);
    const refSchema = typeof childSchema?.$ref === "string" ? resolveLocalRef(root, childSchema.$ref) : null;
    const path = parentPath ? `${parentPath}.${name}` : name;
    const type = schemaType(childSchema ?? child);
    const objectLike =
      Boolean(refSchema && isRecord(asSchema(refSchema)?.properties)) ||
      Boolean(childSchema && hasSchemaType(childSchema, "object")) ||
      isRecord(childSchema?.properties) ||
      Boolean(childSchema && hasSchemaType(childSchema, "array") && itemObjectSchema(childSchema));
    fields.push({
      path,
      name,
      type,
      required: required.has(name),
      nullable: Boolean(childSchema && hasSchemaType(childSchema, "null")),
      parent: modelId,
      objectLike,
      source,
      ...(typeof childSchema?.$ref === "string" ? { ref: childSchema.$ref } : {}),
    });
    if (objectLike) {
      const itemSchema = childSchema && hasSchemaType(childSchema, "array") ? itemObjectSchema(childSchema) : null;
      if (refSchema) {
        visitSchemaObject(refSchema, modelId, path, fields, source, root);
      } else if (itemSchema) {
        visitSchemaObject(itemSchema, modelId, `${path}[]`, fields, source, root);
      } else {
        visitSchemaObject(child, modelId, path, fields, source, root);
      }
    }
  }
}

function itemObjectSchema(schema: JsonSchemaLike): unknown | null {
  const items = schema.items;
  const itemSchema = asSchema(items);
  if (!itemSchema) {
    return null;
  }
  if (hasSchemaType(itemSchema, "object") || isRecord(itemSchema.properties)) {
    return items;
  }
  return null;
}

function schemaType(value: unknown): string {
  const schema = asSchema(value);
  if (!schema) {
    return typeof value;
  }
  if (typeof schema.$ref === "string") {
    return schema.$ref;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter((item): item is string => typeof item === "string").join(" | ");
  }
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (isRecord(schema.properties)) {
    return "object";
  }
  return "unknown";
}

function asSchema(value: unknown): JsonSchemaLike | null {
  return isRecord(value) ? value : null;
}

function hasSchemaType(schema: JsonSchemaLike, type: string): boolean {
  if (schema.type === type) {
    return true;
  }
  return Array.isArray(schema.type) && schema.type.includes(type);
}

function resolveLocalRef(root: unknown, ref: string): unknown | null {
  if (!ref.startsWith("#/")) {
    return null;
  }
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current) || !(segment in current)) {
      return null;
    }
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
