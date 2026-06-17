import type { FieldNode, ModelNode, SourceSpan } from "../types.js";

type JsonSchemaLike = {
  title?: unknown;
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  $ref?: unknown;
};

type ResolvedSchema = {
  value: unknown;
  ref?: string;
};

export function extractJsonSchemaModel(
  value: unknown,
  modelId: string,
  source: SourceSpan,
): ModelNode {
  const fields: FieldNode[] = [];
  visitSchemaObject(value, modelId, "", fields, source, value, new Set());
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
  refStack: Set<string>,
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
    const refSchema = typeof childSchema?.$ref === "string"
      ? resolveRefSchema(root, childSchema.$ref, refStack)
      : null;
    const path = parentPath ? `${parentPath}.${name}` : name;
    const type = schemaType(childSchema ?? child);
    const itemSchema = childSchema && hasSchemaType(childSchema, "array")
      ? itemObjectSchema(childSchema, root, refStack)
      : null;
    const objectLike =
      Boolean(refSchema) ||
      Boolean(childSchema && hasSchemaType(childSchema, "object")) ||
      isRecord(childSchema?.properties) ||
      Boolean(itemSchema);
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
      if (refSchema) {
        visitSchemaObject(refSchema.value, modelId, path, fields, source, root, withRef(refStack, refSchema.ref));
      } else if (itemSchema) {
        visitSchemaObject(itemSchema.value, modelId, `${path}[]`, fields, source, root, withRef(refStack, itemSchema.ref));
      } else {
        visitSchemaObject(child, modelId, path, fields, source, root, refStack);
      }
    }
  }
}

function itemObjectSchema(schema: JsonSchemaLike, root: unknown, refStack: Set<string>): ResolvedSchema | null {
  const items = schema.items;
  const itemSchema = asSchema(items);
  if (!itemSchema) {
    return null;
  }
  if (typeof itemSchema.$ref === "string") {
    return resolveRefSchema(root, itemSchema.$ref, refStack);
  }
  if (hasSchemaType(itemSchema, "object") || isRecord(itemSchema.properties)) {
    return { value: items };
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

function resolveRefSchema(root: unknown, ref: string, refStack: Set<string>): ResolvedSchema | null {
  if (refStack.has(ref)) {
    return null;
  }
  const value = resolveLocalRef(root, ref);
  const schema = asSchema(value);
  if (!schema || !isRecord(schema.properties)) {
    return null;
  }
  return { value, ref };
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

function withRef(refStack: Set<string>, ref: string | undefined): Set<string> {
  if (!ref) {
    return refStack;
  }
  const next = new Set(refStack);
  next.add(ref);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
