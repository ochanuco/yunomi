# Architecture

## 1. System shape

Yunomi is a persistent AI partner runtime.

```text
                           ┌───────────────────────┐
                           │       Discord        │
                           │  text / presence / VC│
                           └──────────┬────────────┘
                                      │
                             Home Docker Agent
                         (Discord Gateway always-on)
                                      │
                         HTTPS / WebSocket to Cloud
                                      │
                    ┌─────────────────▼─────────────────┐
                    │         Yunomi / Cloudflare      │
                    │                                 │
                    │  Partner Runtime                 │
                    │  Model Router                    │
                    │  Prompt Builder                  │
                    │  State / Relationship            │
                    │  Memory orchestration            │
                    │  Event handling                  │
                    │  MCP / Capability client         │
                    └────────────┬─────────────────────┘
                                 │
                ┌────────────────┼─────────────────┐
                ▼                ▼                 ▼
             Claude             D1 / DO         Vectorize / R2
                                 │
                                 ▼
                             Queues / Workflows
                                 │
                 ┌───────────────┴──────────────┐
                 ▼                              ▼
           Home Node                        GPU Box
     lightweight/local services         GPU-dependent services
```

## 2. Responsibilities

### Cloudflare / Yunomi core

Primary runtime and source of truth for AI partner behavior.

Owns:

- Partner orchestration
- Persona loading
- Prompt building
- LLM provider abstraction
- Model routing
- reply / ignore / defer decisions
- Partner state
- Relationship state
- Memory orchestration
- Open loops
- Opinion / Interest state
- Event handling
- Audit summaries
- Admin read model
- Cost control
- Feature flags
- Snapshot orchestration

### Home Docker

Home is not a redundancy layer. If Home is down, Discord and other home-dependent capabilities may simply be unavailable.

Home runs:

- Discord Gateway Agent
- lightweight local MCPs/services
- LAN integrations
- Gateway-side speech relay: calls the A.I.VOICE organ on the GPU Box over the LAN
- lightweight STT where useful
- WebSocket/HTTPS client toward Yunomi

### GPU Box

Dedicated for GPU-required workloads.

Windows machine that sleeps when idle and is woken via wake-on-LAN.

Examples:

- A.I.VOICE organ (`ochoko`)
- ComfyUI
- heavy/local STT
- local LLM
- GPU-dependent ML/image/audio processing

No dynamic failover is required between Home and GPU Box.

### GCP

Available as an expansion platform, but cost-sensitive and not preferred for MVP.

Potential future uses:

- BigQuery analysis
- Cloud Run for workloads unsuitable for Workers
- heavier batch / ML workloads
- additional backup target

Application interfaces should not hard-code Cloudflare where avoidable, but MVP infrastructure implementations are Cloudflare-optimized.

## 3. Partner model

The runtime supports N partners in design, but only one in MVP.

```text
Partner
├─ static profile
├─ dynamic state
├─ memory
├─ relationship
├─ opinions
├─ interests
├─ current goals
├─ presence
├─ capabilities
└─ external identities
```

The first partner is `yukarin`.

Partner state is shared across interfaces. Interface-specific conversation context is isolated.

Example:

```text
shared:
- memory
- relationship
- opinion
- interest
- mood
- energy
- goals

interface-specific:
- Discord channel context
- DM context
- VC state
- future web session state
```

## 4. Durable Objects

Use one Partner Durable Object per partner.

Responsibilities:

- current Partner State
- presence
- short-term conversation state
- per-partner serialization / concurrency control
- current state SSE feed for admin
- lazy loading of persistent state

D1 remains the durable source for long-term data.

DO boot behavior:

- restore minimum state quickly
- lazy-load persistent details only when required

## 5. Data responsibilities

### Durable Objects

- current state
- presence
- short-term session context
- concurrency serialization

### D1

- facts
- episodes metadata
- relationship events/history
- opinions
- interests
- open loops
- entities/relations
- audit summaries
- operational configuration
- feature flags
- snapshot metadata

### Vectorize

Projection/index for semantic retrieval.

Not a source of truth.

Rebuild from D1 when needed.

### R2

- temporary image/audio/artifact storage
- encrypted snapshots/backups
- lifecycle-managed temporary content

## 6. LLM architecture

```text
Yunomi
├─ LLMProvider interface
│  └─ ClaudeProvider (MVP)
├─ PromptBuilder
├─ StructuredOutputSchema
└─ ModelRouter
```

MVP provider: Claude only.

Initial behavior:
- prod: Sonnet default
- dev: Haiku default
- important or quality-validation flows may use Sonnet
- fallback: Sonnet → Haiku on latency/failure

Future providers may include local models.

## 7. Structured output

Normal conversational LLM calls return one structured response including:

- utterance
- reply policy
- decision summary
- emotion delta
- state delta
- relationship delta
- interest delta
- memory candidates
- open-loop updates
- tool intents
- optional review requirement

Important operations may trigger a second review stage.

## 8. MCP / capability boundary

External abilities are not embedded directly in Partner logic.

Examples:

- A.I.VOICE (speech organ; see `body.md`)
- Calendar
- GitHub
- Home Assistant
- ComfyUI
- WOL
- local services

Rule:

- capability implementation = external / MCP / node
- policy for using a capability = Yunomi core

## 9. Discord as embodiment

Discord is a primary embodiment, not merely an incidental UI.

Discord-specific state may include:

- current channel
- VC membership
- who is present
- recent message flow
- typing state
- reactions
- bot notification events

Externally, Yukarin should feel like a participant in Discord, not a command-driven assistant.

Discord behavior is one faculty of the Partner's body (see `body.md`).
