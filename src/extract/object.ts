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
    const objectLike = isRecord(child);
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
    if (objectLike) {
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
