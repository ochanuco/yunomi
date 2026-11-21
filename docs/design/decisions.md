# Accepted Decisions

This is a compact decision register.

## Product

- Name: **Yunomi**
- Wordplay: 湯呑み / "you know me"
- CLI: `ykm`
- Personal use only; third-party distribution is not a goal
- Ponzu is a PoC, not the production architecture
- AI partners are independent others, not extensions of the user
- Yukarin is one Partner instance in a multi-Partner-capable runtime

## MVP UX

- Discord is the primary first interface
- mention works server-wide
- mention does not guarantee reply
- limited human-like silence is intentional
- self-initiated speech is designed now, implemented after reactive flow stabilizes
- no command-centric user UX
- admin UI is read-only

## Models

- prod default: Sonnet
- dev default: Haiku
- fallback: Sonnet → Haiku
- future model promotion/demotion supported
- LLMProvider abstraction from MVP
- Claude only implementation in MVP

## Persona

- official settings as core
- light fanon topping
- polite/respectful Japanese is foundational
- values/boundaries explicit
- opinions/interests evolve slowly
- recurring jokes have cooldown

## State / Relationship

- rich model designed
- minimal MVP implementation
- numeric + natural-language summaries
- deltas bounded by application rules
- infrastructure health separated from emotional state

## Memory

- Fact + Episode + Relationship Event
- D1 source of truth
- Vectorize projection
- semantic retrieval only when needed
- weighted rerank + optional LLM rerank
- importance + decay
- forgetting mostly via lower retrieval priority
- compression keeps source references
- daily machine summary + partner journal

## Open Loop

- separate from task/reminder management
- captures unresolved conversational threads
- MVP extracts/saves only
- later follow-up behavior

## Calendar

- Google Calendar is source of truth
- no internal calendar mirror
- read on demand
- write after explicit confirmation
- can later trigger proactive behavior

## Voice

- not first vertical slice
- AudioInput/TTS/VoiceSession interfaces only
- VC later
- VAD
- STT abstraction
- A.I.VOICE via MCP
- semantic prosody IR before vendor parameters
- speaking is decided in the core and carried out through the speech organ; the LLM does not call TTS as a tool

## Core and organs

- decisions and state live only in the Cloudflare core (Worker + Partner DO); see `principles.md`
- organs only execute and sense, attached through per-faculty interfaces and adapters; location and transport stay inside the adapter
- relays (`yunomi-relay`, tunnel) relay only
- one core (Partner DO) per character; characters share no state
- organs and relays may be shared physically (`yunomi-box`, LLM provider, relay host) but are separated logically per character
- the core has three layers: heart (who the Partner is), brain (perceive, recall, think, decide), body (faculties and organ coordination); see `principles.md`
- the LLM is an organ attached to the brain; replacing it must not change the heart
- the heart applies its own rules to changes the brain proposes

## Body

- the Partner has a body with faculties: speech, hearing, Discord behavior; only speech is implemented now
- layers: brain (intent, semantic IR) -> body (core, `packages/core`, IR to engine instructions, organ coordination) -> organ (anywhere)
- the core derives body state from organ availability
- the Partner knows its body state and adapts (e.g. replies in text when it cannot speak)

## Voice profile

- lives with the character in `partners/yukarin`
- a per-engine realization; a new engine adds a realization
- current engine: A.I.VOICE only

## Organ

- A.I.VOICE organ is `ochanuco/ochoko`: a thin C# MCP server (text + A.I.VOICE values -> WAV), no IR, no character knowledge
- runs on `yunomi-box`, an always-on Windows machine (COM); `aivoice -> yunomi-box`
- the core reaches it through a relay (the relay host on the LAN, or Cloudflare Tunnel + Access; an adapter choice)
- node offline policy for aivoice: `fail`
- deployed by an external Windows app deployer; the organ repo owns no runner

## Conversation organ

- `yunomi-voice` (`apps/voice`) runs next to the speech and hearing organs on `yunomi-box` and carries the audio stream of a conversation
- it holds reflexes only: stop playback when the user starts speaking (barge-in), detect the end of an utterance, play cached backchannels, stream speech-to-text and text-to-speech
- decisions stay in the core: who replies, what to say, which words to use as backchannels, what to do with a reply that was cut off
- one `yunomi-voice` serves every partner: one ear for the owner, one mouth per partner
- the audio transport is an adapter; the first one is a Discord voice channel, joined with each partner's own bot over a second Gateway connection
- utterances and voice state go to the core over HTTP; the core pushes voice directives over a WebSocket that `yunomi-voice` keeps to each PartnerDO (Hibernation API)
- `yunomi-relay` keeps the Discord text connection the Worker cannot hold and relays only; it does not handle voice

## Cloud

- Cloudflare first
- GCP optional expansion
- Home Docker for the relay (`yunomi-relay`) and local services
- `yunomi-box` (always-on Windows) for the speech and hearing organs and `yunomi-voice`
- GPU Box for GPU workloads
- no HA requirement when Home dies

## Cloudflare config

- start with `cf + cloudflare.config.ts`
- use Wrangler only where beta gaps require it
- Admin Web uses Vite
- main Worker does not require Vite

## Repo

- pnpm workspaces
- Turborepo
- monorepo
- TypeScript first
- Rust/Python escape hatches

## Storage

- DO: current state / presence / serialization
- D1: persistent domain data
- Vectorize: semantic index
- R2: temporary artifacts + snapshots

## Events

- EventBus is an interface
- Cloudflare Queues is MVP implementation
- only non-immediate tasks are queued
- common envelope + typed payload
- Valibot boundary validation

## Workflow

- Cron triggers scheduled jobs
- Workflows handle long/retryable operations

## Admin

- Cloudflare Access
- read-only web
- mutation via MCP/CLI/agent
- `ykm` read-focused in MVP

## Snapshot

- common snapshot format for backup/restore/dev seed
- manifest + multi-file
- encrypted
- R2 + separate failure domain
- Partner snapshot primary, optional System snapshot

## CI/CD

Deployment stages:

- PR: test/typecheck/eval
- main: dev deploy
- prod: explicit/manual

## Time

- internal UTC
- user-facing JST
- support lifestyle hours up to 29:59
- default lifestyle-day boundary 05:00 JST

## Explicit non-decisions/non-goals for MVP

- no React
- no event sourcing
- no dynamic node failover
- no local LLM implementation
- no GCP by default
- no voice implementation in first vertical slice
- no general task manager
- no third-party distribution focus
