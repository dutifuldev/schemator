# OpenClaw RFC Convergence Experiment

Date: 2026-06-19

Source: `/home/bob/oc/rfcs/rfcs/0009-model-harness-profiles.md`

Project context: `/tmp/schemator-context-openclaw/project-context.md`

## Constraints

- No field-specific deterministic rules were added for `extends`, `promptRecipe`, or any other domain field.
- Kustomize-like and declarative vocabulary stayed in project/task context and model judgment.
- Codex remained the reviewer for real experiment runs.
- The convergence control is generic: accepted changes are recorded as run history, applied renames become sticky within that run, and skipped/manual proposals do not count as graph changes.

## Baseline Continuation

The pre-fix memoryless run had already stopped after iteration 4 as unstable. It was continued from its final graph for six more real Codex iterations.

Command shape:

```bash
node dist/cli.js create-jobs --graph /tmp/schemator-context-openclaw-more/graph.iteration-N.json --context /tmp/schemator-context-openclaw-more/project-context.md --out /tmp/schemator-context-openclaw-more/jobs.iteration-N
node dist/cli.js review --graph /tmp/schemator-context-openclaw-more/graph.iteration-N.json --context /tmp/schemator-context-openclaw-more/project-context.md --out /tmp/schemator-context-openclaw-more/reviews.iteration-N --strategy codex --codex-timeout-ms 120000
node dist/cli.js aggregate --graph /tmp/schemator-context-openclaw-more/graph.iteration-N.json --reviews /tmp/schemator-context-openclaw-more/reviews.iteration-N --out /tmp/schemator-context-openclaw-more/aggregate.iteration-N.json
node dist/cli.js apply --graph /tmp/schemator-context-openclaw-more/graph.iteration-N.json --aggregate /tmp/schemator-context-openclaw-more/aggregate.iteration-N.json --out /tmp/schemator-context-openclaw-more/patch.iteration-N.md
```

Artifacts: `/tmp/schemator-context-openclaw-more`

Result: did not converge by iteration 10.

| Iteration | Total | Keep | Rename | Merge | Move | Defer | Remove | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 5 | 114 | 77 | 29 | 4 | 3 | 0 | 1 | unstable |
| 6 | 114 | 83 | 24 | 7 | 0 | 0 | 0 | unstable |
| 7 | 114 | 89 | 19 | 6 | 0 | 0 | 0 | unstable |
| 8 | 114 | 84 | 23 | 6 | 1 | 0 | 0 | unstable |
| 9 | 114 | 91 | 16 | 6 | 0 | 1 | 0 | unstable |
| 10 | 113 | 88 | 17 | 6 | 1 | 0 | 0 | unstable |

Plain result: more independent memoryless passes did not converge. Rename churn decreased in some passes, then increased again, and manual structural proposals kept reappearing.

## Fixed Run

Command:

```bash
npm run dev -- run \
  --source /home/bob/oc/rfcs/rfcs/0009-model-harness-profiles.md \
  --context /tmp/schemator-context-openclaw/project-context.md \
  --out /tmp/schemator-convergence-stabilized-openclaw-v2 \
  --max-iterations 10 \
  --codex-concurrency 4 \
  --codex-timeout-ms 120000
```

Artifacts: `/tmp/schemator-convergence-stabilized-openclaw-v2`

Result: converged at iteration 8.

Final summary:

```json
{
  "schemaVersion": 1,
  "stableIteration": 8,
  "stable": true,
  "finalGraph": "graph.final.json",
  "finalReport": "final-report.md"
}
```

| Iteration | Total | Rename | Remove | Merge | Applied | Skipped | Skipped reasons | Graph changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 124 | 49 | 2 | 2 | 53 | 3 | manual: 2, removal-conflict: 1 | yes |
| 2 | 120 | 17 | 2 | 0 | 14 | 5 | frozen-rename: 5 | yes |
| 3 | 118 | 8 | 0 | 0 | 4 | 4 | frozen-rename: 4 | yes |
| 4 | 118 | 6 | 1 | 0 | 2 | 5 | frozen-rename: 5 | yes |
| 5 | 117 | 9 | 0 | 0 | 4 | 5 | frozen-rename: 5 | yes |
| 6 | 117 | 9 | 0 | 0 | 1 | 8 | frozen-rename: 8 | yes |
| 7 | 117 | 5 | 1 | 1 | 1 | 6 | frozen-rename: 5, manual: 1 | yes |
| 8 | 116 | 4 | 0 | 1 | 0 | 5 | frozen-rename: 4, manual: 1 | no |

Plain result: the fixed run still allowed the model to propose changes, including large changes and removals, but only graph-applicable changes counted for convergence. Previously accepted rename targets became sticky. By iteration 8, the remaining model proposals were 4 attempts to rename already-accepted fields plus 1 manual merge proposal, so the graph did not change and the run converged.

## Implementation Notes

- `reduction.iteration-N.json` records what was applied and what was skipped.
- `jobs.iteration-N/*.prompt.md` includes accepted run decisions after iteration 1.
- Codex reviews now run with bounded concurrency so real full-graph experiments can complete in a practical time.
- The object-like leaf validation accepts either nested coverage, a removal-like simplification, or an explicit owner boundary. This fixed the real iteration-2 validation failure from the first stabilized attempt.
