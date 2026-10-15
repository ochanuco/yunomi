# Yunomi Design Package

Yunomi is a personal-use runtime for persistent AI partners.

The name is a play on **湯呑み (yunomi)** and **"you know me"**. The system is designed around the idea that AI partners are independent "others", not extensions of the user. `Yukarin` is the first production partner implementation; `Ponzu` is only a PoC and must not constrain production architecture.

This package is intended to be given to Claude (or another coding agent) as the source material for:

1. Reviewing the design for contradictions, missing constraints, or overengineering.
2. Defining the MVP goal precisely.
3. Decomposing the MVP into Epics.
4. Decomposing Epics into implementable Issues with dependencies and Done criteria.
5. Implementing the first vertical slice before broad feature coverage.

## Repository

- GitHub: `ochanuco/yunomi`
- Monorepo
- Package manager: pnpm workspaces
- Task runner: Turborepo

## Core Principle

Yunomi is not "a Yukarin bot". It is an AI partner platform/runtime where multiple persistent AI partners may eventually exist.

```text
Yunomi Runtime
├─ Partner: Yukarin
├─ Partner: Future Partner B
└─ Partner: Future Partner C
```

Each partner is a persistent entity with:

- Identity
- Persona
- Memory
- Relationship state
- Opinion / Interest state
- Current emotional / behavioral state
- Presence
- Capabilities / tool permissions
- External identities (e.g. Discord bot)
- Voice / performance profile

The MVP ships only Yukarin.

## Documents

- `principles.md` — core on Cloudflare, replaceable organs, relays
- `architecture.md` — overall architecture and boundaries
- `mvp-scope.md` — MVP scope, first vertical slice, Done criteria
- `domain-model.md` — core domain entities and state models
- `memory.md` — memory, retrieval, summarization, snapshots
- `persona.md` — Yukarin persona design and evolution rules
- `discord.md` — Discord text/voice behavior and presence
- `body.md` — Partner body, faculties, mind/body/organ layers
- `voice.md` — voice architecture (speech, hearing, A.I.VOICE organ)
- `capabilities.md` — MCP, Home Node, GPU Box, capability routing
- `infrastructure.md` — Cloudflare/GCP/home infrastructure responsibilities
- `events.md` — event model, queues, async processing
- `observability.md` — audit, metrics, cost monitoring, SLOs
- `security.md` — auth, secrets, permissions, backup encryption
- `testing.md` — deterministic tests, persona eval, probabilistic QA
- `repo-layout.md` — monorepo and code boundaries
- `decisions.md` — accepted design decisions and explicit non-goals
- `implementation-plan.md` — recommended implementation order
- `CLAUDE_TASK.md` — instructions for Claude to decompose this design into Goal/Epics/Issues
