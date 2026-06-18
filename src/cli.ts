#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { aggregateReviews, readReviews } from "./aggregate.js";
import { renderPatchPlan } from "./apply.js";
import { writeCodexReviews } from "./codex-review.js";
import { extractGraph } from "./extract/index.js";
import { readJson, readText, resolvePath, writeJson, writeText } from "./files.js";
import { applyAggregateToGraph, hasSimplification } from "./graph.js";
import { writeReviewJobs } from "./jobs.js";
import { renderReport } from "./report.js";
import { writeDeterministicReviews } from "./review.js";
import type { AggregateReview, ModelGraph } from "./types.js";
import { validateAggregateReview, validateFieldReview, validateModelGraph } from "./validate.js";

const program = new Command();

program
  .name("schemator")
  .description("Extract, challenge, and simplify data models until stable.")
  .version("0.1.0");

program
  .command("extract")
  .requiredOption("--source <path>", "schema or proposal source")
  .requiredOption("--out <path>", "model graph JSON output")
  .action(async (options: { source: string; out: string }) => {
    await runCommand(async () => {
      const graph = await extractGraph(resolvePath(options.source));
      const validation = validateModelGraph(graph);
      if (!validation.ok) {
        throw new Error(`extracted graph is invalid:\n${validation.errors.join("\n")}`);
      }
      await writeJson(resolvePath(options.out), graph);
    });
  });

program
  .command("create-jobs")
  .requiredOption("--graph <path>", "model graph JSON")
  .option("--context <path>", "project/task context Markdown")
  .requiredOption("--out <dir>", "field prompt output directory")
  .action(async (options: { graph: string; context?: string; out: string }) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      const projectContext = await readProjectContext(options.context);
      await writeReviewJobs(graph, resolvePath(options.out), reviewContextOptions(projectContext));
    });
  });

program
  .command("review")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--out <dir>", "review output directory")
  .option("--context <path>", "project/task context Markdown")
  .option("--jobs <dir>", "also write independent field-review prompts")
  .option("--strategy <name>", "review strategy", "lindy")
  .option("--codex-command <path>", "Codex executable for --strategy codex", "codex")
  .option("--codex-model <name>", "Codex model for --strategy codex")
  .option("--codex-timeout-ms <n>", "per-field Codex timeout in milliseconds", "120000")
  .action(async (options: ReviewCommandOptions) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      const projectContext = await readProjectContext(options.context);
      if (options.jobs) {
        await writeReviewJobs(graph, resolvePath(options.jobs), reviewContextOptions(projectContext));
      }
      const reviews = options.strategy === "codex"
        ? await writeCodexReviews(graph, resolvePath(options.out), {
          ...codexOptions(options),
          ...reviewContextOptions(projectContext),
        })
        : options.strategy === "lindy"
          ? await writeDeterministicReviews(graph, resolvePath(options.out), {
            strategy: "lindy",
            ...reviewContextOptions(projectContext),
          })
          : unsupportedStrategy(options.strategy);
      for (const review of reviews) {
        const validation = validateFieldReview(review);
        if (!validation.ok) {
          throw new Error(`generated review is invalid:\n${validation.errors.join("\n")}`);
        }
      }
    });
  });

program
  .command("aggregate")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--reviews <dir>", "review JSON directory")
  .requiredOption("--out <path>", "aggregate JSON output")
  .action(async (options: { graph: string; reviews: string; out: string }) => {
    await runCommand(async () => {
      const aggregate = await aggregateFromFiles(resolvePath(options.graph), resolvePath(options.reviews));
      await writeJson(resolvePath(options.out), aggregate);
      if (!aggregate.ok) {
        process.exitCode = 1;
      }
    });
  });

