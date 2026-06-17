import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { aggregateReviews } from "../src/aggregate.js";
import { extractGraph } from "../src/extract/index.js";
import { pathToFileNamePart } from "../src/files.js";
import { applyAggregateToGraph, hasSimplification } from "../src/graph.js";
import { writeDeterministicReviews } from "../src/review.js";
import type { AggregateReview, ModelGraph } from "../src/types.js";

describe("schemator", () => {
  test("extracts nested TypeScript fields from Markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type ModelProfilePolicy = {",
          "  promptRecipe?: \"standard-v1\" | \"gpt-5-v1\";",
          "  nested?: {",
          "    value: string;",
          "  };",
          "};",
          "```",
        ].join("\n"),
      );

      const graph = await extractGraph(source);
      const policy = graph.models.find((model) => model.id === "ModelProfilePolicy");
      expect(policy?.fields.map((field) => field.path)).toEqual([
        "promptRecipe",
        "nested",
        "nested.value",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renames promptRecipe and converges after simplification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type ModelProfilePolicy = {",
          "  promptRecipe?: \"standard-v1\" | \"gpt-5-v1\";",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const reviews = await writeDeterministicReviews(graph, join(dir, "reviews"));
      const aggregate = aggregateReviews(graph, reviews);
      const promptReview = aggregate.decisions.find((review) => review.fieldPath === "promptRecipe");

      expect(promptReview?.decision).toBe("rename");
      expect(promptReview?.finalName).toBe("systemPromptVariant");
      expect(hasSimplification(aggregate)).toBe(true);

      const simplified = applyAggregateToGraph(graph, aggregate);
      const secondReviews = await writeDeterministicReviews(simplified, join(dir, "reviews-2"));
      const secondAggregate = aggregateReviews(simplified, secondReviews);

      expect(
        simplified.models.flatMap((model) => model.fields.map((field) => field.path)),
      ).toContain("systemPromptVariant");
      expect(secondAggregate.decisions.find((review) => review.fieldPath === "systemPromptVariant")?.decision).toBe(
        "keep",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aggregates JSON Schema reviews and keeps nested coverage valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            policy: {
              type: "object",
              properties: {
                promptRecipe: { type: "string" },
              },
            },
          },
          required: ["policy"],
        }),
      );
      const graph = await extractGraph(source);
      const reviews = await writeDeterministicReviews(graph, join(dir, "reviews"));
      const aggregate = aggregateReviews(graph, reviews);

      expect(aggregate.ok).toBe(true);
      expect(aggregate.decisions.some((review) => review.finalName === "systemPromptVariant")).toBe(true);
      await writeFile(join(dir, "aggregate.json"), JSON.stringify(aggregate, null, 2));
      const saved = JSON.parse(await readFile(join(dir, "aggregate.json"), "utf8")) as { ok: boolean };
      expect(saved.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema array item fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses collision-free artifact filename parts", () => {
    expect(pathToFileNamePart("a/b")).not.toBe(pathToFileNamePart("a_b"));
  });

  test("composes parent and child renames", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "object", true),
            field("config.recipe", "recipe", "string", false),
            field("items", "items", "array", true),
            field("items[].recipe", "recipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 4,
        keep: 0,
        rename: 4,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        review("config", "settings"),
        review("config.recipe", "config.variant"),
        review("items", "entries"),
        review("items[].recipe", "items[].variant"),
      ],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((item) => item.path)).toEqual([
      "settings",
      "settings.variant",
      "entries",
      "entries[].variant",
    ]);
  });

  test("extracts TypeScript inline object arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items?: {",
          "    id: string;",
          "    recipe?: string;",
          "  }[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((item) => item.path)).toEqual([
        "items",
        "items[].id",
        "items[].recipe",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function sourceSpan() {
  return {
    path: "schema.json",
    span: { startLine: 1, endLine: 1 },
  };
}

function field(path: string, name: string, type: string, objectLike: boolean) {
  return {
    path,
    name,
    type,
    required: true,
    nullable: false,
    parent: "JsonSchema",
    objectLike,
    source: sourceSpan(),
  };
}

function review(fieldPath: string, finalPath: string) {
  return {
    schemaVersion: 1 as const,
    model: "JsonSchema",
    fieldPath,
    decision: "rename" as const,
    finalName: finalPath.split(".").at(-1)?.replace(/\[\]$/, "") ?? finalPath,
    finalPath,
    finalType: "string",
    required: true,
    rationale: "test",
    alternatives: [finalPath],
    simplestChoice: finalPath,
    confidence: "high" as const,
    questions: [],
  };
}
