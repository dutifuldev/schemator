import { extname } from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { readText } from "../files.js";
import { fencedCodeBlocks } from "../markdown.js";
import type { ModelGraph, ModelNode, SourceSpan } from "../types.js";
import { extractJsonSchemaModel } from "./json-schema.js";
import { extractObjectModel, modelIdForObject } from "./object.js";
import { collectTypeScriptObjectModelNames, extractTypeScriptModels } from "./typescript.js";

export async function extractGraph(sourcePath: string): Promise<ModelGraph> {
  const text = await readText(sourcePath);
  const extension = extname(sourcePath).toLowerCase();
  const source: SourceSpan = {
    path: sourcePath,
    span: {
      startLine: 1,
      endLine: text.split(/\r?\n/).length,
    },
  };
  const models =
    extension === ".md"
      ? extractMarkdownModels(text, sourcePath)
      : extractDirectModels(text, sourcePath, extension, source);

  return {
    schemaVersion: 1,
    source: {
      path: sourcePath,
      revision: null,
    },
    models: dedupeModels(models),
  };
}

function extractDirectModels(
  text: string,
  sourcePath: string,
  extension: string,
  source: SourceSpan,
): ModelNode[] {
  if (extension === ".ts" || extension === ".tsx") {
    return extractTypeScriptModels(text, sourcePath, 1);
  }
  if (extension === ".json") {
    const parsed = JSON.parse(text) as unknown;
    return [jsonLikeToModel(parsed, "JsonSchema", source)];
  }
  if (extension === ".yaml" || extension === ".yml") {
    const parsed = parseYaml(text) as unknown;
    return [jsonLikeToModel(parsed, "YamlDocument", source)];
  }
  return [];
}

function extractMarkdownModels(text: string, sourcePath: string): ModelNode[] {
  const models: ModelNode[] = [];
  let jsonIndex = 0;
  let yamlIndex = 0;
  const blocks = fencedCodeBlocks(text);
  const markdownTypeScriptModelNames = new Set<string>();
  for (const block of blocks) {
    if (block.language === "ts" || block.language === "typescript") {
      for (const modelName of collectTypeScriptObjectModelNames(block.code, sourcePath)) {
        markdownTypeScriptModelNames.add(modelName);
      }
    }
  }
  for (const block of blocks) {
    const source: SourceSpan = {
      path: sourcePath,
      span: {
        startLine: block.startLine,
        endLine: block.endLine,
      },
    };
    if (block.language === "ts" || block.language === "typescript") {
      models.push(...extractTypeScriptModels(block.code, sourcePath, block.startLine, markdownTypeScriptModelNames));
      continue;
    }
    if (block.language === "json" || block.language === "jsonc") {
      const parsed = block.language === "jsonc" ? parseJsoncLike(block.code) : parseJsonLike(block.code);
      if (parsed !== null) {
        jsonIndex += 1;
        models.push(jsonLikeToModel(parsed, `JsonBlock${jsonIndex}`, source));
      }
      continue;
    }
    if (block.language === "yaml" || block.language === "yml") {
      const parsed = parseYaml(block.code) as unknown;
      yamlIndex += 1;
      models.push(jsonLikeToModel(parsed, `YamlBlock${yamlIndex}`, source));
    }
  }
  return models.filter((model) => model.fields.length > 0);
}

function jsonLikeToModel(value: unknown, fallbackId: string, source: SourceSpan): ModelNode {
  if (isJsonSchema(value)) {
    const title = value["title"];
    return extractJsonSchemaModel(value, typeof title === "string" ? title : fallbackId, source);
  }
  return extractObjectModel(value, modelIdForObject(value, fallbackId), source);
}

function parseJsonLike(code: string): unknown | null {
  try {
    return JSON.parse(code) as unknown;
  } catch {
    return null;
  }
}

function parseJsoncLike(code: string): unknown | null {
  const parsed = ts.parseConfigFileTextToJson("schema.jsonc", code);
  return parsed.error ? null : parsed.config as unknown;
}

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const hasSchemaMetadata = typeof value["$schema"] === "string" || typeof value["$id"] === "string";
  const hasRootSchemaKeyword =
    typeof value["$ref"] === "string" ||
    isSchemaType(value["type"]) ||
    isRecord(value["$defs"]) ||
    isRecord(value["definitions"]) ||
    Array.isArray(value["allOf"]) ||
    Array.isArray(value["anyOf"]) ||
    Array.isArray(value["oneOf"]);
  const hasSchemaShape =
    hasRootSchemaKeyword ||
    "items" in value;
  const hasOnlySchemaRootKeys = Object.keys(value).every(isSchemaRootKey);
  return (
    (hasSchemaMetadata && hasSchemaShape) ||
    (hasOnlySchemaRootKeys && (hasRootSchemaKeyword || hasSchemaProperties(value["properties"])))
  );
}

function isSchemaRootKey(key: string): boolean {
  return schemaRootKeys.has(key);
}

const schemaRootKeys = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "definitions",
  "description",
  "enum",
  "examples",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

function hasSchemaProperties(value: unknown): boolean {
  return isRecord(value) && Object.values(value).some(isSchemaProperty);
}

function isSchemaProperty(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["$ref"] === "string" ||
    isSchemaType(value["type"]) ||
    isRecord(value["properties"]) ||
    Array.isArray(value["allOf"]) ||
    Array.isArray(value["anyOf"]) ||
    Array.isArray(value["oneOf"]) ||
    "items" in value
  );
}

function isSchemaType(value: unknown): boolean {
  const knownTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
  if (typeof value === "string") {
    return knownTypes.has(value);
  }
  return Array.isArray(value) && value.some((item) => typeof item === "string" && knownTypes.has(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeModels(models: ModelNode[]): ModelNode[] {
  const seen = new Map<string, number>();
  const plans = models.map((model) => {
    const occurrence = (seen.get(model.id) ?? 0) + 1;
    seen.set(model.id, occurrence);
    return {
      model,
      baseId: model.id,
      occurrence,
      dedupedId: occurrence === 1 ? model.id : `${model.id}#${occurrence}`,
    };
  });
  const idsByBase = new Map<string, string[]>();
  for (const plan of plans) {
    const ids = idsByBase.get(plan.baseId) ?? [];
    ids.push(plan.dedupedId);
    idsByBase.set(plan.baseId, ids);
  }
  return plans.map((plan) => ({
    ...plan.model,
    id: plan.dedupedId,
    fields: plan.model.fields.map((field) => {
      const ref = field.ref ? dedupedRef(field.ref, plan.occurrence, idsByBase) : undefined;
      return {
        ...field,
        parent: plan.dedupedId,
        ...(ref ? { ref } : {}),
      };
    }),
  }));
}

function dedupedRef(ref: string, occurrence: number, idsByBase: Map<string, string[]>): string {
  const ids = idsByBase.get(ref);
  if (!ids) {
    return ref;
  }
  return ids[Math.min(occurrence - 1, ids.length - 1)] ?? ref;
}
