# Body

The Partner has a body: the faculties through which the character acts in the world.

## Faculties

- speech — implemented first
- hearing — designed, not implemented
- Discord behavior — text, presence, reactions, VC membership (see `architecture.md` "Discord as embodiment")

## Layers

```text
mind   (Worker / LLM)
  decides what to say and how:
  semantic performance IR per segment (emotion, energy, pace, warmth, pauses)
        │
body   (Worker / Partner DO, logic in packages/core)
  turns IR into engine-specific instructions using the character's voice profile
        │
organ  (external MCP server on the GPU box)
  executes the instructions (text + engine values -> WAV)
```

The Gateway is the nerve: it relays the body's engine-specific instructions from the Worker to the organ and audio back toward Discord and the Worker. It does no mapping of its own.

- The LLM does not call TTS as a tool. Speech instructions are returned in the Worker's response to the Gateway's event request.
- The mind never emits engine-specific parameters.
- The body owns the IR -> engine mapping; the organ has no character knowledge.

## Body state

The Partner knows the state of its body and behaves accordingly.

- states: can speak / asleep / waking / unavailable
- the Gateway reports body state to the Worker
- example: when the character cannot speak, it replies in text and does not offer to join a VC

## Scope

- speech: implemented now (see `voice.md`)
- hearing: designed in `voice.md`, not implemented; until then the character knows it cannot hear
- Discord behavior: as described in `discord.md`
