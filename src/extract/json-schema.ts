import type { FieldNode, ModelNode, SourceSpan } from "../types.js";
import { joinFieldPath } from "../field-path.js";

type JsonSchemaLike = {
  title?: unknown;
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  allOf?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
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
  const rootSchema = asSchema(value);
  const rootRefSchema = typeof rootSchema?.$ref === "string"
    ? resolveRefSchema(value, rootSchema.$ref, new Set())
    : null;
  const rootRequired = Boolean(rootSchema && schemaOrRefAlwaysObject(rootSchema, rootRefSchema, value, new Set()));
  visitSchemaObject(value, modelId, "", fields, source, value, new Set(), rootRequired);
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
  ancestorRequired: boolean,
  inheritedRequired: ReadonlySet<string> = new Set(),
): void {
  const schema = asSchema(value);
  if (typeof schema?.$ref === "string") {
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    if (refSchema) {
      visitSchemaObject(
        refSchema.value,
        modelId,
        parentPath,
        fields,
        source,
        root,
        withRef(refStack, refSchema.ref),
        ancestorRequired,
        inheritedRequired,
      );
    }
    return;
  }
  if (!schema) {
    return;
  }
  if (!isRecord(schema.properties)) {
    if (schema && (hasSchemaType(schema, "array") || "items" in schema)) {
      const rootItemSchema = itemObjectSchema(schema, root, refStack);
      if (!rootItemSchema) {
        if (parentPath === "") {
          const rootArrayNullable = schemaAllowsNull(schema);
          addField(fields, {
            path: "items",
            name: "items",
            type: schemaType(schema.items),
            required: true,
            nullable: rootArrayNullable,
            parent: modelId,
            objectLike: false,
            source,
          });
        }
        visitSchemaCombinators(
          schema,
          modelId,
          parentPath,
          fields,
          source,
          root,
          refStack,
          ancestorRequired,
          inheritedRequired,
        );
        return;
      }
      if (parentPath !== "") {
        visitSchemaObject(
          rootItemSchema.value,
          modelId,
          `${parentPath}[]`,
          fields,
          source,
          root,
          withRef(refStack, rootItemSchema.ref),
          ancestorRequired,
        );
        visitSchemaCombinators(
          schema,
          modelId,
          parentPath,
          fields,
          source,
          root,
          refStack,
          ancestorRequired,
          inheritedRequired,
        );
        return;
      }
      const rootArrayNullable = schemaAllowsNull(schema);
      addField(fields, {
        path: "items",
        name: "items",
        type: schemaType(schema),
        required: true,
        nullable: rootArrayNullable,
        parent: modelId,
        objectLike: true,
        source,
      });
      visitSchemaObject(
        rootItemSchema.value,
        modelId,
        "items[]",
        fields,
        source,
        root,
        withRef(refStack, rootItemSchema.ref),
        !rootArrayNullable,
      );
    }
    visitSchemaCombinators(
      schema,
      modelId,
      parentPath,
      fields,
      source,
      root,
      refStack,
      ancestorRequired,
      inheritedRequired,
    );
    return;
  }

  const required = requiredSetForSchema(schema, inheritedRequired);

  for (const [name, child] of Object.entries(schema.properties)) {
    const childSchema = asSchema(child);
    const refSchema = typeof childSchema?.$ref === "string"
      ? resolveRefSchema(root, childSchema.$ref, refStack)
      : null;
    const path = joinFieldPath(parentPath, name);
    const type = schemaType(childSchema ?? child);
    const fieldRequired = ancestorRequired && required.has(name);
    const fieldNullable = Boolean(childSchema && schemaOrRefAllowsNull(childSchema, refSchema));
    const itemSchema = childSchema ? itemObjectSchema(childSchema, root, refStack) : null;
    const descendantRequired = Boolean(
      fieldRequired && childSchema && schemaAlwaysRequiredNestedContainer(childSchema, refSchema, itemSchema, root, refStack),
    );
    const objectLike = Boolean(childSchema && hasNestedSchema(childSchema, root, refStack));
    addField(fields, {
      path,
      name,
      type,
      required: fieldRequired,
      nullable: fieldNullable,
      parent: modelId,
      objectLike,
      source,
      ...(typeof childSchema?.$ref === "string" ? { ref: childSchema.$ref } : {}),
    });
    if (objectLike) {
      if (refSchema) {
        visitSchemaObject(
          refSchema.value,
          modelId,
          path,
          fields,
          source,
          root,
          withRef(refStack, refSchema.ref),
          descendantRequired,
        );
      } else if (itemSchema) {
        visitSchemaObject(
          itemSchema.value,
          modelId,
          `${path}[]`,
          fields,
          source,
          root,
          withRef(refStack, itemSchema.ref),
          descendantRequired,
        );
      } else {
        visitSchemaObject(child, modelId, path, fields, source, root, refStack, descendantRequired);
      }
    }
  }
  visitSchemaCombinators(
    schema,
    modelId,
    parentPath,
    fields,
    source,
    root,
    refStack,
    ancestorRequired,
    inheritedRequired,
  );
}

