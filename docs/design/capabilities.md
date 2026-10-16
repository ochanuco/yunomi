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
