import type { FieldNode, ModelNode, SourceSpan } from "../types.js";
import { joinFieldPath } from "../field-path.js";

type ObjectShape = {
  value: Record<string, unknown>;
  optionalPaths: Set<string>;
  nullablePaths: Set<string>;
};

const scalarAlternativeTypes = Symbol("schemator.scalarAlternativeTypes");

type MixedScalarShape = {
  [scalarAlternativeTypes]: Set<string>;
};

export function extractObjectModel(value: unknown, modelId: string, source: SourceSpan): ModelNode {
  const fields: FieldNode[] = [];
  const seenObjects = new WeakSet<object>();
  if (isRecord(value)) {
    visitObject(value, modelId, "", fields, source, new Set(), new Set(), seenObjects);
  } else {
    const arrayItem = arrayObjectShape(value, seenObjects);
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
      visitObject(
        arrayItem.value,
        modelId,
        "items[]",
        fields,
        source,
        prefixPaths(arrayItem.optionalPaths, "items[]"),
        prefixPaths(arrayItem.nullablePaths, "items[]"),
        seenObjects,
      );
    }
  }
  return {
    id: modelId,
    kind: Array.isArray(value) ? "array" : "object",
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
  nullablePaths: Set<string> = new Set(),
  seenObjects: WeakSet<object> = new WeakSet(),
): void {
  if (seenObjects.has(value)) {
    return;
  }
  seenObjects.add(value);
  try {
    for (const [name, child] of Object.entries(value)) {
      const path = joinFieldPath(parentPath, name);
      const arrayItem = arrayObjectShape(child, seenObjects);
      const objectLike = isRecord(child) || Boolean(arrayItem);
      fields.push({
        path,
        name,
        type: valueType(child),
        required: !optionalPaths.has(path),
        nullable: child === null || nullablePaths.has(path),
        parent: modelId,
        objectLike,
        source,
      });
      if (arrayItem) {
        visitObject(
          arrayItem.value,
          modelId,
          `${path}[]`,
          fields,
          source,
          mergePathSets(optionalPaths, prefixPaths(arrayItem.optionalPaths, `${path}[]`)),
          mergePathSets(nullablePaths, prefixPaths(arrayItem.nullablePaths, `${path}[]`)),
          seenObjects,
        );
      } else if (isRecord(child)) {
        visitObject(child, modelId, path, fields, source, optionalPaths, nullablePaths, seenObjects);
      }
    }
  } finally {
    seenObjects.delete(value);
  }
}

function valueType(value: unknown): string {
  const scalarTypes = scalarAlternativesForValue(value);
  if (isPureMixedScalarShape(value)) {
    return [...scalarTypes].sort().join(" | ") || "null";
  }
  const baseType = value === null ? "null" : Array.isArray(value) ? "array" : isRecord(value) ? "object" : typeof value;
  return [...new Set([...scalarTypes, baseType])].sort().join(" | ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isPureMixedScalarShape(value);
}

function arrayObjectShape(value: unknown, seenObjects: WeakSet<object> = new WeakSet()): ObjectShape | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (seenObjects.has(value)) {
    return null;
  }
  seenObjects.add(value);
  try {
    const objects = value.filter(isRecord);
    if (objects.length === 0) {
      return null;
    }
    const shape = objects.reduce<Record<string, unknown>>(
      (shape, item) => mergeObjectShapes(shape, item, seenObjects),
      {},
    );
    const facts = pathFactsForObjects(objects, shape, "", seenObjects);
    const optionalPaths = new Set(facts.optionalPaths);
    if (objects.length !== value.length) {
      for (const path of descendantPaths(shape, "", seenObjects)) {
        optionalPaths.add(path);
      }
    }
    return {
      value: shape,
      optionalPaths,
      nullablePaths: facts.nullablePaths,
    };
  } finally {
    seenObjects.delete(value);
  }
}

function mergeObjectShapes(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  seenObjects: WeakSet<object> = new WeakSet(),
): Record<string, unknown> {
  if (seenObjects.has(right)) {
    return { ...left };
  }
  seenObjects.add(right);
  const merged: Record<string, unknown> = { ...left };
  try {
    for (const [key, value] of Object.entries(right)) {
      merged[key] = key in merged ? mergeShapeValue(merged[key], value, seenObjects) : value;
    }
    return merged;
  } finally {
    seenObjects.delete(right);
  }
}

function mergeShapeValue(left: unknown, right: unknown, seenObjects: WeakSet<object>): unknown {
  const leftScalarTypes = scalarTypesForValue(left);
  const rightScalarTypes = scalarTypesForValue(right);
  if (leftScalarTypes && rightScalarTypes) {
    return mixedScalarShape(new Set([...leftScalarTypes, ...rightScalarTypes]));
  }
  if (isRecord(left) && isRecord(right)) {
    return mergeObjectShapes(left, right, seenObjects);
  }
  if (isRecord(left) && rightScalarTypes) {
    return withScalarAlternatives({ ...left }, rightScalarTypes);
  }
  if (leftScalarTypes && isRecord(right)) {
    return withScalarAlternatives({ ...right }, leftScalarTypes);
  }
  const leftArrayShape = arrayObjectShape(left, seenObjects);
  const rightArrayShape = arrayObjectShape(right, seenObjects);
  if (leftArrayShape && rightArrayShape) {
    return withScalarAlternatives(
      [mergeObjectShapes(leftArrayShape.value, rightArrayShape.value, seenObjects)],
      new Set([...scalarAlternativesForValue(left), ...scalarAlternativesForValue(right)]),
    );
  }
  if (leftArrayShape) {
    return withScalarAlternatives([leftArrayShape.value], rightScalarTypes ?? new Set());
  }
  if (rightArrayShape) {
    return withScalarAlternatives([rightArrayShape.value], leftScalarTypes ?? new Set());
  }
  return isRecord(right) && !isRecord(left) ? right : left;
}