function visitSchemaCombinators(
  schema: JsonSchemaLike,
  modelId: string,
  parentPath: string,
  fields: FieldNode[],
  source: SourceSpan,
  root: unknown,
  refStack: Set<string>,
  ancestorRequired: boolean,
  inheritedRequired: ReadonlySet<string>,
): void {
  const allOfRequired = requiredSetForSchema(schema, inheritedRequired);
  for (const value of schemaArray(schema.allOf)) {
    visitSchemaObject(value, modelId, parentPath, fields, source, root, refStack, ancestorRequired, allOfRequired);
  }
  for (const value of [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)]) {
    visitSchemaObject(value, modelId, parentPath, fields, source, root, refStack, false);
  }
}

function requiredSetForSchema(schema: JsonSchemaLike, inheritedRequired: ReadonlySet<string>): Set<string> {
  const required = new Set(inheritedRequired);
  addRequiredNames(required, schema.required);
  for (const branch of schemaArray(schema.allOf)) {
    const branchSchema = asSchema(branch);
    if (branchSchema) {
      addRequiredNames(required, branchSchema.required);
    }
  }
  return required;
}

function addRequiredNames(required: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (typeof item === "string") {
      required.add(item);
    }
  }
}

function schemaArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function addField(fields: FieldNode[], field: FieldNode): void {
  const existing = fields.find((candidate) => candidate.path === field.path);
  if (!existing) {
    fields.push(field);
    return;
  }
  existing.required = existing.required || field.required;
  existing.nullable = existing.nullable || field.nullable;
  existing.objectLike = existing.objectLike || field.objectLike;
  if (!existing.ref && field.ref) {
    existing.ref = field.ref;
  }
}

function itemObjectSchema(schema: JsonSchemaLike, root: unknown, refStack: Set<string>): ResolvedSchema | null {
  const items = schema.items;
  if (hasObjectSchemaShape(items, root, refStack)) {
    return { value: items };
  }
  return null;
}

function hasObjectSchemaShape(value: unknown, root: unknown, refStack: Set<string>): boolean {
  const schema = asSchema(value);
  if (!schema) {
    return false;
  }
  if (typeof schema.$ref === "string") {
    if (refStack.has(schema.$ref)) {
      return true;
    }
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    return Boolean(refSchema && hasObjectSchemaShape(refSchema.value, root, withRef(refStack, refSchema.ref)));
  }
  return (
    hasSchemaType(schema, "object") ||
    isRecord(schema.properties) ||
    schemaArray(schema.allOf).some((item) => hasObjectSchemaShape(item, root, refStack)) ||
    [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)].some((item) =>
      hasObjectSchemaShape(item, root, refStack)
    )
  );
}

function hasNestedSchema(value: unknown, root: unknown, refStack: Set<string>): boolean {
  const schema = asSchema(value);
  if (!schema) {
    return false;
  }
  if (typeof schema.$ref === "string") {
    if (refStack.has(schema.$ref)) {
      return true;
    }
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    return Boolean(refSchema && hasNestedSchema(refSchema.value, root, withRef(refStack, refSchema.ref)));
  }
  return (
    isRecord(schema.properties) ||
    hasSchemaType(schema, "object") ||
    Boolean(itemObjectSchema(schema, root, refStack)) ||
    schemaArray(schema.allOf).some((item) => hasNestedSchema(item, root, refStack)) ||
    [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)].some((item) =>
      hasNestedSchema(item, root, refStack)
    )
  );
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
  if ("items" in schema) {
    return "array";
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

function schemaOrRefAlwaysObject(
  schema: JsonSchemaLike,
  refSchema: ResolvedSchema | null,
  root: unknown,
  refStack: Set<string>,
): boolean {
  if (refSchema) {
    return schemaAlwaysObject(refSchema.value, root, withRef(refStack, refSchema.ref));
  }
  return schemaAlwaysObject(schema, root, refStack);
}

function schemaAlwaysRequiredNestedContainer(
  schema: JsonSchemaLike,
  refSchema: ResolvedSchema | null,
  itemSchema: ResolvedSchema | null,
  root: unknown,
  refStack: Set<string>,
): boolean {
  if (itemSchema) {
    return schemaOrRefAlwaysArray(schema, refSchema, root, refStack) &&
      schemaAlwaysObject(itemSchema.value, root, withRef(refStack, itemSchema.ref));
  }
  if (refSchema) {
    const nestedRefStack = withRef(refStack, refSchema.ref);
    return schemaAlwaysObject(refSchema.value, root, nestedRefStack) ||
      schemaAlwaysArray(refSchema.value, root, nestedRefStack);
  }
  return schemaAlwaysObject(schema, root, refStack);
}

function schemaAlwaysObject(value: unknown, root: unknown, refStack: Set<string>): boolean {
  const schema = asSchema(value);
  if (!schema) {
    return false;
  }
  if (typeof schema.$ref === "string") {
    if (refStack.has(schema.$ref)) {
      return true;
    }
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    return Boolean(refSchema && schemaAlwaysObject(refSchema.value, root, withRef(refStack, refSchema.ref)));
  }
  const types = schemaTypes(schema.type);
  if (types.length > 0) {
    return types.length === 1 && types[0] === "object";
  }
  const allOf = schemaArray(schema.allOf);
  if (allOf.some((candidate) => schemaAlwaysObject(candidate, root, refStack))) {
    return true;
  }
  const alternatives = [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)];
  return alternatives.length > 0 && alternatives.every((candidate) => schemaAlwaysObject(candidate, root, refStack));
}

