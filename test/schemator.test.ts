import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { aggregateReviews } from "../src/aggregate.js";
import { extractGraph } from "../src/extract/index.js";
import { pathToFileNamePart } from "../src/files.js";
import { applyAggregateToGraph, hasSimplification } from "../src/graph.js";
import { writeReviewJobs } from "../src/jobs.js";
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

  test("does not treat ordinary JSON properties field as JSON Schema", async () => {
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
