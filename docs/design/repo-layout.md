# Repository Layout

## Monorepo

Use:

- pnpm workspaces
- Turborepo

Initial physical structure should be smaller than the final architecture.

Suggested starting point:

```text
yunomi/
├─ apps/
│  ├─ worker/
│  └─ admin/
├─ packages/
│  └─ core/
├─ partners/
│  └─ yukarin/
├─ evals/
├─ tools/
├─ migrations/
├─ docs/
├─ turbo.json
├─ pnpm-workspace.yaml
└─ package.json
```

Split further when justified.

Potential future structure:

```text
apps/
├─ api-worker/
├─ admin/
├─ cli/
└─ mcp/

workers/
├─ event-consumer/
└─ scheduler/

packages/
├─ partner-core/
├─ persona/
├─ memory/
├─ relationship/
├─ events/
├─ llm/
├─ protocol/
└─ capabilities/

native/
└─ rust/

ml/
└─ python/
```

## TypeScript first

Primary:
- TypeScript / Workers

Escape hatches:

Rust:
- performance-critical
- low-latency native logic
- parsing/search helpers

Python:
- ML
- embeddings
- classifiers
- statistical evaluation
- experiment-oriented computation

## Frontend

Admin Web:

- Vite
- TypeScript
- plain DOM

Do not add React/Lit unless UI complexity justifies it.

## Validation

At external boundaries:
- Valibot

Internal:
- TypeScript domain types
- pure functions by default
- classes/specialized objects only where invariants/state transitions warrant them

## Database

D1:
- Drizzle by default
- raw SQL for complex/performance-sensitive paths

Schema:
- normalize important domain fields
- use JSON only for genuinely flexible optional metadata

## Prompt architecture

Separate:

- LLMProvider
- PromptBuilder
- StructuredOutputSchema

Prompt blocks:

- Identity / Persona
- Current State
- Relationship
- Relevant Memory
- Channel / Presence context
- task-specific instructions
- output schema

Prompt structure/order:
- deterministic

Dynamic content:
- retrieved memory
- recent conversation
- events

## Prompt token budget

Per-block budget.

Common ratio policy + model-specific total budget.

Fallback should reduce:
- memory/episode context first

Preserve:
- Persona
- Relationship
- recent conversation

## Prompt caching

Use from MVP.

Cache:
- Persona
- static profile
- slowly changing relationship summary

Use block-level versioning.

Invalidate only changed blocks.