program
  .command("validate")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--reviews <dir>", "review JSON directory")
  .action(async (options: { graph: string; reviews: string }) => {
    await runCommand(async () => {
      const aggregate = await aggregateFromFiles(resolvePath(options.graph), resolvePath(options.reviews));
      if (!aggregate.ok) {
        for (const finding of aggregate.findings) {
          console.error(`${finding.severity}: ${finding.model ?? ""} ${finding.fieldPath ?? ""} ${finding.message}`);
        }
        process.exitCode = 1;
      }
    });
  });

program
  .command("apply")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--aggregate <path>", "aggregate review JSON")
  .requiredOption("--out <path>", "patch plan output")
  .action(async (options: { graph: string; aggregate: string; out: string }) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      const aggregate = assertAggregateReview(await readJson(resolvePath(options.aggregate)));
      if (!aggregate.ok) {
        throw new Error(
          `cannot render patch plan for invalid aggregate:\n${aggregate.findings.map((finding) => finding.message).join("\n")}`,
        );
      }
      await writeText(resolvePath(options.out), renderPatchPlan(graph, aggregate));
    });
  });

program
  .command("report")
  .option("--run <dir>", "schemator run directory")
  .option("--graph <path>", "model graph JSON")
  .option("--aggregate <path>", "aggregate review JSON")
  .requiredOption("--out <path>", "Markdown report output")
  .action(async (options: { run?: string; graph?: string; aggregate?: string; out: string }) => {
    await runCommand(async () => {
      const paths = await reportPaths(options);
      const graph = assertModelGraph(await readJson(paths.graph));
      const aggregates = paths.aggregatePaths ? await Promise.all(paths.aggregatePaths.map(readAggregate)) : null;
      const aggregate = aggregates ? combineAggregates(aggregates) : await readAggregate(paths.aggregate);
      const hasFinalGraph = paths.finalGraph ? await pathExists(paths.finalGraph) : false;
      const finalGraph = paths.finalGraph && hasFinalGraph
        ? assertModelGraph(await readJson(paths.finalGraph))
        : aggregate.ok
          ? deriveFinalGraph(graph, aggregates ?? [aggregate])
          : undefined;
      await writeText(resolvePath(options.out), renderReport(graph, aggregate, finalGraph));
    });
  });

