import type { FieldNode, ModelNode, SourceSpan } from "../types.js";

type ObjectShape = {
  value: Record<string, unknown>;
  optionalPaths: Set<string>;
};

export function extractObjectModel(value: unknown, modelId: string, source: SourceSpan): ModelNode {
  const fields: FieldNode[] = [];
  if (isRecord(value)) {
    visitObject(value, modelId, "", fields, source);
  } else {
    const arrayItem = arrayObjectShape(value);
    if (arrayItem) {
      fields.push({
        path: "items",
        name: "items",
        type: "array",
        required: true,
        nullable: false,
        parent: modelId,
        objectLike: true,
        source,
      });
      visitObject(arrayItem.value, modelId, "items[]", fields, source, prefixPaths(arrayItem.optionalPaths, "items[]"));
    }
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
  optionalPaths: Set<string> = new Set(),
): void {
  for (const [name, child] of Object.entries(value)) {
    const path = parentPath ? `${parentPath}.${name}` : name;
    const arrayItem = arrayObjectShape(child);
    const objectLike = isRecord(child) || Boolean(arrayItem);
    fields.push({
      path,
      name,
      type: valueType(child),
      required: !optionalPaths.has(path),
      nullable: child === null,
      parent: modelId,
      objectLike,
      source,
    });
    if (arrayItem) {
      visitObject(arrayItem.value, modelId, `${path}[]`, fields, source, mergePathSets(optionalPaths, prefixPaths(arrayItem.optionalPaths, `${path}[]`)));
    } else if (isRecord(child)) {
      visitObject(child, modelId, path, fields, source, optionalPaths);
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

function arrayObjectShape(value: unknown): ObjectShape | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const objects = value.filter(isRecord);
  if (objects.length === 0) {
    return null;
  }
  const shape = objects.reduce<Record<string, unknown>>(
    (shape, item) => mergeObjectShapes(shape, item),
    {},
  );
  return {
    value: shape,
    optionalPaths: optionalPathsForObjects(objects, shape, ""),
  };
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
    return [mergeObjectShapes(leftArrayShape.value, rightArrayShape.value)];
  }
  if (leftArrayShape) {
    return [leftArrayShape.value];
  }
  if (rightArrayShape) {
    return [rightArrayShape.value];
  }
  return isRecord(right) && !isRecord(left) ? right : left;
}

function optionalPathsForObjects(
  objects: Record<string, unknown>[],
  shape: Record<string, unknown>,
  parentPath: string,
): Set<string> {
  const optionalPaths = new Set<string>();
  for (const [key, value] of Object.entries(shape)) {
    const path = parentPath ? `${parentPath}.${key}` : key;
    const presentValues = objects.filter((object) => key in object).map((object) => object[key]);
    const missingFromSomeObjects = presentValues.length !== objects.length;
    if (missingFromSomeObjects) {
      optionalPaths.add(path);
      for (const descendant of descendantPaths(value, path)) {
        optionalPaths.add(descendant);
      }
    }
    if (isRecord(value)) {
      for (const nested of optionalPathsForObjects(presentValues.filter(isRecord), value, path)) {
        optionalPaths.add(nested);
      }
    }
    const arrayShape = arrayObjectShape(value);
    if (arrayShape) {
      for (const nested of prefixPaths(arrayShape.optionalPaths, `${path}[]`)) {
        optionalPaths.add(nested);
      }
    }
  }
  return optionalPaths;
}

function descendantPaths(value: unknown, parentPath: string): Set<string> {
  const paths = new Set<string>();
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const path = `${parentPath}.${key}`;
      paths.add(path);
      for (const descendant of descendantPaths(child, path)) {
        paths.add(descendant);
      }
    }
  }
  const arrayShape = arrayObjectShape(value);
  if (arrayShape) {
    const arrayPath = `${parentPath}[]`;
    for (const [key, child] of Object.entries(arrayShape.value)) {
      const path = `${arrayPath}.${key}`;
      paths.add(path);
      for (const descendant of descendantPaths(child, path)) {
        paths.add(descendant);
      }
    }
  }
  return paths;
}

function prefixPaths(paths: Set<string>, prefix: string): Set<string> {
  const prefixed = new Set<string>();
  for (const path of paths) {
    prefixed.add(`${prefix}.${path}`);
  }
  return prefixed;
}

function mergePathSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}
