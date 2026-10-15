# Body

The Partner has a body: the faculties through which the character acts in the world.

## Faculties

- speech — implemented first
- hearing — designed, not implemented
- Discord behavior — text, presence, reactions, VC membership (see `architecture.md` "Discord as embodiment")

## Layers

```text
mind   (core: Partner DO)
  persona, memory, state; decides what to say and how:
  semantic performance IR per segment (emotion, energy, pace, warmth, pauses)
  the LLM is an organ that assists its thinking
        │
body   (core: Partner DO, logic in packages/core)
  turns IR into engine-specific instructions using the character's voice profile
        │
organ  (anywhere; e.g. ochoko on the GPU box)
  executes the instructions (text + engine values -> WAV)
```

Relays (the Gateway, a tunnel) may carry instructions and results between the core and an organ. They relay only and do no mapping. See `principles.md`.

- The LLM does not call TTS as a tool. Speaking is a decision of the core, carried out through the speech organ.
- The mind never emits engine-specific parameters.
- The body owns the IR -> engine mapping; the organ has no character knowledge.

## Body state

The Partner knows the state of its body and behaves accordingly.

- states: can speak / asleep / waking / unavailable
- the core derives body state from each organ's availability, however the organ is reached
- example: when the character cannot speak, it replies in text and does not offer to join a VC

## Scope

- speech: implemented now (see `voice.md`)
- hearing: designed in `voice.md`, not implemented; until then the character knows it cannot hear
- Discord behavior: as described in `discord.md`
