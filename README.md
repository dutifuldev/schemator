# schemator

Schemator is a planned CLI for reviewing and simplifying data models until they
reach a minimum viable schema.

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

## Planned CLI

```bash
schemator extract --source schema.ts --out .schemator/graph.iteration-1.json
schemator review --graph .schemator/graph.iteration-1.json --out .schemator/reviews.iteration-1
schemator aggregate --graph .schemator/graph.iteration-1.json --reviews .schemator/reviews.iteration-1 --out .schemator/aggregate.iteration-1.json
schemator report --run .schemator --out .schemator/final-report.md
```

Eventually:

```bash
schemator run --source schema.ts --requirements requirements.md --out .schemator
```

## Current Status

This repository currently contains the design and example review artifacts.
Implementation work has not started.

- [Implementation plan](docs/implementation-plan.md)
- [Example OpenClaw RFC review artifacts](docs/examples/openclaw-rfc-model-profile-data-models/)
