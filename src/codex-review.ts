import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileNamePart, prepareGeneratedOutputDir, writeJson } from "./files.js";
import { renderFieldPrompt } from "./jobs.js";
import type { FieldReview, ModelGraph } from "./types.js";
import { validateFieldReview } from "./validate.js";

export type CodexReviewOptions = {
  command?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
};

export async function writeCodexReviews(
  graph: ModelGraph,
  outputDir: string,
  options: CodexReviewOptions = {},
): Promise<FieldReview[]> {
  await prepareGeneratedOutputDir(outputDir, ".review.json");
  const reviews: FieldReview[] = [];
  for (const model of graph.models) {
    for (const field of model.fields) {
      const prompt = renderFieldPrompt(graph, model, field);
      const review = await runCodexFieldReview(prompt, options);
      const validation = validateFieldReview(review);
      if (!validation.ok) {
        throw new Error(
          `Codex review for ${model.id}.${field.path} is invalid:\n${validation.errors.join("\n")}`,
        );
      }
      reviews.push(review);
      const fileName = `${pathToFileNamePart(model.id)}.${pathToFileNamePart(field.path)}.review.json`;
      await writeJson(join(outputDir, fileName), review);
    }
  }
  return reviews;
}

async function runCodexFieldReview(prompt: string, options: CodexReviewOptions): Promise<FieldReview> {
  const command = options.command ?? "codex";
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-schema",
    fieldReviewSchemaPath(),
    "--color",
    "never",
    ...(options.model ? ["--model", options.model] : []),
    "-",
  ];
  const output = await execWithInput(command, args, prompt, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  return parseFieldReviewOutput(output);
}

function fieldReviewSchemaPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "field-review.codex-output.schema.json");
}

function execWithInput(
  command: string,
  args: string[],
  input: string,
  options: { cwd: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code ?? "unknown"}:\n${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function parseFieldReviewOutput(output: string): FieldReview {
  const trimmed = output.trim();
  const direct = tryParseJson(trimmed);
  if (direct) {
    return normalizeFieldReview(direct);
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
  const fencedJson = fenced?.[1] ? tryParseJson(fenced[1].trim()) : null;
  if (fencedJson) {
    return normalizeFieldReview(fencedJson);
  }

  const objectText = firstJsonObject(output);
  const objectJson = objectText ? tryParseJson(objectText) : null;
  if (objectJson) {
    return normalizeFieldReview(objectJson);
  }

  throw new Error("Codex review did not return a JSON object");
}

function normalizeFieldReview(value: unknown): FieldReview {
  if (!isRecord(value)) {
    return value as FieldReview;
  }
  const review = { ...value };
  if (review["finalPath"] === null) {
    delete review["finalPath"];
  }
  if (review["ownerBoundary"] === null) {
    delete review["ownerBoundary"];
  }
  return review as FieldReview;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function firstJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
