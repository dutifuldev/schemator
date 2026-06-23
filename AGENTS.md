# AGENTS.md

These instructions apply to this repository.

## Agent Entrypoint

If you are using Schemator to review this or another repository's data model,
start with [Agent Entrypoint](docs/AGENT_ENTRYPOINT.md). It is the operational
guide for running Schemator, reviewing artifacts, and deciding what to apply.

## Baseline Rules

- Keep generated schema-review artifacts reviewable by humans.
- Do not overwrite source schemas, proposals, or fixtures without confirming the
  intended product semantics.
- Treat Schemator output as a candidate model, not automatic truth.
- Add or update nearby tests when changing behavior.
- Keep CLI behavior and report formats stable unless the change intentionally
  updates the contract.
- Run `npm run check` before finishing changes to Schemator itself.
