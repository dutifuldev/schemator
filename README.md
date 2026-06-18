# schemator

Schemator is a CLI for reviewing and simplifying data models until they reach a
minimum viable schema.

The tool will extract fields and columns from schemas, run independent reviews
for each field, aggregate simplification decisions, apply safe reductions, and
repeat until the model is stable.

## Goal

Data models tend to grow before every field has earned its place. Schemator is
intended to make each field defend itself.

The target workflow is:

1. Extract a normalized graph from a schema.
2. Review every added or changed field independently.
3. Aggregate remove, rename, merge, derive, move, and defer recommendations.
4. Apply safe simplifications.
5. Repeat until no field reviewer can simplify the model further.
6. Generate a human-readable report from structured JSON artifacts.

## CLI

```bash
schemator extract --source schema.ts --out .schemator/graph.iteration-1.json
schemator create-jobs --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/jobs.iteration-1
schemator review --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/reviews.iteration-1
schemator review --strategy codex --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/reviews.iteration-1
schemator aggregate --graph .schemator/graph.iteration-1.json --reviews .schemator/reviews.iteration-1 --out .schemator/aggregate.iteration-1.json
schemator apply --graph .schemator/graph.iteration-1.json --aggregate .schemator/aggregate.iteration-1.json --out .schemator/patch.iteration-1.md
schemator report --run .schemator --out .schemator/final-report.md
```

End-to-end:

```bash
schemator run --source schema.ts --context project-context.md --out .schemator
schemator run --strategy codex --source schema.ts --context project-context.md --out .schemator
```

`lindy` is the default review strategy. It is deterministic and useful for fast
local convergence checks. `codex` starts one independent `codex exec` reviewer
per field, constrains it with `schemas/field-review.schema.json`, and validates
each returned review before writing it.

`--context <file>` is optional. When supplied, Schemator includes the project
and task context in every generated field-review prompt and copies it into run
artifacts as `project-context.md`.

## Current Status

This repository contains the first TypeScript implementation. It supports:

- Markdown fenced TypeScript, JSON, and YAML extraction
- JSON Schema extraction
- normalized field graphs
- independent field-review prompt generation
- deterministic Lindy-style field review
- Codex-backed independent field review with `--strategy codex`
- aggregate coverage validation
- in-memory simplification until stable
- patch-plan and Markdown report generation

- [Implementation plan](docs/implementation-plan.md)
- [Example OpenClaw RFC review artifacts](docs/examples/openclaw-rfc-model-profile-data-models/)
