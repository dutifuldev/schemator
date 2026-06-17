import type { FieldNode, ModelNode, SourceSpan } from "../types.js";

export function extractObjectModel(value: unknown, modelId: string, source: SourceSpan): ModelNode {
  const fields: FieldNode[] = [];
  if (isRecord(value)) {
    visitObject(value, modelId, "", fields, source);
  }
  return {
    id: modelId,
    kind: "object",
    source,
    fields,
  };
}

export function modelIdForObject(value: unknown, fallback: string): string {
  if (!isRecord(value)) {
    return fallback;
  }
  const id = value["id"];
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  const kind = value["kind"];
  const metadata = value["metadata"];
  if (typeof kind === "string" && isRecord(metadata)) {
    const namespace = metadata["namespace"];
    const name = metadata["name"];
    if (typeof name === "string" && name.length > 0) {
      return typeof namespace === "string" && namespace.length > 0
        ? `${kind}:${namespace}/${name}`
        : `${kind}:${name}`;
    }
  }
  return fallback;
}

function visitObject(
  value: Record<string, unknown>,
  modelId: string,
  parentPath: string,
  fields: FieldNode[],
  source: SourceSpan,
): void {
  for (const [name, child] of Object.entries(value)) {
    const path = parentPath ? `${parentPath}.${name}` : name;
    const arrayItem = arrayObjectShape(child);
    const objectLike = isRecord(child) || Boolean(arrayItem);
    fields.push({
      path,
      name,
      type: valueType(child),
      required: true,
      nullable: child === null,
      parent: modelId,
      objectLike,
      source,
    });
    if (arrayItem) {
      visitObject(arrayItem, modelId, `${path}[]`, fields, source);
    } else if (isRecord(child)) {
      visitObject(child, modelId, path, fields, source);
    }
  }
}

function valueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isRecord(value)) {
    return "object";
  }
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayObjectShape(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const objects = value.filter(isRecord);
  if (objects.length === 0) {
    return null;
  }
  return objects.reduce<Record<string, unknown>>(
    (shape, item) => mergeObjectShapes(shape, item),
    {},
  );
}

function mergeObjectShapes(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = key in merged ? mergeShapeValue(merged[key], value) : value;
  }
  return merged;
}

function mergeShapeValue(left: unknown, right: unknown): unknown {
  if (isRecord(left) && isRecord(right)) {
    return mergeObjectShapes(left, right);
  }
  const leftArrayShape = arrayObjectShape(left);
  const rightArrayShape = arrayObjectShape(right);
  if (leftArrayShape && rightArrayShape) {
    return [mergeObjectShapes(leftArrayShape, rightArrayShape)];
  }
  if (leftArrayShape) {
    return [leftArrayShape];
  }
  if (rightArrayShape) {
    return [rightArrayShape];
  }
  return isRecord(right) && !isRecord(left) ? right : left;
}