program
  .command("run")
  .requiredOption("--source <path>", "schema or proposal source")
  .requiredOption("--out <dir>", "run output directory")
  .option("--context <path>", "project/task context Markdown")
  .option("--max-iterations <n>", "maximum simplification iterations", "4")
  .option("--strategy <name>", "review strategy", "lindy")
  .option("--codex-command <path>", "Codex executable for --strategy codex", "codex")
  .option("--codex-model <name>", "Codex model for --strategy codex")
  .option("--codex-timeout-ms <n>", "per-field Codex timeout in milliseconds", "120000")
  .action(async (options: RunCommandOptions) => {
    await runCommand(async () => {
      const source = resolvePath(options.source);
      const out = resolvePath(options.out);
      const maxIterations = Number.parseInt(options.maxIterations, 10);
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        throw new Error("--max-iterations must be a positive integer");
      }
      const projectContext = await readProjectContext(options.context);
      await mkdir(out, { recursive: true });
      if (projectContext !== undefined) {
        await writeText(join(out, "project-context.md"), projectContext);
      }
      const initialGraph = await extractGraph(source);
      let graph: ModelGraph = initialGraph;
      let lastAggregate: AggregateReview | null = null;
      let invalidAggregate: AggregateReview | null = null;
      const aggregates: AggregateReview[] = [];
      let stableIteration = 0;

      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const graphPath = join(out, `graph.iteration-${iteration}.json`);
        const reviewsDir = join(out, `reviews.iteration-${iteration}`);
        const jobsDir = join(out, `jobs.iteration-${iteration}`);
        const aggregatePath = join(out, `aggregate.iteration-${iteration}.json`);
        await writeJson(graphPath, graph);
        await writeReviewJobs(graph, jobsDir, reviewContextOptions(projectContext));
        if (options.strategy === "codex") {
          await writeCodexReviews(graph, reviewsDir, {
            ...codexOptions(options),
            ...reviewContextOptions(projectContext),
          });
        } else if (options.strategy === "lindy") {
          await writeDeterministicReviews(graph, reviewsDir, {
            strategy: "lindy",
            ...reviewContextOptions(projectContext),
          });
        } else {
          unsupportedStrategy(options.strategy);
        }
        const aggregate = await aggregateFromFiles(graphPath, reviewsDir);
        await writeJson(aggregatePath, aggregate);
        await writeText(join(out, `patch.iteration-${iteration}.md`), renderPatchPlan(graph, aggregate));
        lastAggregate = aggregate;
        aggregates.push(aggregate);
        stableIteration = iteration;

        if (!aggregate.ok) {
          invalidAggregate = aggregate;
          break;
        }
        if (!hasSimplification(aggregate)) {
          break;
        }
        graph = applyAggregateToGraph(graph, aggregate);
      }

      await writeJson(join(out, "graph.final.json"), graph);
      if (lastAggregate) {
        await writeText(join(out, "final-report.md"), renderReport(initialGraph, combineAggregates(aggregates), graph));
      }
      await writeText(
        join(out, "run-summary.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            source,
            stableIteration,
            stable: lastAggregate ? lastAggregate.ok && !hasSimplification(lastAggregate) : false,
            finalGraph: "graph.final.json",
            finalReport: "final-report.md",
            ...(projectContext !== undefined
              ? {
                projectContext: "project-context.md",
                projectContextSha256: sha256(projectContext),
              }
              : {}),
          },
          null,
          2,
        )}\n`,
      );
      if (invalidAggregate) {
        throw new Error(
          `aggregate validation failed at iteration ${stableIteration}: ${invalidAggregate.findings.map((finding) => finding.message).join("; ")}`,
        );
      }
      if (lastAggregate && hasSimplification(lastAggregate)) {
        throw new Error(`run stopped before convergence after ${stableIteration} iteration(s)`);
      }
    });
  });

await program.parseAsync();

type ReviewCommandOptions = {
  graph: string;
  out: string;
  context?: string;
  jobs?: string;
  strategy: string;
  codexCommand: string;
  codexModel?: string;
  codexTimeoutMs: string;
};

type RunCommandOptions = {
  source: string;
  out: string;
  context?: string;
  maxIterations: string;
  strategy: string;
  codexCommand: string;
  codexModel?: string;
  codexTimeoutMs: string;
};

function codexOptions(options: Pick<ReviewCommandOptions, "codexCommand" | "codexModel" | "codexTimeoutMs">): {
  command: string;
  model?: string;
  timeoutMs: number;
} {
  const timeoutMs = Number.parseInt(options.codexTimeoutMs, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("--codex-timeout-ms must be a positive integer");
  }
  return {
    command: options.codexCommand,
    ...(options.codexModel ? { model: options.codexModel } : {}),
    timeoutMs,
  };
}

function unsupportedStrategy(strategy: string): never {
  throw new Error(`unsupported review strategy: ${strategy}`);
}

async function readProjectContext(path: string | undefined): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }
  const resolved = resolvePath(path);
  try {
    return await readText(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read --context file ${resolved}: ${message}`);
  }
}

