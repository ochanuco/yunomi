# MVP Scope

## Goal

The MVP is complete when Discord can host a persistent Yukarin partner that behaves as more than a thin Claude bot.

Minimum completion condition:

> Discord conversation + reply/ignore + minimal Memory + minimal State/Relationship + Audit + minimal read-only Admin UI + read-focused `ykm` CLI.

## First vertical slice

Implement end-to-end:

```text
Discord message
→ Home Discord Gateway Agent
→ Yunomi Cloudflare endpoint
→ Partner DO
→ Yukarin profile load
→ minimal context construction
→ Claude Sonnet
→ structured response
→ reply / ignore decision
→ minimal State/Relationship update
→ D1 Fact Memory candidate persistence
→ Audit
→ Discord reply or deliberate silence
```

Also provide:

- read-only Admin UI: State / Memory / Audit
- `ykm status`
- `ykm memory list`
- `ykm audit tail`

## MVP must include

### Conversation

- Discord server messages
- mentions supported anywhere
- mention does not guarantee reply
- hybrid reply/ignore decision
- channel-local recent context
- shared long-term Partner state
- bots are not normal conversation partners
- relevant alert/notification bots may become external events

### Model

- Sonnet default in prod
- Haiku default in dev
- structured output
- fallback Sonnet → Haiku
- Prompt Caching
- LLM provider interface exists; only Claude implementation required

### Persona

- Yukarin official core
- light fanon topping
- polite / respectful speech as a foundational trait
- values
- interests
- living rhythm
- light recurring jokes with cooldown
- initial state

### State

Initial dynamic state includes at least:

- mood
- energy
- familiarity
- trust
- presence
- system stress / degraded mode as infrastructure state, not emotion

Full design should support richer emotional axes, goals, interests, opinions, etc., but MVP implementation may be minimal.

### Memory

First implementation:
- D1 Fact memory
- recent conversation
- summary
- long-term interface designed for Fact + Episode + Relationship Event
- Episode semantic search interface exists, but Vectorize can be phase 2

### Open loops

Design full open-loop model now.

MVP:
- extraction
- persistence

Later:
- follow-up
- deadline evaluation
- proactive re-check

### Audit

Record enough to answer:
- what input arrived
- reply / ignore decision
- decision summary
- model used
- state changes
- memory candidate writes
- fallback/degraded behavior

### Admin

Read-only:
- Partner State
- Memory
- Audit

No mutation UI.

### CLI / Admin MCP

Design read/write.

MVP CLI is read-focused.

## Explicitly not required for first vertical slice

- voice
- STT
- TTS
- A.I.VOICE
- VC
- Calendar integration
- Vectorize retrieval
- spontaneous speech
- full Relationship dynamics
- image vision analysis
- GCP workloads
- local LLM
- multiple production partners

## Phase 2

Recommended next phase:

- Episode memory + Vectorize
- Relationship Event handling
- Open-loop follow-up
- spontaneous speech
- external event interface
- Discord notification bot events
- richer Admin pages
- image temporary R2 storage + on-demand vision

## Phase 3

- Google Calendar via MCP/integration
- external event scheduling
- daily summaries/journal
- advanced state evolution
- opinion / interest evolution
- richer memory compression and reranking

## Phase 4

Voice:

- Discord VC
- VAD
- STT
- interruption
- A.I.VOICE MCP
- semantic prosody planning
- voice sessions
- Home/GPU node integration

## MVP Done criteria

1. Production Yukarin bot can receive Discord messages.
2. Bot can deliberately not reply.
3. Repeated conversation retains recent context.
4. Minimal facts survive restarts.
5. Minimal mood/energy/familiarity/trust persist and evolve conservatively.
6. Replies preserve Yukarin's polite core.
7. Audit explains major decisions without storing private chain-of-thought.
8. Admin UI shows current State, Memory, Audit.
9. `ykm` can inspect status, memory, audit.
10. dev/prod are isolated.
11. CI passes test/typecheck/eval.
12. prod deployment is explicit/manual.
