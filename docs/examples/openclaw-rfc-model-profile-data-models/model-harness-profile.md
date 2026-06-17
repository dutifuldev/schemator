# Model Harness Profile Data Model Review

## Purpose

`ModelHarnessProfile` defines portable agent-harness behavior for a resolved
model. It is the unit that can be layered, validated, selected, and carried
through tools, prompt composition, Tool Search, diagnostics, and reasoning
defaults.

## Current use cases

- Represent built-in full, lean, GPT-5, Anthropic, and Claude profiles.
- Support profile inheritance/layering before runtime selection.
- Select closed policy fields such as tool exposure and reasoning defaults.
- Allow narrow profile-owned settings such as GPT-5 personality.
- Keep provider payloads, cache controls, and serving flags out of profile data.

## First draft schema

```ts
type ModelHarnessProfile = {
  schemaVersion: 1;
  id: string;
  extends?: string;
  policy: ModelProfilePolicy;
  settings?: ModelProfileSettingsSchema;
};
```

## Information table

| Field/column | Type | Required? | Purpose | Why might it belong? | Alternatives / synonyms | Simplest option |
| --- | --- | --- | --- | --- | --- | --- |
| `schemaVersion` | literal `1` | yes | Identifies the profile schema contract | Needed for validation and future migration of installed profile packs | `version`, `apiVersion`, `profileVersion` | `schemaVersion` matches the materialized registry |
| `id` | `string` | yes | Stable profile identifier | Needed for explicit selection, bindings, diagnostics, and inheritance references | `name`, `ref`, `profileId` | `id` is shortest and matches existing profile id examples |
| `extends` | `string` | no | Names a parent profile in the materialized registry | Needed for in-process layered profile representation after authoring formats hydrate | `parent`, `base`, `from`, KRM `resources`/patches only | `extends` is explicit and concise for the materialized form |
| `policy` | `ModelProfilePolicy` | yes | Holds closed portable harness policy fields | This is the profile's primary behavior payload | `spec`, `behavior`, `harness` | `policy` clearly excludes provider and serving settings |
| `settings` | `ModelProfileSettingsSchema` | no | Declares allowed per-profile settings | Needed for GPT-5 personality and future narrow settings without a generic bag | `options`, `parameters`, `config` | `settings` is conventional and less open-ended than `config` |

## Reasoning step

The draft mixes two layers: artifact authoring now uses KRM/Kustomize style, but
the in-process registry still benefits from a compact `extends` field. Keeping
`extends` in the materialized schema is acceptable if the RFC stays clear that
runtime consumes resolved snapshots and does not run Kustomize during requests.

`policy` should stay required because a profile with no policy is either a pure
alias or a metadata wrapper. If aliases are needed later, they should be a
separate binding or pack concept. `settings` should remain optional and closed;
a generic `config` or `extra` field would undermine the RFC's safety boundary.

The schema does not need `metadata`, `description`, `owner`, or `provenance` in
the core profile because those belong to artifact packs, registries, and
diagnostics. Adding them to the runtime behavior schema would blur ownership.

## Decision table

| Field/column | Decision | Final name | Final type | Required? | Reason |
| --- | --- | --- | --- | --- | --- |
| `schemaVersion` | keep | `schemaVersion` | literal `1` | yes | Keeps materialized profiles versioned independently of artifact format |
| `id` | keep | `id` | `string` | yes | Smallest stable identifier for selection, inheritance, and diagnostics |
| `extends` | keep | `extends` | `string` | no | Useful in materialized profile definitions, while artifact overlays remain separate |
| `policy` | keep | `policy` | `ModelProfilePolicy` | yes | Core behavior payload and closed profile surface |
| `settings` | keep | `settings` | `ModelProfileSettingsSchema` | no | Narrow escape hatch for profile-owned settings without generic provider config |

## Final revised schema

```ts
type ModelHarnessProfile = {
  schemaVersion: 1;
  id: string;
  extends?: string;
  policy: ModelProfilePolicy;
  settings?: ModelProfileSettingsSchema;
};
```

## Final reflection

No fields were removed. The important constraint is documentation rather than a
schema change: `extends` is for the validated materialized profile graph, while
KRM/Kustomize resources are an authoring and installation format. Artifact
metadata, ownership, signatures, and download counts should stay outside this
minimal runtime behavior model.
