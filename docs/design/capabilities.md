# Capabilities and MCP

## Principle

MCP/capability implementations are external.

Yunomi owns:
- when to use them
- whether they are allowed
- confirmation policy
- how results affect state/memory

## Permission model

Per Partner, per operation category:

- `auto`
- `confirm`
- `deny`

Confirmation UX in Discord:
- natural-language explanation
- explicit Discord buttons for execute/cancel

## Capability abstraction

Yunomi core uses a common contract:

- CapabilityRequest
- CapabilityResponse

Nodes translate this into:
- MCP
- HTTP
- local APIs
- other protocols

## Placement in the core

Tools are a layer of their own in the core, beside the body, not inside it.

```text
brain                 turn loop; the LLM proposes tool calls
  │ tool call
  ▼
capability gate       reads the Partner's capability policy
  │ auto: run / confirm: store as pending and ask back / deny: reject
  ▼
capability adapter    location and transport stay inside
  │
  ▼
external service      Google Calendar, Gmail, a Home Node MCP, ...
```

- The brain decides whether to use a tool. It has no path to an adapter except through the gate.
- Results return to the brain as untrusted input. The heart is never changed by a result directly; the brain may propose a memory candidate.
- The body drives organs (speech, hearing) and owns body state. Tools are single request/response calls whose concerns are permission, idempotency and confirmation, so they stay out of the body.
- An unreachable tool is not body state. The brain knows which tools are available.

## Tool definitions and the LLM

- Tool definitions are provider-independent. The LLM adapter translates them into the provider's format (Anthropic `tools`).
- The tool set is fixed per Partner, so the prompt cache holds across turns. The gate, not the tool list, rejects calls by speaker or channel.
- Provider-side tools (web search as an Anthropic server tool) run inside the LLM call. They stop working when the LLM is replaced, and they are audited from the response.

## Confirmation flow

- A `confirm` call is stored as a pending operation in the Partner DO, and the Partner asks back in its reply.
- A later turn confirms or cancels it. Pending operations expire.
- The MVP confirms through the reply text. Discord buttons come later.

## Packages

```text
packages/core           shared types (Result, DomainError, IDs)
packages/capabilities   contract, tool definitions, policy, pending state machine,
                        adapter port, adapters that use fetch only
packages/llm            ToolSpec -> provider tools
apps/worker             wiring: secrets, pending store (DO SQLite), audit, turn loop
```

`packages/llm` and `packages/capabilities` do not import each other. The worker maps capability definitions to `ToolSpec`.

## Multiple partners

- Code is shared. Policy, credentials, pending operations and audit are per Partner.
- Each Partner gets its own OAuth grant, even for the same account, so one grant can be revoked alone and audit shows which Partner acted.
- An external service such as a calendar is shared world state, not shared character state. A Partner that reads an event another Partner created has looked at the calendar, not at the other Partner's memory.
- Writes carry an idempotency key derived from the source message, so two Partners answering the same request do not write twice.

## Fixed node routing

No dynamic HA/load scheduling required.

Example mapping:

```text
discord.gateway -> home
aivoice         -> gpu-box
lan.control     -> home
comfyui         -> gpu-box
stt.gpu         -> gpu-box
llm.local       -> gpu-box
```

## Node offline behavior

Per capability:

- `fail`
- `defer`

Examples:
- A.I.VOICE: `fail`; the Partner knows it cannot speak (see `body.md`)
- ComfyUI: may defer
- Discord Gateway: unavailable if Home is down

## Per-capability execution policy

Fields:

- timeout
- cancelable
- retryable

## Home Node

The Linux Docker host at home.

Potential capabilities:

- Discord Gateway
- LAN controls
- lightweight STT
- local utility MCPs

## GPU Box

Windows machine. It sleeps when idle and is woken via wake-on-LAN (wol service).

Potential capabilities:

- A.I.VOICE organ (`ochoko`; requires Windows + COM, see `voice.md`)
- ComfyUI
- GPU STT
- local LLM
- heavy ML workloads

## Audit

For capability execution record:

- request summary
- response summary
- node
- latency
- result
- retry count

Strip:
- secrets
- credentials
- private raw payloads not needed for audit

## Tool execution result memory

Audit logs are separate from character memory.

Only meaningful results may become Episodes.

Examples:
- significant success/failure
- outcome that affects user
- result likely to matter later
