import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { aggregateReviews } from "../src/aggregate.js";
import { renderPatchPlan } from "../src/apply.js";
import { writeCodexReviews } from "../src/codex-review.js";
import { extractGraph } from "../src/extract/index.js";
import { pathToFileNamePart } from "../src/files.js";
import { applyAggregateToGraph, hasSimplification } from "../src/graph.js";
import { writeReviewJobs } from "../src/jobs.js";
import { renderReport } from "../src/report.js";
import { writeDeterministicReviews } from "../src/review.js";
import type { AggregateReview, ModelGraph } from "../src/types.js";

const execFileAsync = promisify(execFile);

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

  test("extracts indented Markdown fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "- model",
          "  ```ts",
          "  type ModelProfilePolicy = {",
          "    promptRecipe?: string;",
          "  };",
          "  ```",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
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

  test("runs codex review strategy through one external reviewer per field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakeCodex = join(dir, "fake-codex.js");
      const reviewsDir = join(dir, "reviews");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "let prompt = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { prompt += chunk; });",
          "process.stdin.on('end', () => {",
          "  const model = /- Model: `([^`]+)`/.exec(prompt)?.[1] ?? 'Unknown';",
          "  const fieldPath = /- Field path: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';",
          "  const fieldName = /- Field name: `([^`]+)`/.exec(prompt)?.[1] ?? fieldPath;",
          "  const finalName = fieldName === 'promptRecipe' ? 'systemPromptVariant' : fieldName;",
          "  console.log(JSON.stringify({",
          "    schemaVersion: 1,",
          "    model,",
          "    fieldPath,",
          "    decision: finalName === fieldName ? 'keep' : 'rename',",
          "    finalName,",
          "    finalPath: null,",
          "    finalType: 'string',",
          "    required: false,",
          "    rationale: 'Fake reviewer received the Lindy field prompt.',",
          "    alternatives: [finalName, 'remove'],",
          "    simplestChoice: finalName,",
          "    confidence: 'high',",
          "    questions: [],",
          "    ownerBoundary: null",
          "  }));",
          "});",
        ].join("\n"),
      );
      await chmod(fakeCodex, 0o755);
      const graph: ModelGraph = {
        schemaVersion: 1,
        source: { path: "schema.ts", revision: null },
        models: [
          {
            id: "Policy",
            kind: "object",
            source: { path: "schema.ts", span: { startLine: 1, endLine: 3 } },
            fields: [
              {
                path: "promptRecipe",
                name: "promptRecipe",
                type: "string",
                required: false,
                nullable: false,
                parent: "Policy",
                objectLike: false,
                source: { path: "schema.ts", span: { startLine: 2, endLine: 2 } },
              },
            ],
          },
        ],
      };

      const reviews = await writeCodexReviews(graph, reviewsDir, { command: fakeCodex, timeoutMs: 5_000 });
      const reviewFiles = await readdirFileNames(reviewsDir);

      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.decision).toBe("rename");
      expect(reviews[0]?.finalName).toBe("systemPromptVariant");
      expect(reviews[0]).not.toHaveProperty("ownerBoundary");
      expect(reviewFiles).toHaveLength(1);
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

  test("keeps generated reviews valid for empty object leaves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          settings: {},
        }),
      );
      const graph = await extractGraph(source);
      const reviews = await writeDeterministicReviews(graph, join(dir, "reviews"));
      const aggregate = aggregateReviews(graph, reviews);

      expect(aggregate.ok).toBe(true);
      expect(aggregate.decisions.find((review) => review.fieldPath === "settings")?.decision).toBe("opaque");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects opaque reviews without owner boundaries", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("settings", "settings", "object", true)],
        },
      ],
    };
    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("settings", "settings"),
        decision: "opaque",
      },
    ]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain(
      "Opaque review decisions require an ownerBoundary.",
    );
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

  test("propagates optional JSON Schema parents to nested required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "string" },
                },
                required: ["value"],
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["config", false],
        ["config.id", false],
        ["entries", false],
        ["entries[].value", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable JSON Schema parents to nested required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              type: ["object", "null"],
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          },
          required: ["config"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["config", true, true],
        ["config.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema array item fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts primitive root JSON Schema array items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "array",
          items: {
            type: "string",
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike])).toEqual([
        ["items", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level JSON Schema refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $ref: "#/$defs/Profile",
          $defs: {
            Profile: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema combinator object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          allOf: [
            {
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          ],
          anyOf: [
            {
              properties: {
                promptRecipe: { type: "string" },
              },
              required: ["promptRecipe"],
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["id", true],
        ["promptRecipe", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema child combinator object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              allOf: [
                {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                  },
                  required: ["id"],
                },
              ],
            },
          },
          required: ["config"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike, field.required])).toEqual([
        ["config", true, true],
        ["config.id", false, true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects YAML JSON Schema documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.yaml");
      await writeFile(
        source,
        [
          "type: object",
          "properties:",
          "  promptRecipe:",
          "    type: string",
          "required:",
          "  - promptRecipe",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
      expect(graph.models[0]?.fields[0]?.required).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects Markdown YAML JSON Schema fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```yaml",
          "type: object",
          "properties:",
          "  promptRecipe:",
          "    type: string",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable JSON Schema array item fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            items: {
              type: ["array", "null"],
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
      expect(graph.models[0]?.fields[0]?.nullable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema local ref object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            policy: {
              $ref: "#/$defs/Policy",
            },
          },
          $defs: {
            Policy: {
              type: "object",
              properties: {
                promptRecipe: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["policy", "policy.promptRecipe"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema array item ref fields", async () => {
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
                $ref: "#/$defs/Item",
              },
            },
          },
          $defs: {
            Item: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema refs to array schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            children: {
              $ref: "#/$defs/ChildList",
            },
          },
          $defs: {
            ChildList: {
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

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["children", "children[].id"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounds recursive JSON Schema local refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            child: { $ref: "#/$defs/Node" },
          },
          $defs: {
            Node: {
              type: "object",
              properties: {
                child: { $ref: "#/$defs/Node" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["child", "child.child"]);
      expect(graph.models[0]?.fields.map((field) => field.objectLike)).toEqual([true, false]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts Markdown JSONC fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```jsonc",
          "{",
          "  // comments and trailing commas are valid JSONC",
          '  "promptRecipe": "standard-v1",',
          "}",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts Markdown fences with info strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts title=\"schema.ts\"",
          "type Profile = {",
          "  id: string;",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes property-only JSON Schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          properties: {
            id: { type: "string" },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat ordinary JSON properties bags as JSON Schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          id: "example",
          properties: {
            promptRecipe: "standard-v1",
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "id",
        "properties",
        "properties.promptRecipe",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat ordinary JSON schema metadata as JSON Schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://example.com/schema.json",
          promptRecipe: "standard-v1",
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["$schema", "promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat ordinary JSON type field as JSON Schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          name: "Profile",
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["type", "name"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              id: "a",
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify([
          {
            id: "a",
          },
          {
            promptRecipe: "standard-v1",
          },
        ]),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "items[].promptRecipe",
      ]);
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", false],
        ["items[].promptRecipe", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts unioned ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              id: "a",
            },
            {
              promptRecipe: "standard-v1",
              nested: {
                value: "x",
              },
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "items[].promptRecipe",
        "items[].nested",
        "items[].nested.value",
      ]);
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", false],
        ["items[].promptRecipe", false],
        ["items[].nested", false],
        ["items[].nested.value", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves null alternatives in ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              nested: {
                value: "x",
              },
            },
            {
              nested: null,
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["items", true, false],
        ["items[].nested", true, true],
        ["items[].nested.value", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks ordinary JSON array object fields optional when entries are not objects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              nested: {
                id: "a",
              },
            },
            null,
            "loose",
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].nested", false],
        ["items[].nested.id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps nullable TypeScript model references object-like", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = {",
          "  id: string;",
          "};",
          "type Parent = {",
          "  child?: Child | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");
      const child = parent?.fields.find((field) => field.path === "child");

      expect(child?.objectLike).toBe(true);
      expect(child?.ref).toBe("Child");
      expect(child?.nullable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps parenthesized nullable TypeScript model references object-like", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Parent = {",
          "  child?: (Child | null);",
          "  children?: (Array<Child> | null);",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref, field.nullable])).toEqual([
        ["child", true, "Child", true],
        ["children", true, "Child", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves TypeScript model refs across Markdown fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type Child = {",
          "  id: string;",
          "};",
          "```",
          "",
          "```ts",
          "type Parent = {",
          "  child: Child;",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");
      const child = parent?.fields.find((field) => field.path === "child");

      expect(child?.objectLike).toBe(true);
      expect(child?.ref).toBe("Child");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript object aliases as model refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = {",
          "  id: string;",
          "};",
          "type Parent = Child;",
          "type Wrapper = {",
          "  parent: Parent;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");
      const wrapper = graph.models.find((model) => model.id === "Wrapper");

      expect(parent?.kind).toBe("object");
      expect(parent?.fields.map((field) => field.path)).toEqual(["id"]);
      expect(wrapper?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["parent", true, "Parent"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rewrites duplicate Markdown TypeScript model refs within the same occurrence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type Child = {",
          "  a: string;",
          "};",
          "type Parent = {",
          "  child: Child;",
          "};",
          "```",
          "",
          "```ts",
          "type Child = {",
          "  b: string;",
          "};",
          "type Parent = {",
          "  child: Child;",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const secondParent = graph.models.find((model) => model.id === "Parent#2");
      const secondChild = secondParent?.fields.find((field) => field.path === "child");

      expect(graph.models.map((model) => model.id)).toEqual(["Child", "Parent", "Child#2", "Parent#2"]);
      expect(secondChild?.parent).toBe("Parent#2");
      expect(secondChild?.ref).toBe("Child#2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts inherited TypeScript interface fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Base {",
          "  id: string;",
          "  settings?: {",
          "    promptRecipe?: string;",
          "  };",
          "}",
          "interface User extends Base {",
          "  name: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => field.path)).toEqual([
        "id",
        "settings",
        "settings.promptRecipe",
        "name",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts transitive inherited TypeScript interface fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Entity {",
          "  id: string;",
          "}",
          "interface Named extends Entity {",
          "  name: string;",
          "}",
          "interface User extends Named {",
          "  promptRecipe?: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => field.path)).toEqual(["id", "name", "promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lets TypeScript child interfaces override inherited fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Base {",
          "  value?: string;",
          "  settings: {",
          "    id: string;",
          "  };",
          "}",
          "interface User extends Base {",
          "  value: string;",
          "  settings: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => [field.path, field.type, field.required])).toEqual([
        ["value", "string", true],
        ["settings", "string", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript interface fields inherited from type aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Base = {",
          "  id: string;",
          "  settings?: {",
          "    promptRecipe?: string;",
          "  };",
          "};",
          "interface User extends Base {",
          "  name: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => field.path)).toEqual([
        "id",
        "settings",
        "settings.promptRecipe",
        "name",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript intersection alias fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Base = {",
          "  id: string;",
          "  settings?: {",
          "    promptRecipe?: string;",
          "  };",
          "};",
          "type User = Base & {",
          "  name: string;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.kind).toBe("object");
      expect(user?.fields.map((field) => field.path)).toEqual([
        "id",
        "settings",
        "settings.promptRecipe",
        "name",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level TypeScript object union aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event =",
          "  | {",
          "      kind: \"created\";",
          "      id: string;",
          "    }",
          "  | {",
          "      kind: \"deleted\";",
          "      reason?: string;",
          "    };",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("object");
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["kind", true],
        ["id", false],
        ["reason", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts every TypeScript nested object union variant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event = {",
          "  payload: {",
          "    kind: \"a\";",
          "    a: string;",
          "  } | {",
          "    kind: \"b\";",
          "    b: string;",
          "  };",
          "  items: Array<{",
          "    x: string;",
          "  } | {",
          "    y: string;",
          "  }>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["payload", true],
        ["payload.kind", true],
        ["payload.a", false],
        ["payload.b", false],
        ["items", true],
        ["items[].x", false],
        ["items[].y", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges TypeScript object union property metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event =",
          "  | {",
          "      value: string;",
          "    }",
          "  | {",
          "      value: number | null;",
          "    };",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.required, field.nullable])).toEqual([
        ["value", "string | number | null", true, true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks nested TypeScript fields optional when unions include scalar branches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event = {",
          "  payload: {",
          "    a: string;",
          "  } | string;",
          "  items: Array<{",
          "    b: string;",
          "  } | number>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["payload", true],
        ["payload.a", false],
        ["items", true],
        ["items[].b", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses AST nullish branches for TypeScript nullable metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type nullableString = string;",
          "type Foo = {",
          "  status: \"null\" | \"ok\";",
          "  value: nullableString;",
          "  maybe: string | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const foo = graph.models.find((model) => model.id === "Foo");

      expect(foo?.fields.map((field) => [field.path, field.nullable])).toEqual([
        ["status", false],
        ["value", false],
        ["maybe", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates optional TypeScript parents to inline children", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Parent = {",
          "  config?: {",
          "    id: string;",
          "  };",
          "  items?: {",
          "    value: string;",
          "  }[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["config", false],
        ["config.id", false],
        ["items", false],
        ["items[].value", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable TypeScript parents to inline children", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Parent = {",
          "  config: {",
          "    id: string;",
          "  } | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["config", true, true],
        ["config.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable TypeScript inline object unions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  item?: {",
          "    id: string;",
          "  } | null;",
          "  items?: {",
          "    sku: string;",
          "  }[] | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "item",
        "item.id",
        "items",
        "items[].sku",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable TypeScript array element object unions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items?: Array<{",
          "    id: string;",
          "  } | null>;",
          "  entries?: ({",
          "    sku: string;",
          "  } | null)[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "entries",
        "entries[].sku",
      ]);
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", false],
        ["items[].id", false],
        ["entries", false],
        ["entries[].sku", false],
      ]);
      expect(graph.models[0]?.fields.filter((field) => field.path === "items" || field.path === "entries").map((field) => field.objectLike)).toEqual([
        true,
        true,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks top-level nullable TypeScript array element fields optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Items = Array<{",
          "  id: string;",
          "} | null>;",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts readonly TypeScript inline object arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items: readonly {",
          "    id: string;",
          "  }[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike])).toEqual([
        ["items", true],
        ["items[].id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level TypeScript array aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Profiles = Array<{",
          "  id: string;",
          "  promptRecipe?: string;",
          "} | null>;",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "items[].promptRecipe",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable top-level TypeScript array aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = {",
          "  id: string;",
          "};",
          "type Children = Child[] | null;",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const children = graph.models.find((model) => model.id === "Children");

      expect(children?.kind).toBe("array");
      expect(children?.fields.map((field) => [field.path, field.nullable, field.objectLike, field.ref])).toEqual([
        ["items", true, true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript array aliases as model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Children = Child[];",
          "type Parent = {",
          "  children: Children;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Children"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses collision-free artifact filename parts", () => {
    expect(pathToFileNamePart("a/b")).not.toBe(pathToFileNamePart("a_b"));
  });

  test("rejects duplicate field reviews", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("promptRecipe", "promptRecipe", "string", false)],
        },
      ],
    };
    const aggregate = aggregateReviews(graph, [
      reviewWithoutFinalPath("promptRecipe", "systemPromptVariant"),
      reviewWithoutFinalPath("promptRecipe", "promptVariant"),
    ]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain("Duplicate review for extracted field.");
  });

  test("refuses unsafe non-empty generated output directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(source, ["```ts", "type ModelProfilePolicy = {", "  promptRecipe?: string;", "};", "```"].join("\n"));
      const graph = await extractGraph(source);
      const unsafe = join(dir, "unsafe");
      await mkdir(unsafe);
      await writeFile(join(unsafe, "keep.txt"), "do not delete\n");

      await expect(writeDeterministicReviews(graph, unsafe)).rejects.toThrow("refusing to clear");
      await expect(writeReviewJobs(graph, unsafe)).rejects.toThrow("refusing to clear");
      await expect(readFile(join(unsafe, "keep.txt"), "utf8")).resolves.toBe("do not delete\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports manual run directories without final graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      const runDir = join(dir, "run");
      await mkdir(runDir);
      await writeFile(source, ["```ts", "type ModelProfilePolicy = {", "  promptRecipe?: string;", "};", "```"].join("\n"));
      const graph = await extractGraph(source);
      await writeFile(join(runDir, "graph.iteration-1.json"), JSON.stringify(graph, null, 2));
      const reviews = await writeDeterministicReviews(graph, join(runDir, "reviews.iteration-1"));
      const aggregate = aggregateReviews(graph, reviews);
      await writeFile(join(runDir, "aggregate.iteration-1.json"), JSON.stringify(aggregate, null, 2));

      await execFileAsync(tsxBin(), ["src/cli.ts", "report", "--run", runDir, "--out", join(runDir, "final-report.md")], {
        cwd: process.cwd(),
      });

      await expect(readFile(join(runDir, "final-report.md"), "utf8")).resolves.toContain(
        "Schemator Data Model Review",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("apply refuses invalid aggregates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const graphPath = join(dir, "graph.json");
      const aggregatePath = join(dir, "aggregate.json");
      const outPath = join(dir, "patch.md");
      const graph: ModelGraph = {
        schemaVersion: 1,
        source: { path: "schema.json", revision: null },
        models: [
          {
            id: "JsonSchema",
            kind: "object",
            source: sourceSpan(),
            fields: [field("promptRecipe", "promptRecipe", "string", false)],
          },
        ],
      };
      const aggregate: AggregateReview = {
        schemaVersion: 1,
        ok: false,
        summary: {
          totalFields: 0,
          keep: 0,
          rename: 0,
          merge: 0,
          derive: 0,
          move: 0,
          defer: 0,
          remove: 0,
          opaque: 0,
        },
        decisions: [],
        findings: [
          {
            severity: "error",
            model: "JsonSchema",
            fieldPath: "promptRecipe",
            message: "Extracted field is missing a review.",
          },
        ],
      };
      await writeFile(graphPath, JSON.stringify(graph, null, 2));
      await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2));

      await expect(
        execFileAsync(tsxBin(), ["src/cli.ts", "apply", "--graph", graphPath, "--aggregate", aggregatePath, "--out", outPath], {
          cwd: process.cwd(),
        }),
      ).rejects.toMatchObject({ code: 2 });
      await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run fails when max iterations stop before convergence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      await writeFile(source, ["type ModelProfilePolicy = {", "  promptRecipe?: string;", "};"].join("\n"));

      await expect(
        execFileAsync(tsxBin(), ["src/cli.ts", "run", "--source", source, "--out", runDir, "--max-iterations", "1"], {
          cwd: process.cwd(),
        }),
      ).rejects.toMatchObject({ code: 2 });
      await expect(readFile(join(runDir, "run-summary.json"), "utf8")).resolves.toContain('"stable": false');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects simplification rename collisions", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("recipe", "recipe", "string", false),
            field("variant", "variant", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 1,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        reviewWithoutFinalPath("recipe", "variant"),
        {
          ...reviewWithoutFinalPath("variant", "variant"),
          decision: "keep",
        },
      ],
    };

    expect(() => applyAggregateToGraph(graph, aggregate)).toThrow("duplicate field path");
  });

  test("flags simplification rename collisions during aggregation", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("recipe", "recipe", "string", false),
            field("variant", "variant", "string", false),
          ],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [
      reviewWithoutFinalPath("recipe", "variant"),
      {
        ...reviewWithoutFinalPath("variant", "variant"),
        decision: "keep",
      },
    ]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message).join("\n")).toContain(
      "duplicate field path JsonSchema.variant",
    );
  });

  test("rejects unsupported merge and move decisions during aggregation", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("source", "source", "string", false),
            field("target", "target", "string", false),
          ],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("source", "target"),
        decision: "merge",
      },
      {
        ...reviewWithoutFinalPath("target", "renamedTarget"),
        decision: "move",
      },
    ]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        "Decision merge is not supported by the v1 graph reducer.",
        "Decision move is not supported by the v1 graph reducer.",
      ]),
    );
  });

  test("rejects rename decisions that move fields across parents", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("config.recipe", "recipe", "string", false)],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [review("config.recipe", "other.variant")]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain(
      "Rename decision cannot move fields in the v1 graph reducer.",
    );
    expect(() =>
      applyAggregateToGraph(graph, {
        schemaVersion: 1,
        ok: true,
        summary: {
          totalFields: 1,
          keep: 0,
          rename: 1,
          merge: 0,
          derive: 0,
          move: 0,
          defer: 0,
          remove: 0,
          opaque: 0,
        },
        findings: [],
        decisions: [review("config.recipe", "other.variant")],
      }),
    ).toThrow("rename cannot move field");
  });

  test("rejects parent removal when a descendant review keeps the child", () => {
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
            field("config.id", "id", "string", false),
          ],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("config", "config"),
        decision: "remove",
        simplestChoice: "remove",
      },
      {
        ...reviewWithoutFinalPath("config.id", "id"),
        decision: "keep",
      },
    ]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain(
      "Parent removal conflicts with descendant review decision.",
    );
  });

  test("rejects low-confidence simplifications before reduction", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("promptRecipe", "promptRecipe", "string", false)],
        },
      ],
    };
    const lowConfidenceRename = {
      ...reviewWithoutFinalPath("promptRecipe", "systemPromptVariant"),
      confidence: "low" as const,
    };
    const aggregate = aggregateReviews(graph, [lowConfidenceRename]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain(
      "Low-confidence simplification decisions require focused follow-up before reduction.",
    );
    expect(applyAggregateToGraph(graph, { ...aggregate, ok: true }).models[0]?.fields[0]?.path).toBe(
      "promptRecipe",
    );
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

  test("reports composed nested rename paths", () => {
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
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
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
      ],
    };
    const simplified = applyAggregateToGraph(graph, aggregate);
    const report = renderReport(graph, aggregate, simplified);

    expect(report).toContain("| `JsonSchema` | `config.recipe` | rename | `settings.variant` |");
    expect(report).toContain("| `settings.variant` | `string` | yes | no |");
  });

  test("reports full paths when non-rename reviews omit finalPath", () => {
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
            field("config.token", "token", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 0,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 1,
        opaque: 1,
      },
      findings: [],
      decisions: [
        {
          ...reviewWithoutFinalPath("config", "config"),
          decision: "opaque",
          ownerBoundary: "Config owner.",
        },
        {
          ...reviewWithoutFinalPath("config.token", "token"),
          decision: "remove",
        },
      ],
    };
    const report = renderReport(graph, aggregate, graph);

    expect(report).toContain("| `JsonSchema` | `config.token` | remove | `config.token` |");
    expect(report).not.toContain("| `JsonSchema` | `config.token` | remove | `token` |");
  });

  test("composes nested rename paths in patch plans", () => {
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
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("config", "settings"), reviewWithoutFinalPath("config.recipe", "variant")],
    };

    const plan = renderPatchPlan(graph, aggregate);

    expect(plan).toContain("- Final path: settings.variant");
    expect(plan).not.toContain("- Final path: config.variant");
  });

  test("composes parent renames for non-rename patch-plan rows", () => {
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
            field("config.token", "token", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 1,
        opaque: 0,
      },
      findings: [],
      decisions: [
        reviewWithoutFinalPath("config", "settings"),
        {
          ...reviewWithoutFinalPath("config.token", "token"),
          decision: "remove",
        },
      ],
    };

    const plan = renderPatchPlan(graph, aggregate);

    expect(plan).toContain("## JsonSchema.config.token");
    expect(plan).toContain("- Final path: settings.token");
    expect(plan).not.toContain("- Final path: token");
  });

  test("uses source-neutral rename text in patch plans", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            {
              ...field("promptRecipe", "promptRecipe", "string", false),
              required: false,
            },
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("promptRecipe", "systemPromptVariant")],
    };
    const plan = renderPatchPlan(graph, aggregate);

    expect(plan).toContain("- From: `promptRecipe`");
    expect(plan).toContain("- To: `systemPromptVariant`");
    expect(plan).not.toContain("promptRecipe?:");
  });

  test("uses finalName when rename review omits finalPath", () => {
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
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("config", "settings"), reviewWithoutFinalPath("config.recipe", "variant")],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((item) => item.path)).toEqual([
      "settings",
      "settings.variant",
    ]);
  });

  test("removes array descendants with removed parent", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("items", "items", "array", true),
            field("items[].id", "id", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 0,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 1,
        opaque: 0,
      },
      findings: [],
      decisions: [
        {
          ...reviewWithoutFinalPath("items", "items"),
          decision: "remove",
          simplestChoice: "remove",
        },
      ],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields).toEqual([]);
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

  test("extracts TypeScript generic inline object arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items?: Array<{",
          "    id: string;",
          "    recipe?: string;",
          "  }>;",
          "  readonlyItems?: ReadonlyArray<{",
          "    sku: string;",
          "  }>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((item) => item.path)).toEqual([
        "items",
        "items[].id",
        "items[].recipe",
        "readonlyItems",
        "readonlyItems[].sku",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript generic array model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Parent = {",
          "  children: Array<Child>;",
          "  readonlyChildren: ReadonlyArray<Child>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Child"],
        ["readonlyChildren", true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript unioned array model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Other = { name: string };",
          "type Parent = {",
          "  children: (Child | Other)[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes spaced TypeScript generic array model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Parent = {",
          "  children: Array< Child >;",
          "  readonlyChildren: ReadonlyArray< Child >;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Child"],
        ["readonlyChildren", true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript generic object model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Box<T> = {",
          "  value: T;",
          "};",
          "type Parent = {",
          "  box: Box<string>;",
          "  boxes: Array<Box<string>>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["box", true, "Box"],
        ["boxes", true, "Box"],
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

function reviewWithoutFinalPath(fieldPath: string, finalName: string) {
  return {
    schemaVersion: 1 as const,
    model: "JsonSchema",
    fieldPath,
    decision: "rename" as const,
    finalName,
    finalType: "string",
    required: true,
    rationale: "test",
    alternatives: [finalName],
    simplestChoice: finalName,
    confidence: "high" as const,
    questions: [],
  };
}

function tsxBin(): string {
  return join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
}

async function readdirFileNames(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}
