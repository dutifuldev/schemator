import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "../files.js";
import { fencedCodeBlocks } from "../markdown.js";
import type { ModelGraph, ModelNode, SourceSpan } from "../types.js";
import { extractJsonSchemaModel } from "./json-schema.js";
import { extractObjectModel, modelIdForObject } from "./object.js";
import { extractTypeScriptModels } from "./typescript.js";

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
    return [extractObjectModel(parsed, modelIdForObject(parsed, "YamlDocument"), source)];
  }
  return [];
}

function extractMarkdownModels(text: string, sourcePath: string): ModelNode[] {
  const models: ModelNode[] = [];
  let jsonIndex = 0;
  let yamlIndex = 0;
  for (const block of fencedCodeBlocks(text)) {
    const source: SourceSpan = {
      path: sourcePath,
      span: {
        startLine: block.startLine,
        endLine: block.endLine,
      },
    };
    if (block.language === "ts" || block.language === "typescript") {
      models.push(...extractTypeScriptModels(block.code, sourcePath, block.startLine));
      continue;
    }
    if (block.language === "json" || block.language === "jsonc") {
      const parsed = parseJsonLike(block.code);
      if (parsed !== null) {
        jsonIndex += 1;
        models.push(jsonLikeToModel(parsed, `JsonBlock${jsonIndex}`, source));
      }
      continue;
    }
    if (block.language === "yaml" || block.language === "yml") {
      const parsed = parseYaml(block.code) as unknown;
      yamlIndex += 1;
      models.push(extractObjectModel(parsed, modelIdForObject(parsed, `YamlBlock${yamlIndex}`), source));
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

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (isRecord(value["properties"]) || value["$schema"] !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeModels(models: ModelNode[]): ModelNode[] {
  const seen = new Map<string, number>();
  return models.map((model) => {
    const count = seen.get(model.id) ?? 0;
    seen.set(model.id, count + 1);
    if (count === 0) {
      return model;
    }
    return {
      ...model,
      id: `${model.id}#${count + 1}`,
      fields: model.fields.map((field) => ({
        ...field,
        parent: `${model.id}#${count + 1}`,
      })),
    };
  });
}
