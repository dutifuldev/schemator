# Agent Entrypoint

Attention agent: start here when you are asked to use Schemator to review or
simplify a data model in an existing project.

Schemator is decision support. It can propose field removals, renames, merges,
and consistency fixes, but product semantics and public naming must be confirmed
before source files are changed.

## Operating Rules

- Do not overwrite or delete the original schema or proposal during the run.
- Keep Schemator artifacts under `.schemator` or another clearly named output
  directory.
- Do not apply removals, renames, or merges until you have reviewed the report
  and diff.
- Ask for missing product semantics, naming constraints, or compatibility rules.
  Do not ask for commands you can infer from the repository.
- If the repository already has a schema review workflow, update it in place
  instead of adding a parallel process.

## First Pass

Start by reading the repository before changing files:

```sh
find . -maxdepth 3 -type f | sort | head -200
```

Identify:

- the schema, TypeScript types, JSON Schema, YAML, JSON, or Markdown proposal to
  review
- product context, naming guidance, API docs, or migration notes that explain
  intended semantics
- generated, fixture, vendor, or build output that should not drive the review
- the project's formatter, type-checker, test, or schema validation commands
- whether the requested output is only a report or also source-file changes

If the source model or product context is ambiguous, ask for that before running
a full review.

## Run Schemator

For an installed package, run:

```sh
schemator run --source <source> --context <context> --out .schemator
```

For a local Schemator checkout, run the same command through the dev script:

```sh
npm run dev -- run --source <source> --context <context> --out .schemator
```

Use `--context` whenever product semantics or naming constraints matter. Good
context explains what the schema is for, which fields are user-facing, which
vocabulary is intentional, and what should stay stable.

Use local mode only for smoke tests or when the reviewer backend is unavailable:

```sh
schemator run --strategy local --source <source> --out .schemator-smoke
```

Local mode is conservative. Say clearly when a result came from local mode.

## Inspect Artifacts

Create the final report and graph diff:

```sh
schemator report --run .schemator --out .schemator/final-report.md
schemator diff --run .schemator --out .schemator/graph-diff.md
```

If you are using the local checkout, prefix those commands with
`npm run dev --`.

Review:

- applied changes
- skipped proposals
- manual structural proposals
- consistency warnings
- the final graph

Treat a converged result as a candidate schema, not automatic product truth.

## Applying Changes

Apply source-file changes only after reviewing the report and diff.

Use this order:

1. Apply only changes supported by the final report and product context.
2. Keep public names and compatibility-sensitive fields stable unless the user
   confirms the migration.
3. Update nearby tests, fixtures, docs, migrations, or examples affected by the
   model change.
4. Run the target repository's formatter, type-checker, tests, and schema
   validation commands.
5. Rerun or regenerate Schemator artifacts if the source model changes
   materially.

Do not apply manual structural proposals without explicit approval.

## Validation

Before finishing, run the relevant local checks for the target repository.

When changing Schemator itself, run:

```sh
npm run check
git diff --check
```

If a command cannot run locally, say exactly why and what still needs CI or
maintainer verification.

## Final Report

When you finish, report:

- source and context files used
- output directory and report paths
- schema changes applied
- proposals intentionally skipped
- unresolved product or naming questions
- checks that passed or could not run
