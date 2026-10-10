# Task for Claude

You are working on the repository:

`https://github.com/ochanuco/yunomi`

Read every Markdown document in this design package before proposing implementation work.

## Objective

Turn this design into a realistic implementation plan and GitHub issue hierarchy.

Do not immediately start coding broad infrastructure.

Your first task is planning.

## Step 1 — Design review

Review the design for:

- contradictions
- missing technical constraints
- unnecessary abstractions
- Cloudflare limitations
- Discord Gateway limitations
- security concerns
- data model inconsistencies
- MVP scope creep
- places where the design assumes future functionality

Do not rewrite the product philosophy unless technically necessary.

Output:
- blockers
- recommended corrections
- decisions that can safely remain deferred

## Step 2 — Define MVP Goal

Produce one concise MVP Goal.

It must correspond to the first vertical slice in `mvp-scope.md`.

The MVP must be demonstrable by using the Discord bot.

## Step 3 — Epic decomposition

Create a small number of Epics.

Prefer vertical outcomes over layer-based epics.

Bad:
- "Build database layer"
- "Build interfaces"

Better:
- "Yukarin can receive a Discord message and intentionally reply or stay silent"

Each Epic must include:
- user-visible outcome
- technical scope
- dependencies
- explicit non-goals
- Done criteria

## Step 4 — Issue decomposition

Break Epics into implementable Issues.

Guidelines:
- small enough for one focused PR
- large enough to deliver meaningful progress
- avoid placeholder architecture tasks unless necessary
- include tests/eval expectations
- explicitly state dependencies
- identify issues that can run in parallel

## Step 5 — Dependency graph

Produce:
- ordered critical path
- parallelizable work
- blocking decisions
- recommended first 5 Issues

## Step 6 — First vertical slice

The initial slice should include:

- Discord event reception through Home Gateway Agent
- Cloudflare Yunomi endpoint
- Partner DO
- Yukarin static profile
- Claude Sonnet provider
- Prompt Builder
- structured output
- reply / ignore
- minimal State / Relationship
- D1 Fact memory candidate persistence
- Audit
- Discord response
- read-only Admin State/Memory/Audit
- read-focused `ykm`

Do not add voice, Vectorize, Calendar, or spontaneous speech before this works.

## Architecture constraints

### Repository
- monorepo
- pnpm workspaces
- Turborepo

### Cloudflare
- use `cf + cloudflare.config.ts`
- Cloudflare app resources belong in this repo
- account/shared low-level infrastructure belongs to `ochanuco/chabatake`

### Runtime
- TypeScript first
- Rust/Python only where justified

### Admin
- Vite + TypeScript + plain DOM
- no React/Lit initially
- Cloudflare Access

### D1
- Drizzle by default
- raw SQL when justified

### Boundary validation
- Valibot

### Errors
- semantic typed errors
- discriminated unions for domain errors

### IDs
- UUID v7 by default

### Events
- common envelope
- EventBus interface
- Cloudflare Queues implementation

### State
- current Partner State in DO
- persistent history/data in D1

### Semantic memory
- design for Vectorize
- do not implement Vectorize in the first vertical slice

### CI/CD
- PR: tests/typecheck/eval
- main: dev deploy
- prod: explicit deployment

## Design philosophy

Do not turn Yunomi into a generic agent framework for its own sake.

It is a product for persistent AI partners.

Generic abstractions are justified only when they serve an already-planned extension:
- multiple Partners
- multiple interfaces
- replaceable LLM provider
- Cloud/local capability nodes

The first production Partner is Yukarin.

Yukarin should feel like an independent participant with continuity, not an obedient command bot.
