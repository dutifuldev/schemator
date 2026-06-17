# Model Profile Binding Data Model Review

## Purpose

`ModelProfileBinding` connects trusted model identity facts to one model
profile. It lets the resolver choose a profile without making profiles act as a
second model catalog.

## Current use cases

- Bind exact artifact digests to reviewed profiles.
- Bind canonical model ids to model-specific profiles.
- Bind provider-scoped model families to family profiles.
- Bind trusted capacity classes to fallback profile behavior.
- Emit diagnostics about which binding selected the profile.

## First draft schema

```ts
type ModelProfileBinding = {
  id: string;
  selector: {
    providerId?: string;
    canonicalModelId?: string;
    modelFamily?: string;
    artifactDigest?: string;
    capacityClass?: ModelCapacityClass;
  };
  profile: string;
};
```

## Information table

| Field/column | Type | Required? | Purpose | Why might it belong? | Alternatives / synonyms | Simplest option |
| --- | --- | --- | --- | --- | --- | --- |
| `id` | `string` | yes | Stable binding identifier | Needed for ambiguous-match errors and operator diagnostics | `name`, `bindingId`, derived selector hash | `id` is simplest and human-readable |
| `selector` | object | yes | Groups matching criteria | Avoids flattening all selector fields into the binding root | `match`, `when`, `criteria` | `selector` is explicit and common |
| `selector.providerId` | `string` | conditional | Scopes bindings to a provider | Needed when model-family semantics or capabilities differ by provider route | `provider`, `providerRef` | `providerId` matches identity object |
| `selector.canonicalModelId` | `string` | no | Matches one normalized model id | Needed for exact model-level behavior | `modelId`, `canonicalId` | `canonicalModelId` avoids confusion with requested ids |
| `selector.modelFamily` | `string` | no | Matches a provider-scoped family | Useful for GPT-5 or Anthropic family behavior | `family`, `modelLine` | `modelFamily` matches identity object |
| `selector.artifactDigest` | `string` | no | Matches an exact artifact | Needed for trusted open-weight artifact bindings | `digest`, `sha256`, `artifactHash` | `artifactDigest` is explicit |
| `selector.capacityClass` | `ModelCapacityClass` | no | Matches trusted model size class | Needed for tiny/small lean fallback | `sizeClass`, `strengthTier` | `capacityClass` matches identity object |
| `profile` | `string` | yes | Target profile id | Resolver needs one selected profile from each binding | `profileId`, `target`, `ref` | `profile` is concise in binding context |

## Reasoning step

The draft is mostly minimal, but the selector object needs a validation rule
more than a new field. A selector with no criteria should be invalid, and two
bindings at the same precedence level must not be ambiguous.

The target field could be renamed to `profileId` for clarity. However, the RFC
already uses `profile` in examples and the binding context makes the target
obvious. `profile` is also shorter while still clear.

No separate `priority` field should be added. The RFC already defines
precedence by selector type: artifact, model, family, capacity, fallback. A
manual priority field would make selection harder to reason about.

## Decision table

| Field/column | Decision | Final name | Final type | Required? | Reason |
| --- | --- | --- | --- | --- | --- |
| `id` | keep | `id` | `string` | yes | Needed for diagnostics and registry validation errors |
| `selector` | keep | `selector` | object | yes | Keeps matching criteria grouped and extensible without a generic bag |
| `selector.providerId` | keep | `selector.providerId` | `string` | conditional | Needed for provider-scoped family matching |
| `selector.canonicalModelId` | keep | `selector.canonicalModelId` | `string` | no | Supports exact canonical model bindings |
| `selector.modelFamily` | keep | `selector.modelFamily` | `string` | no | Supports reviewed family bindings |
| `selector.artifactDigest` | keep | `selector.artifactDigest` | `string` | no | Supports exact artifact bindings |
| `selector.capacityClass` | keep | `selector.capacityClass` | `ModelCapacityClass` | no | Supports capacity fallback bindings |
| `profile` | keep | `profile` | `string` | yes | Short target profile reference; validation can require it exists |

## Final revised schema

```ts
type ModelProfileBinding = {
  id: string;
  selector: {
    providerId?: string;
    canonicalModelId?: string;
    modelFamily?: string;
    artifactDigest?: string;
    capacityClass?: ModelCapacityClass;
  };
  profile: string;
};
```

## Final reflection

No fields were removed. The minimum viable improvement is not a schema change
but a validation rule: every selector must contain at least one criterion, and
bindings must be unambiguous at the same precedence level. `priority`,
`description`, and generic selector expressions are intentionally deferred.