function scalarTypesForValue(value: unknown): Set<string> | null {
  if (isPureMixedScalarShape(value)) {
    return value[scalarAlternativeTypes];
  }
  if (value === null) {
    return new Set();
  }
  if (Array.isArray(value) || isRecord(value)) {
    return null;
  }
  return new Set([typeof value]);
}

function mixedScalarShape(scalarTypes: Set<string>): MixedScalarShape {
  return {
    [scalarAlternativeTypes]: scalarTypes,
  };
}

function withScalarAlternatives<T extends object>(value: T, scalarTypes: Set<string>): T {
  if (scalarTypes.size === 0) {
    return value;
  }
  const existing = scalarAlternativesForValue(value);
  Object.defineProperty(value, scalarAlternativeTypes, {
    configurable: true,
    enumerable: false,
    value: new Set([...existing, ...scalarTypes]),
  });
  return value;
}

function scalarAlternativesForValue(value: unknown): Set<string> {
  return typeof value === "object" && value !== null && scalarAlternativeTypes in value
    ? value[scalarAlternativeTypes as keyof typeof value] as Set<string>
    : new Set();
}

function isPureMixedScalarShape(value: unknown): value is MixedScalarShape {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    scalarAlternativeTypes in value &&
    Object.keys(value).length === 0
  );
}

function pathFactsForObjects(
  objects: Record<string, unknown>[],
  shape: Record<string, unknown>,
  parentPath: string,
  seenObjects: WeakSet<object> = new WeakSet(),
): Pick<ObjectShape, "optionalPaths" | "nullablePaths"> {
  const optionalPaths = new Set<string>();
  const nullablePaths = new Set<string>();
  if (seenObjects.has(shape)) {
    return { optionalPaths, nullablePaths };
  }
  seenObjects.add(shape);
  try {
    for (const [key, value] of Object.entries(shape)) {
      const path = joinFieldPath(parentPath, key);
      const presentValues = objects.filter((object) => key in object).map((object) => object[key]);
      const missingFromSomeObjects = presentValues.length !== objects.length;
      const nullableInSomeObjects = presentValues.some((item) => item === null);
      if (missingFromSomeObjects) {
        optionalPaths.add(path);
        for (const descendant of descendantPaths(value, path, seenObjects)) {
          optionalPaths.add(descendant);
        }
      }
      if (nullableInSomeObjects) {
        nullablePaths.add(path);
      }
      if (isRecord(value)) {
        const recordValues = presentValues.filter(isRecord);
        if (recordValues.length !== presentValues.length) {
          for (const descendant of descendantPaths(value, path, seenObjects)) {
            optionalPaths.add(descendant);
          }
        }
        const nestedFacts = pathFactsForObjects(recordValues, value, path, seenObjects);
        for (const nested of nestedFacts.optionalPaths) {
          optionalPaths.add(nested);
        }
        for (const nested of nestedFacts.nullablePaths) {
          nullablePaths.add(nested);
        }
      }
      const arrayShape = arrayObjectShape(value, seenObjects);
      if (arrayShape) {
        const arrayValues = presentValues.filter(Array.isArray);
        if (arrayValues.length !== presentValues.length) {
          for (const descendant of descendantPaths(arrayShape.value, `${path}[]`, seenObjects)) {
            optionalPaths.add(descendant);
          }
        }
        for (const nested of prefixPaths(arrayShape.optionalPaths, `${path}[]`)) {
          optionalPaths.add(nested);
        }
        for (const nested of prefixPaths(arrayShape.nullablePaths, `${path}[]`)) {
          nullablePaths.add(nested);
        }
      }
    }
    return { optionalPaths, nullablePaths };
  } finally {
    seenObjects.delete(shape);
  }
}

function descendantPaths(value: unknown, parentPath: string, seenObjects: WeakSet<object> = new WeakSet()): Set<string> {
  const paths = new Set<string>();
  if (isRecord(value)) {
    if (seenObjects.has(value)) {
      return paths;
    }
    seenObjects.add(value);
    try {
      for (const [key, child] of Object.entries(value)) {
        const path = joinFieldPath(parentPath, key);
        paths.add(path);
        for (const descendant of descendantPaths(child, path, seenObjects)) {
          paths.add(descendant);
        }
      }
    } finally {
      seenObjects.delete(value);
    }
  }
  const arrayShape = arrayObjectShape(value, seenObjects);
  if (arrayShape) {
    const arrayPath = parentPath ? `${parentPath}[]` : "items[]";
    for (const [key, child] of Object.entries(arrayShape.value)) {
      const path = joinFieldPath(arrayPath, key);
      paths.add(path);
      for (const descendant of descendantPaths(child, path, seenObjects)) {
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
