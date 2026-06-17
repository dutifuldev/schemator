#!/usr/bin/env node
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { aggregateReviews, readReviews } from "./aggregate.js";
import { renderPatchPlan } from "./apply.js";
import { extractGraph } from "./extract/index.js";
import { readJson, resolvePath, writeJson, writeText } from "./files.js";
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
  .requiredOption("--out <dir>", "field prompt output directory")
  .action(async (options: { graph: string; out: string }) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      await writeReviewJobs(graph, resolvePath(options.out));
    });
  });

program
  .command("review")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--out <dir>", "review output directory")
  .option("--jobs <dir>", "also write independent field-review prompts")
  .option("--strategy <name>", "review strategy", "lindy")
  .action(async (options: { graph: string; out: string; jobs?: string; strategy: string }) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      if (options.strategy !== "lindy") {
        throw new Error(`unsupported review strategy: ${options.strategy}`);
      }
      if (options.jobs) {
        await writeReviewJobs(graph, resolvePath(options.jobs));
      }
      const reviews = await writeDeterministicReviews(graph, resolvePath(options.out), { strategy: "lindy" });
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
      const paths = reportPaths(options);
      const graph = assertModelGraph(await readJson(paths.graph));
      const aggregate = assertAggregateReview(await readJson(paths.aggregate));
      const hasFinalGraph = paths.finalGraph ? await pathExists(paths.finalGraph) : false;
      const finalGraph = paths.finalGraph && hasFinalGraph
        ? assertModelGraph(await readJson(paths.finalGraph))
        : undefined;
      await writeText(resolvePath(options.out), renderReport(graph, aggregate, finalGraph));
    });
  });

program
  .command("run")
  .requiredOption("--source <path>", "schema or proposal source")
  .requiredOption("--out <dir>", "run output directory")
  .option("--max-iterations <n>", "maximum simplification iterations", "4")
  .action(async (options: { source: string; out: string; maxIterations: string }) => {
    await runCommand(async () => {
      const source = resolvePath(options.source);
      const out = resolvePath(options.out);
      const maxIterations = Number.parseInt(options.maxIterations, 10);
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        throw new Error("--max-iterations must be a positive integer");
      }
      await mkdir(out, { recursive: true });
      const initialGraph = await extractGraph(source);
      let graph: ModelGraph = initialGraph;
      let lastAggregate: AggregateReview | null = null;
      let firstAggregate: AggregateReview | null = null;
      let stableIteration = 0;

      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const graphPath = join(out, `graph.iteration-${iteration}.json`);
        const reviewsDir = join(out, `reviews.iteration-${iteration}`);
        const jobsDir = join(out, `jobs.iteration-${iteration}`);
        const aggregatePath = join(out, `aggregate.iteration-${iteration}.json`);
        await writeJson(graphPath, graph);
        await writeReviewJobs(graph, jobsDir);
        await writeDeterministicReviews(graph, reviewsDir, { strategy: "lindy" });
        const aggregate = await aggregateFromFiles(graphPath, reviewsDir);
        if (!firstAggregate) {
          firstAggregate = aggregate;
        }
        await writeJson(aggregatePath, aggregate);
        await writeText(join(out, `patch.iteration-${iteration}.md`), renderPatchPlan(graph, aggregate));
        lastAggregate = aggregate;
        stableIteration = iteration;

        if (!aggregate.ok || !hasSimplification(aggregate)) {
          break;
        }
        graph = applyAggregateToGraph(graph, aggregate);
      }

      await writeJson(join(out, "graph.final.json"), graph);
      if (firstAggregate) {
        await writeText(join(out, "final-report.md"), renderReport(initialGraph, firstAggregate, graph));
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
          },
          null,
          2,
        )}\n`,
      );
    });
  });

await program.parseAsync();

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

function reportPaths(options: { run?: string; graph?: string; aggregate?: string }): {
  graph: string;
  aggregate: string;
  finalGraph?: string;
} {
  if (options.run) {
    const runDir = resolvePath(options.run);
    return {
      graph: join(runDir, "graph.iteration-1.json"),
      aggregate: join(runDir, "aggregate.iteration-1.json"),
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
