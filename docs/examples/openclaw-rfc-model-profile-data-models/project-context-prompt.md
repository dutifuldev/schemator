# Example Project Context Prompt

Use this project context for every field decision in the OpenClaw model harness
profile review.

This schema describes OpenClaw model harness profiles: user-facing
configuration objects for model/runtime behavior, policy defaults, provider
capabilities, serving presets, and reusable profile composition.

The feature exists so OpenClaw and third parties can customize how a model is
called in the harness without changing OpenClaw core code. Profiles may control
provider/model selection, runtime policy, tool exposure, context behavior,
reasoning defaults, serving presets, diagnostics behavior, and other call-time
behavior.

The schema should support reusable profile composition so operators, plugin
authors, hosted integrations, and external tooling can define or adapt profiles
for their own model-calling needs.

In the long run, these profiles may also be generated, compared, tuned, or
optimized on the fly using techniques such as GEPA or other search and
optimization systems. That makes the schema especially important: it should
represent durable facts and stable knobs, not temporary implementation details
or prose-only conventions.

The schema may intentionally borrow vocabulary from long-lived declarative
configuration systems such as Kustomize, Kubernetes-style manifests, JSON
Schema, package manifests, and similar tools. Treat established configuration
vocabulary as meaningful evidence, not automatically as implementation jargon.

The goal is to find a Lindy data model: stable concepts and names that could
remain understandable for the next ten or a hundred years.

Prefer names and structures that users can understand in configuration files.
Favor durable declarative concepts over temporary implementation details.

Do not rename a field only because it resembles programming terminology. First
consider whether the term is an established declarative configuration convention
in the surrounding schema.

Do not preserve a term only because it already exists. Challenge names that are
vague, misleading, metaphorical, redundant, or tied to a temporary
implementation.

Propose large structural changes when they are justified by the model and task
context. Remove, derive, merge, or move fields when doing so clearly produces a
smaller, more durable model.

Some extracted blocks may be examples or fixtures rather than canonical model
definitions. Use them as evidence, but do not overfit schema decisions to
example-only values.

When a decision depends on missing product semantics, say what context is
missing instead of inventing the invariant.

Do not add field-specific keep, rename, remove, merge, derive, or move rules
unless the user explicitly asks for a specific field to be handled that way.
