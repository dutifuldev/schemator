# Model Harness Profile Registry Data Model Review

## Purpose

The registry is the materialized in-process container for validated model
profiles and profile bindings. It exists so runtime selection can use one stable
snapshot instead of reading profile files or overlays during an agent run.

## Current use cases

- Load built-in profiles and bindings once at startup.
- Validate profile and binding uniqueness before runtime use.
- Resolve one profile from explicit config, artifact, model, family, capacity,
  or fallback.
- Keep runtime selection independent from profile artifact authoring format.

## First draft schema

```ts
type ModelHarnessProfileRegistry = {
  schemaVersion: 1;
  profiles: ModelHarnessProfile[];
  bindings: ModelProfileBinding[];
};
```

## Information table

| Field/column | Type | Required? | Purpose | Why might it belong? | Alternatives / synonyms | Simplest option |
| --- | --- | --- | --- | --- | --- | --- |
| `schemaVersion` | literal `1` | yes | Identifies the registry schema contract | Needed to reject incompatible installed packs and future materialized snapshots | `version`, `apiVersion`, `registryVersion` | `schemaVersion` matches the RFC's in-process TypeScript style |
| `profiles` | `ModelHarnessProfile[]` | yes | Holds all materialized profile definitions | Resolver needs the profile set by id after artifact hydration | `items`, `profileDefinitions`, map keyed by id | Array is simplest for JSON compatibility; validator can enforce unique ids |
| `bindings` | `ModelProfileBinding[]` | yes | Holds selector-to-profile rules | Resolver needs explicit binding precedence without embedding selectors inside profile definitions | `rules`, `selectors`, `profileBindings` | `bindings` is concise and conventional for selector records |

## Reasoning step

The draft is already close to minimum viable. `schemaVersion` is necessary
because profile packs may eventually come from ClawHub, public registries,
private enterprise registries, or intranet mirrors. `profiles` and `bindings`
should remain separate because profiles define behavior and bindings define
selection. Embedding bindings inside profiles would make a profile artifact
harder to reuse across registries or enterprises.

A map keyed by profile id could make lookup faster, but it makes the JSON shape
less friendly and duplicates the id in both key and value. The validator can
materialize maps internally after checking uniqueness.

## Decision table

| Field/column | Decision | Final name | Final type | Required? | Reason |
| --- | --- | --- | --- | --- | --- |
| `schemaVersion` | keep | `schemaVersion` | literal `1` | yes | Required for versioned validation and future pack compatibility |
| `profiles` | keep | `profiles` | `ModelHarnessProfile[]` | yes | Smallest clear container for materialized profiles |
| `bindings` | keep | `bindings` | `ModelProfileBinding[]` | yes | Keeps selection rules separate from reusable profile definitions |

## Final revised schema

```ts
type ModelHarnessProfileRegistry = {
  schemaVersion: 1;
  profiles: ModelHarnessProfile[];
  bindings: ModelProfileBinding[];
};
```

## Final reflection

No fields were removed. The schema is already minimal for the phase-one
materialized registry. Lookup indexes, provenance summaries, and validation
diagnostics should be derived or held in runtime-only data structures rather
than stored in the registry schema.
