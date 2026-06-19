---
name: final-report
description: Use when preparing, publishing, or reviewing a final Schemator run report. Ensures the report includes raw artifacts, schema JSON, source details, decisions, verification, and push links instead of only a narrative summary.
---

# Final Report

Use this skill before calling any Schemator run report complete, especially when publishing it to a scratch repo, PR, issue, handoff doc, or user-facing summary.

## Required Contents

A complete final report must include:

- Run identity: source document, run directory or artifact location, timestamp/date, Schemator repo URL, branch, commit, and exact commands used.
- Run outcome: whether the run converged, stable iteration, stopping condition, total iterations, and whether any independent-from-scratch runs were compared.
- Raw schema artifacts: the initial extracted schema graph JSON and the final stable schema graph JSON. Do not only link or summarize them if the user asked for a complete report.
- Human-readable schema summary: initial vs final field/model counts, additions, removals, renames, moves, merges, and unchanged important fields.
- Decision trace: applied changes, skipped proposals, rejected/manual structural proposals, consistency warnings, and the model/field/path affected.
- Context artifacts: project/task context, prompt/default prompt/skill prompt used for decisions, and checksums if available.
- Diff artifacts: machine or human-readable initial-vs-final graph diff.
- Verification: commands run, tests/checks, report generation command, diff generation command, commit SHA, branch, push result, GitHub link, and known gaps.

## Completeness Rules

- Do not call a report complete if the raw initial and final schema JSON are missing.
- Do not replace raw artifacts with prose. Prose explains the artifacts; it does not substitute for them.
- Do not report only the final state. Include enough initial state and diff detail for a reader to audit what changed.
- Do not hide skipped or rejected proposals. They are part of the decision record.
- If an artifact is unavailable, name it explicitly and explain why.

## Suggested Report Shape

```markdown
# Schemator Final Run Report - YYYY-MM-DD

## Run Metadata
...

## Run Summary JSON
...

## Initial Schema Graph JSON
...

## Final Stable Schema Graph JSON
...

## Initial vs Final Summary
...

## Applied, Skipped, And Manual Decisions
...

## Graph Diff
...

## Verification And Push
...

## Known Gaps
...
```

## Before Publishing

1. Open the generated report and search for `Initial Schema Graph JSON` and `Final Stable Schema Graph JSON`.
2. Confirm the report includes the exact source, Schemator commit, commands, and stable iteration.
3. Confirm links point at the pushed branch and file.
4. Stage only the intended report artifacts.
5. Push and include the final GitHub URL in the response.