function schemaOrRefAlwaysArray(
  schema: JsonSchemaLike,
  refSchema: ResolvedSchema | null,
  root: unknown,
  refStack: Set<string>,
): boolean {
  if (refSchema) {
    return schemaAlwaysArray(refSchema.value, root, withRef(refStack, refSchema.ref));
  }
  return schemaAlwaysArray(schema, root, refStack);
}

function schemaAlwaysArray(value: unknown, root: unknown, refStack: Set<string>): boolean {
  const schema = asSchema(value);
  if (!schema) {
    return false;
  }
  if (typeof schema.$ref === "string") {
    if (refStack.has(schema.$ref)) {
      return true;
    }
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    return Boolean(refSchema && schemaAlwaysArray(refSchema.value, root, withRef(refStack, refSchema.ref)));
  }
  const types = schemaTypes(schema.type);
  if (types.length > 0) {
    return types.length === 1 && types[0] === "array";
  }
  const allOf = schemaArray(schema.allOf);
  if (allOf.some((candidate) => schemaAlwaysArray(candidate, root, refStack))) {
    return true;
  }
  const alternatives = [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)];
  return alternatives.length > 0 && alternatives.every((candidate) => schemaAlwaysArray(candidate, root, refStack));
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function schemaAllowsNull(schema: JsonSchemaLike): boolean {
  if (hasSchemaType(schema, "null")) {
    return true;
  }
  const nullableAlternatives = [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)];
  if (nullableAlternatives.some((candidate) => {
    const candidateSchema = asSchema(candidate);
    return Boolean(candidateSchema && schemaAllowsNull(candidateSchema));
  })) {
    return true;
  }
  const allOf = schemaArray(schema.allOf);
  return allOf.length > 0 &&
    allOf.every((candidate) => {
      const candidateSchema = asSchema(candidate);
      return Boolean(candidateSchema && schemaCanAcceptNull(candidateSchema));
    });
}

function schemaCanAcceptNull(schema: JsonSchemaLike): boolean {
  if (hasSchemaType(schema, "null")) {
    return true;
  }
  if (schemaTypes(schema.type).length > 0) {
    return false;
  }
  const alternatives = [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)];
  if (alternatives.length > 0) {
    return alternatives.some((candidate) => {
      const candidateSchema = asSchema(candidate);
      return Boolean(candidateSchema && schemaCanAcceptNull(candidateSchema));
    });
  }
  const allOf = schemaArray(schema.allOf);
  return allOf.length === 0 ||
    allOf.every((candidate) => {
      const candidateSchema = asSchema(candidate);
      return Boolean(candidateSchema && schemaCanAcceptNull(candidateSchema));
    });
}

function schemaOrRefAllowsNull(schema: JsonSchemaLike, refSchema: ResolvedSchema | null): boolean {
  const resolvedSchema = refSchema ? asSchema(refSchema.value) : null;
  return schemaAllowsNull(schema) || Boolean(resolvedSchema && schemaAllowsNull(resolvedSchema));
}

function resolveRefSchema(root: unknown, ref: string, refStack: Set<string>): ResolvedSchema | null {
  if (refStack.has(ref)) {
    return null;
  }
  const value = resolveLocalRef(root, ref);
  const schema = asSchema(value);
  if (!schema) {
    return null;
  }
  return { value, ref };
}

function resolveLocalRef(root: unknown, ref: string): unknown | null {
  if (ref === "#") {
    return root;
  }
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
