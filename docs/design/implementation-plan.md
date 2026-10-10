# Recommended Implementation Plan

## Principle

Build vertical slices, not horizontal frameworks.

Do not implement every designed abstraction before the first working conversation.

## Goal 0 — Skeleton

- initialize monorepo
- pnpm workspaces
- Turborepo
- `cf + cloudflare.config.ts`
- dev/prod config
- Valibot boundary package
- domain error types
- CI skeleton
- basic docs/ADR layout

Done:
- repo builds
- tests run
- dev deploy works

## Goal 1 — First conversational vertical slice

### Flow

```text
Discord Gateway Agent
→ Yunomi HTTP
→ Partner DO
→ Partner Profile
→ PromptBuilder
→ Claude Sonnet
→ Structured Output
→ reply/ignore
→ Discord output
```

### Add

- minimal State
- minimal Relationship
- D1 Fact memory candidate save
- short decision summary
- audit
- read-only Admin State/Memory/Audit
- `ykm status`
- `ykm memory list`
- `ykm audit tail`

### Done

See `mvp-scope.md`.

## Goal 2 — Durable partner memory

- Fact retrieval
- conversation summarization
- Memory need classifier
- contradiction handling
- Memory candidate queue
- Open Loop extract/save
- Snapshot create/restore/dev seed
- Profile/schema versioning

## Goal 3 — Semantic memory and relationship

- Vectorize
- Episode
- Relationship Event
- weighted rerank
- optional LLM rerank
- Interest
- Opinion
- richer Relationship
- daily machine summary
- partner journal
- Workflows for compression/snapshot

## Goal 4 — Human-like presence

- limited spontaneous speech
- notification bot event ingestion
- external event interface
- topic cooldown
- ignored-speech adaptation
- reply timing / typing behavior
- living rhythm / presence transitions

## Goal 5 — External integrations

- Google Calendar MCP/integration
- calendar read/write confirmation
- proactive calendar-driven events
- richer capability permissions
- Home/GPU capabilities

## Goal 6 — Voice

- Discord VC receive/send
- VAD
- STT
- interruption
- clarification policy
- A.I.VOICE MCP
- semantic performance/prosody
- voice sessions

## Implementation rules

- Do not implement feature breadth before vertical slice works.
- Use interfaces where replacement is plausible, but do not build unused alternate providers.
- Keep Vectorize rebuildable.
- Keep R2 temporary content disposable.
- Keep Persona static core Git-managed.
- Keep dynamic Partner state outside static profile.
- Preserve auditability for probabilistic behavior.
- Prefer bounded state mutations over direct LLM control.
