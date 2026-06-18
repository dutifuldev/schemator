# Schemator Implementation Corrections

Date: 2026-06-18

This note records the implementation problems that were identified and the
correct behavior now required in this branch.

## Fixed Direction

Schemator must use model reviewers as the real decision-maker. The default
`review` and `run` paths should use Codex, not a local field-name policy engine.

The local fallback exists only for smoke tests and offline plumbing checks. It
must stay conservative and generic.

## Requirements

1. Codex is the default review strategy.

`schemator review` and `schemator run` should default to `--strategy codex`.

2. No hardcoded field-specific rename rules.

Production code must not contain rules like:

- rename one specific field name to another specific field name
- remove one specific field name
- preserve one specific field name

Those decisions belong to the model reviewer and the project/task context.

3. Project context must matter.

The field-review prompt includes project context before the field under review.
If the context says Kustomize-style or declarative configuration vocabulary is
intentional, the reviewer should treat that as evidence to preserve such names.

4. Bad names can still be renamed.

The absence of hardcoded field rules does not mean every name is kept. The
model reviewer should still challenge names that are metaphorical, vague,
redundant, or temporary implementation details.

5. `extends` should not be renamed by local code.

If a project context says Kustomize-like declarative naming is intentional,
`extends` should be kept unless the model reviewer gives a context-aware reason
to change it.

6. `promptRecipe` can still be renamed by model judgment.

The right behavior is not a local `if fieldName === "promptRecipe"` rule. The
right behavior is a model reviewer deciding that the name is metaphorical and
that a more durable stored selector name is better.

## Remaining Product Limits

Source rewriting is still not implemented. Schemator reduces the normalized
graph and writes patch-plan/report artifacts, but it does not rewrite the
original source schema files.

Full `merge` and `move` reduction remains future work. Those decisions are in
the review vocabulary, but safe source/graph application needs more reducer
logic.