function reviewContextOptions(projectContext: string | undefined): { projectContext?: string } {
  return projectContext === undefined ? {} : { projectContext };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function aggregateFromFiles(graphPath: string, reviewsDir: string): Promise<AggregateReview> {
  const graph = assertModelGraph(await readJson(graphPath));
  const reviews = await readReviews(reviewsDir);
  for (const review of reviews) {
    const validation = validateFieldReview(review);
    if (!validation.ok) {
      throw new Error(`invalid field review for ${review.model}.${review.fieldPath}:\n${validation.errors.join("\n")}`);
    }
  }
  const aggregate = aggregateReviews(graph, reviews);
  const validation = validateAggregateReview(aggregate);
  if (!validation.ok) {
    throw new Error(`aggregate is invalid:\n${validation.errors.join("\n")}`);
  }
  return aggregate;
}

async function readAggregate(path: string): Promise<AggregateReview> {
  return assertAggregateReview(await readJson(path));
}

async function reportPaths(options: { run?: string; graph?: string; aggregate?: string }): Promise<{
  graph: string;
  aggregate: string;
  aggregatePaths?: string[];
  finalGraph?: string;
}> {
  if (options.run) {
    const runDir = resolvePath(options.run);
    const iteration = await currentRunIteration(runDir);
    return {
      graph: join(runDir, "graph.iteration-1.json"),
      aggregate: join(runDir, `aggregate.iteration-${iteration}.json`),
      aggregatePaths: aggregatePathsThrough(runDir, iteration),
      finalGraph: join(runDir, "graph.final.json"),
    };
  }
  if (!options.graph || !options.aggregate) {
    throw new Error("report needs either --run or both --graph and --aggregate");
  }
  return {
    graph: resolvePath(options.graph),
    aggregate: resolvePath(options.aggregate),
  };
}

function aggregatePathsThrough(runDir: string, iteration: number): string[] {
  return Array.from({ length: iteration }, (_, index) => join(runDir, `aggregate.iteration-${index + 1}.json`));
}

function combineAggregates(aggregates: AggregateReview[]): AggregateReview {
  const summary = emptySummary();
  for (const aggregate of aggregates) {
    for (const decision of Object.keys(summary) as Array<keyof typeof summary>) {
      summary[decision] += aggregate.summary[decision];
    }
  }
  return {
    schemaVersion: 1,
    ok: aggregates.every((aggregate) => aggregate.ok),
    summary,
    decisions: aggregates.flatMap((aggregate) => aggregate.decisions),
    findings: aggregates.flatMap((aggregate) => aggregate.findings),
  };
}

function deriveFinalGraph(graph: ModelGraph, aggregates: AggregateReview[]): ModelGraph {
  let next = graph;
  for (const aggregate of aggregates) {
    next = applyAggregateToGraph(next, aggregate);
  }
  return next;
}

function emptySummary(): AggregateReview["summary"] {
  return {
    totalFields: 0,
    keep: 0,
    rename: 0,
    merge: 0,
    derive: 0,
    move: 0,
    defer: 0,
    remove: 0,
    opaque: 0,
  };
}

async function currentRunIteration(runDir: string): Promise<number> {
  const summaryPath = join(runDir, "run-summary.json");
  if (await pathExists(summaryPath)) {
    const summary = await readJson(summaryPath);
    const stableIteration = isRecord(summary) ? summary["stableIteration"] : null;
    if (typeof stableIteration === "number" && Number.isInteger(stableIteration) && stableIteration > 0) {
      return stableIteration;
    }
  }
  return latestRunIteration(runDir);
}

async function latestRunIteration(runDir: string): Promise<number> {
  const entries = await readdir(runDir);
  const iterations = entries
    .map((entry) => /^aggregate\.iteration-(\d+)\.json$/.exec(entry)?.[1])
    .filter((iteration): iteration is string => Boolean(iteration))
    .map((iteration) => Number.parseInt(iteration, 10))
    .filter(Number.isInteger)
    .sort((left, right) => right - left);
  const latest = iterations[0];
  if (!latest) {
    throw new Error(`run directory has no aggregate.iteration-*.json files: ${runDir}`);
  }
  return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertModelGraph(value: unknown): ModelGraph {
  const validation = validateModelGraph(value);
  if (!validation.ok) {
    throw new Error(`invalid model graph:\n${validation.errors.join("\n")}`);
  }
  return value as ModelGraph;
}

function assertAggregateReview(value: unknown): AggregateReview {
  const validation = validateAggregateReview(value);
  if (!validation.ok) {
    throw new Error(`invalid aggregate review:\n${validation.errors.join("\n")}`);
  }
  return value as AggregateReview;
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
