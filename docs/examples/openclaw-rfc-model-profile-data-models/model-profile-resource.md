# AgentProfile Resource Data Model Review

## Purpose

The `AgentProfile` resource is the profile artifact authoring format.
It gives profile packs familiar `apiVersion`, `kind`, `metadata`, and `spec`
structure while keeping runtime selection on a validated materialized registry.

## Current use cases

- Author built-in, ClawHub, private, and intranet-hosted profile artifacts.
- Let profile layering derive model-family or enterprise profiles from a base.
- Materialize profile resources into `AgentProfile` records.
- Keep prompt text, provider payload fragments, and executable behavior out of
  remote artifacts.
- Support public and private profile distribution with clear resource identity.

## First draft schema

```yaml
apiVersion: agentprofiles.io/v1
kind: AgentProfile
metadata:
  namespace: openclaw
  name: qwen3-6-35b-a3b-profile-v1
spec:
  common:
    systemPrompt:
      file:
        path: ./prompts/system.md
    thinkingLevel: high
  openclaw.ai:
    toolProfile: lean
    contextPosture: constrained
```

## Information table

| Field/column | Type | Required? | Purpose | Why might it belong? | Alternatives / synonyms | Simplest option |
| --- | --- | --- | --- | --- | --- | --- |
| `apiVersion` | string | yes | Identifies the resource API group and version | KRM convention and necessary for future schema evolution | `schemaVersion`, `version` | `apiVersion` follows KRM/Kustomize conventions |
| `kind` | literal `AgentProfile` | yes | Identifies the resource type | Required for resource targeting and patching | `type`, `resourceType` | `kind` follows KRM conventions |
| `metadata` | object | yes | Holds resource identity | KRM convention for name/namespace and patch target identity | `identity`, `resource`, `meta` | `metadata` follows KRM conventions |
| `metadata.namespace` | string | no | Groups profile resources by owner or registry namespace | Useful for public/private authors without overloading names | `owner`, `scope`, `org` | `namespace` is familiar in KRM; optional keeps simple local profiles possible |
| `metadata.name` | string | yes | Resource-local name | Required for overlay target identity and materialized profile id construction | `id`, `profileName` | `name` follows KRM conventions |
| `spec` | object | yes | Holds profile definition | Separates resource metadata from profile behavior | root-level profile fields, `definition` | `spec` follows KRM conventions |
| `spec.common` | `AgentProfileCommon` | yes | Holds portable profile fields | Primary harness-agnostic behavior payload | `behavior`, `harnessPolicy` | `common` matches the current Agent Profile schema |
| `spec.openclaw.ai` | `OpenClawAgentProfileSpec` | no | Holds OpenClaw-owned behavior fields | Keeps OpenClaw-specific choices out of the common schema | `openclaw`, `openclawSettings` | domain-named section matches the current Agent Profile schema |

## Reasoning step

The KRM resource should stay close to Kubernetes conventions because the goal is
to avoid inventing a new layering schema. `apiVersion`, `kind`, `metadata`, and
`spec` are worth keeping even though they are more verbose than the in-process
TypeScript shape.

The draft does not include `spec.settings`. That is needed to express the GPT-5
profile's `personality` setting in artifact form, so the final resource schema
should allow it. The draft also does not show artifact provenance fields. Those
should not go into `spec`; registry and pack metadata can carry provenance,
digest, review status, download counts, and owner trust.

The relationship between `metadata.namespace`/`metadata.name` and materialized
profile `id` needs a rule, but not another field. A simple rule can derive ids
as `<namespace>/<name>` when namespace exists, or require an installer to map
resource identity to profile id during materialization.

## Decision table

| Field/column | Decision | Final name | Final type | Required? | Reason |
| --- | --- | --- | --- | --- | --- |
| `apiVersion` | keep | `apiVersion` | string | yes | Required for KRM-style schema versioning |
| `kind` | keep | `kind` | literal `AgentProfile` | yes | Required for resource targeting |
| `metadata` | keep | `metadata` | object | yes | Holds resource identity separately from profile behavior |
| `metadata.namespace` | keep | `metadata.namespace` | string | no | Useful for owner/registry grouping while optional for simple packs |
| `metadata.name` | keep | `metadata.name` | string | yes | Required resource name and overlay target |
| `spec` | keep | `spec` | object | yes | KRM location for desired profile content |
| `spec.common` | keep | `spec.common` | `AgentProfileCommon` | yes | Core portable profile fields |
| `spec.openclaw.ai` | keep | `spec.openclaw.ai` | `OpenClawAgentProfileSpec` | no | OpenClaw-specific profile fields |
| `spec.settings` | keep | `spec.settings` | `ModelProfileSettingsSchema` | no | Needed for GPT-5 personality and similar narrow settings |

## Final revised schema

```yaml
apiVersion: agentprofiles.io/v1
kind: AgentProfile
metadata:
  namespace: openclaw
  name: qwen3-6-35b-a3b-profile-v1
spec:
  common:
    systemPrompt:
      file:
        path: ./prompts/system.md
    thinkingLevel: high
  openclaw.ai:
    toolProfile: lean
    contextPosture: constrained
  settings: {}
```

## Final reflection

The only field added by the review is optional `spec.settings`, because the RFC
already needs profile-owned settings for GPT-5 personality. Artifact provenance,
review state, signatures, registry visibility, and download counts are
intentionally deferred to profile pack or registry metadata instead of the
`ModelProfile` resource itself.
