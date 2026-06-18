import type { FieldNode, ModelKind, ModelNode, SourceSpan } from "../types.js";
import { joinFieldPath } from "../field-path.js";

type JsonSchemaLike = {
  title?: unknown;
  type?: unknown;
  properties?: unknown;
  patternProperties?: unknown;
  additionalProperties?: unknown;
  required?: unknown;
  items?: unknown;
  prefixItems?: unknown;
  enum?: unknown;
  const?: unknown;
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
  const kind = rootSchema ? schemaOrRefModelKind(rootSchema, rootRefSchema, value, new Set()) : "object";
  visitSchemaObject(value, modelId, "", fields, source, value, new Set(), rootRequired);
  return {
    id: modelId,
    kind,
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
    const siblingSchema = refSiblingSchema(schema);
    if (siblingSchema) {
      visitSchemaObject(
        siblingSchema,
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
    return;
  }
  if (!schema) {
    return;
  }
  if (!isRecord(schema.properties)) {
    addPatternPropertiesFields(
      schema,
      modelId,
      parentPath,
      fields,
      source,
      root,
      refStack,
      ancestorRequired,
    );
    addAdditionalPropertiesFields(
      schema,
      modelId,
      parentPath,
      fields,
      source,
      root,
      refStack,
      ancestorRequired,
    );
    if (schema && (hasSchemaType(schema, "array") || "items" in schema || "prefixItems" in schema)) {
      const rootItemSchemas = itemObjectSchemas(schema, root, refStack);
      if (rootItemSchemas.length === 0) {
        if (parentPath === "") {
          addField(fields, {
            path: "items",
            name: "items",
            type: arrayItemsType(schema),
            required: true,
            nullable: arrayItemsNullable(schema),
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
      const tupleItems = hasTupleItems(schema);
      if (parentPath !== "") {
        visitItemSchemas(rootItemSchemas, modelId, `${parentPath}[]`, fields, source, root, refStack, tupleItems ? false : ancestorRequired);
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
      visitItemSchemas(rootItemSchemas, modelId, "items[]", fields, source, root, refStack, !rootArrayNullable && !tupleItems);
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
    const itemSchemas = childSchema ? itemObjectSchemas(childSchema, root, refStack) : [];
    const itemSchema = childSchema && itemSchemas.length === 1 && !hasTupleItems(childSchema)
      ? itemSchemas[0] ?? null
      : null;
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
          childSchema,
          modelId,
          path,
          fields,
          source,
          root,
          refStack,
          descendantRequired,
        );
      } else if (itemSchemas.length > 0) {
        if (isRecord(childSchema?.properties)) {
          visitSchemaObject(child, modelId, path, fields, source, root, refStack, descendantRequired);
        }
        visitItemSchemas(itemSchemas, modelId, `${path}[]`, fields, source, root, refStack, descendantRequired);
      } else {
        visitSchemaObject(child, modelId, path, fields, source, root, refStack, descendantRequired);
      }
    }
  }
  addPatternPropertiesFields(
    schema,
    modelId,
    parentPath,
    fields,
    source,
    root,
    refStack,
    ancestorRequired,
  );
  addAdditionalPropertiesFields(
    schema,
    modelId,
    parentPath,
    fields,
    source,
    root,
    refStack,
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
}

function addPatternPropertiesFields(
  schema: JsonSchemaLike,
  modelId: string,
  parentPath: string,
  fields: FieldNode[],
  source: SourceSpan,
  root: unknown,
  refStack: Set<string>,
  ancestorRequired: boolean,
): void {
  if (!isRecord(schema.patternProperties)) {
    return;
  }
  const patternParentPath = joinFieldPath(parentPath, "patternProperties");
  for (const [pattern, child] of Object.entries(schema.patternProperties)) {
    const childSchema = asSchema(child);
    if (!childSchema) {
      continue;
    }
    const refSchema = typeof childSchema.$ref === "string"
      ? resolveRefSchema(root, childSchema.$ref, refStack)
      : null;
    const path = joinFieldPath(patternParentPath, pattern);
    const itemSchemas = itemObjectSchemas(childSchema, root, refStack);
    const itemSchema = itemSchemas.length === 1 && !hasTupleItems(childSchema) ? itemSchemas[0] ?? null : null;
    const descendantRequired = Boolean(
      ancestorRequired && schemaAlwaysRequiredNestedContainer(childSchema, refSchema, itemSchema, root, refStack),
    );
    const objectLike = hasNestedSchema(childSchema, root, refStack);
    addField(fields, {
      path,
      name: pattern,
      type: schemaType(childSchema),
      required: ancestorRequired,
      nullable: schemaOrRefAllowsNull(childSchema, refSchema),
      parent: modelId,
      objectLike,
      source,
      ...(typeof childSchema.$ref === "string" ? { ref: childSchema.$ref } : {}),
    });
    if (!objectLike) {
      continue;
    }
    if (refSchema) {
      visitSchemaObject(
        childSchema,
        modelId,
        path,
        fields,
        source,
        root,
        refStack,
        descendantRequired,
      );
    } else if (itemSchemas.length > 0) {
      visitItemSchemas(itemSchemas, modelId, `${path}[]`, fields, source, root, refStack, descendantRequired);
    } else {
      visitSchemaObject(childSchema, modelId, path, fields, source, root, refStack, descendantRequired);
    }
  }
}

function addAdditionalPropertiesFields(
  schema: JsonSchemaLike,
  modelId: string,
  parentPath: string,
  fields: FieldNode[],
  source: SourceSpan,
  root: unknown,
  refStack: Set<string>,
  ancestorRequired: boolean,
): void {
  if (schema.additionalProperties === true || isEmptySchema(schema.additionalProperties)) {
    addField(fields, {
      path: joinFieldPath(parentPath, "additionalProperties"),
      name: "additionalProperties",
      type: "unknown",
      required: ancestorRequired,
      nullable: true,
      parent: modelId,
      objectLike: true,
      source,
    });
    return;
  }
  const childSchema = asSchema(schema.additionalProperties);
  if (!childSchema) {
    return;
  }
  const refSchema = typeof childSchema.$ref === "string"
    ? resolveRefSchema(root, childSchema.$ref, refStack)
    : null;
  const path = joinFieldPath(parentPath, "additionalProperties");
  const itemSchemas = itemObjectSchemas(childSchema, root, refStack);
  const itemSchema = itemSchemas.length === 1 && !hasTupleItems(childSchema) ? itemSchemas[0] ?? null : null;
  const descendantRequired = Boolean(
    ancestorRequired && schemaAlwaysRequiredNestedContainer(childSchema, refSchema, itemSchema, root, refStack),
  );
  const objectLike = hasNestedSchema(childSchema, root, refStack);
  addField(fields, {
    path,
    name: "additionalProperties",
    type: schemaType(childSchema),
    required: ancestorRequired,
    nullable: schemaOrRefAllowsNull(childSchema, refSchema),
    parent: modelId,
    objectLike,
    source,
    ...(typeof childSchema.$ref === "string" ? { ref: childSchema.$ref } : {}),
  });
  if (!objectLike) {
    return;
  }
  if (refSchema) {
    visitSchemaObject(
      childSchema,
      modelId,
      path,
      fields,
      source,
      root,
      refStack,
      descendantRequired,
    );
  } else if (itemSchemas.length > 0) {
    visitItemSchemas(itemSchemas, modelId, `${path}[]`, fields, source, root, refStack, descendantRequired);
  } else {
    visitSchemaObject(childSchema, modelId, path, fields, source, root, refStack, descendantRequired);
  }
}

function isEmptySchema(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
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
  existing.type = mergeType(existing.type, field.type);
  existing.required = existing.required || field.required;
  existing.nullable = existing.nullable || field.nullable;
  existing.objectLike = existing.objectLike || field.objectLike;
  if (!existing.ref && field.ref) {
    existing.ref = field.ref;
  }
}

function mergeType(left: string, right: string): string {
  return uniqueStrings([...left.split(" | "), ...right.split(" | ")]).join(" | ");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function visitItemSchemas(
  itemSchemas: ResolvedSchema[],
  modelId: string,
  parentPath: string,
  fields: FieldNode[],
  source: SourceSpan,
  root: unknown,
  refStack: Set<string>,
  ancestorRequired: boolean,
): void {
  for (const itemSchema of itemSchemas) {
    visitSchemaObject(
      itemSchema.value,
      modelId,
      parentPath,
      fields,
      source,
      root,
      withRef(refStack, itemSchema.ref),
      ancestorRequired,
    );
  }
}

function itemObjectSchemas(schema: JsonSchemaLike, root: unknown, refStack: Set<string>): ResolvedSchema[] {
  const schemas: ResolvedSchema[] = [];
  addItemObjectSchema(schemas, schema.items, root, refStack);
  for (const item of schemaArray(schema.items)) {
    addItemObjectSchema(schemas, item, root, refStack);
  }
  for (const item of schemaArray(schema.prefixItems)) {
    addItemObjectSchema(schemas, item, root, refStack);
  }
  return schemas;
}

function addItemObjectSchema(
  schemas: ResolvedSchema[],
  value: unknown,
  root: unknown,
  refStack: Set<string>,
): void {
  if (hasObjectSchemaShape(value, root, refStack)) {
    schemas.push({ value });
  }
}

function hasObjectSchemaShape(value: unknown, root: unknown, refStack: Set<string>): boolean {
  const schema = asSchema(value);
  if (!schema) {
    return false;
  }
  if (typeof schema.$ref === "string") {
    const siblingSchema = refSiblingSchema(schema);
    const siblingHasObjectShape = siblingSchema ? hasObjectSchemaShape(siblingSchema, root, refStack) : false;
    if (refStack.has(schema.$ref)) {
      return true;
    }
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    return Boolean(
      siblingHasObjectShape ||
        (refSchema && hasObjectSchemaShape(refSchema.value, root, withRef(refStack, refSchema.ref))),
    );
  }
  return (
    hasSchemaType(schema, "object") ||
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties) ||
    itemObjectSchemas(schema, root, refStack).length > 0 ||
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
    const siblingSchema = refSiblingSchema(schema);
    const siblingHasNestedSchema = siblingSchema ? hasNestedSchema(siblingSchema, root, refStack) : false;
    if (refStack.has(schema.$ref)) {
      return true;
    }
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    return Boolean(
      siblingHasNestedSchema ||
        (refSchema && hasNestedSchema(refSchema.value, root, withRef(refStack, refSchema.ref))),
    );
  }
  return (
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties) ||
    hasSchemaType(schema, "object") ||
    itemObjectSchemas(schema, root, refStack).length > 0 ||
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
  if (isRecord(schema.patternProperties)) {
    return "object";
  }
  if ("items" in schema || "prefixItems" in schema) {
    return "array";
  }
  return "unknown";
}

function refSiblingSchema(schema: JsonSchemaLike): JsonSchemaLike | null {
  const siblings = { ...schema };
  delete siblings.$ref;
  return hasSchemaWork(siblings) ? siblings : null;
}

function hasSchemaWork(schema: JsonSchemaLike): boolean {
  return (
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties) ||
    schema.additionalProperties !== undefined ||
    "items" in schema ||
    "prefixItems" in schema ||
    schemaArray(schema.allOf).length > 0 ||
    schemaArray(schema.anyOf).length > 0 ||
    schemaArray(schema.oneOf).length > 0
  );
}

function arrayItemsType(schema: JsonSchemaLike): string {
  if (Array.isArray(schema.items)) {
    return "array";
  }
  if (schema.items !== undefined) {
    return schemaType(schema.items);
  }
  if (Array.isArray(schema.prefixItems)) {
    return "array";
  }
  return "unknown";
}

function arrayItemsNullable(schema: JsonSchemaLike): boolean {
  if (Array.isArray(schema.items)) {
    return schema.items.some(schemaItemAllowsNull);
  }
  if (schema.items !== undefined) {
    return schemaItemAllowsNull(schema.items);
  }
  if (Array.isArray(schema.prefixItems)) {
    return schema.prefixItems.some(schemaItemAllowsNull);
  }
  return false;
}

function schemaItemAllowsNull(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  const schema = asSchema(value);
  return Boolean(schema && schemaAllowsNull(schema));
}

function hasTupleItems(schema: JsonSchemaLike): boolean {
  return Array.isArray(schema.items) || Array.isArray(schema.prefixItems);
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
    const siblingSchema = refSiblingValidationSchema(schema);
    return schemaAlwaysObject(refSchema.value, root, withRef(refStack, refSchema.ref)) ||
      Boolean(siblingSchema && schemaAlwaysObject(siblingSchema, root, refStack));
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
  if (schemaOrRefAllowsNull(schema, refSchema)) {
    return false;
  }
  if (itemSchema) {
    return schemaOrRefAlwaysArray(schema, refSchema, root, refStack) &&
      schemaAlwaysObject(itemSchema.value, root, withRef(refStack, itemSchema.ref));
  }
  if (refSchema) {
    return schemaOrRefAlwaysObject(schema, refSchema, root, refStack) ||
      schemaOrRefAlwaysArray(schema, refSchema, root, refStack);
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
  if (isRecord(schema.properties)) {
    return true;
  }
  if (isRecord(schema.patternProperties)) {
    return true;
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
    const siblingSchema = refSiblingValidationSchema(schema);
    return schemaAlwaysArray(refSchema.value, root, withRef(refStack, refSchema.ref)) ||
      Boolean(siblingSchema && schemaAlwaysArray(siblingSchema, root, refStack));
  }
  return schemaAlwaysArray(schema, root, refStack);
}

function schemaOrRefModelKind(
  schema: JsonSchemaLike,
  refSchema: ResolvedSchema | null,
  root: unknown,
  refStack: Set<string>,
): ModelKind {
  if (refSchema) {
    return schemaModelKind(refSchema.value, root, withRef(refStack, refSchema.ref));
  }
  return schemaModelKind(schema, root, refStack);
}

function schemaModelKind(value: unknown, root: unknown, refStack: Set<string>): ModelKind {
  const schema = asSchema(value);
  if (!schema) {
    return "object";
  }
  if (typeof schema.$ref === "string") {
    if (refStack.has(schema.$ref)) {
      return "object";
    }
    const refSchema = resolveRefSchema(root, schema.$ref, refStack);
    return refSchema ? schemaModelKind(refSchema.value, root, withRef(refStack, refSchema.ref)) : "object";
  }
  if (hasSchemaType(schema, "array") || "items" in schema || "prefixItems" in schema) {
    return "array";
  }
  if (schemaArray(schema.allOf).some((candidate) => schemaModelKind(candidate, root, refStack) === "array")) {
    return "array";
  }
  if ([...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)].some((candidate) =>
    schemaModelKind(candidate, root, refStack) === "array"
  )) {
    return "array";
  }
  return "object";
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
  if ("prefixItems" in schema) {
    return true;
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
  const types = schemaTypes(schema.type);
  if (types.length > 0 && !types.includes("null")) {
    return false;
  }
  if (schema.const !== undefined) {
    return schema.const === null;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(null);
  }
  const nullableAlternatives = [...schemaArray(schema.anyOf), ...schemaArray(schema.oneOf)];
  if (nullableAlternatives.length > 0) {
    return nullableAlternatives.some((candidate) => {
      const candidateSchema = asSchema(candidate);
      return Boolean(candidateSchema && schemaCanAcceptNull(candidateSchema));
    });
  }
  const allOf = schemaArray(schema.allOf);
  if (allOf.length > 0) {
    return allOf.every((candidate) => {
      const candidateSchema = asSchema(candidate);
      return Boolean(candidateSchema && schemaCanAcceptNull(candidateSchema));
    });
  }
  return true;
}

function schemaCanAcceptNull(schema: JsonSchemaLike): boolean {
  const types = schemaTypes(schema.type);
  if (types.length > 0 && !types.includes("null")) {
    return false;
  }
  if (schema.const !== undefined) {
    return schema.const === null;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(null);
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
  if (!resolvedSchema) {
    return schemaAllowsNull(schema);
  }
  const siblingSchema = refSiblingValidationSchema(schema);
  const resolvedAllowsNull = schemaAllowsNull(resolvedSchema);
  return siblingSchema ? resolvedAllowsNull && schemaCanAcceptNull(siblingSchema) : resolvedAllowsNull;
}

function refSiblingValidationSchema(schema: JsonSchemaLike): JsonSchemaLike | null {
  const siblings = { ...schema };
  delete siblings.$ref;
  return hasSchemaValidationWork(siblings) ? siblings : null;
}

function hasSchemaValidationWork(schema: JsonSchemaLike): boolean {
  return (
    schema.type !== undefined ||
    schema.enum !== undefined ||
    schema.const !== undefined ||
    hasSchemaWork(schema)
  );
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
