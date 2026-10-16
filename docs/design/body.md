# Body

The Partner has a body: the faculties through which the character acts in the world.

## Faculties

- speech — implemented first
- hearing — designed, not implemented
- Discord behavior — text, presence, reactions, VC membership (see `architecture.md` "Discord as embodiment")

## Layers

```text
heart  (core)
  persona, values, emotion, relationships, memory contents
        ▲ reads / proposes changes (the heart decides whether to accept)
brain  (core)
  perceives, recalls, thinks (the LLM is its organ), decides
  intent: what to say, semantic performance IR per segment
  (emotion, energy, pace, warmth, pauses), by voice or not
        │ intent                ▲ body state, perceptions
body   (core, logic in packages/core)
  turns IR into engine-specific instructions using the character's voice profile
  coordinates organs (wake, wait, deliver) and keeps body state
        │
organ  (anywhere; e.g. ochoko on the GPU box)
  executes the instructions (text + engine values -> WAV)
```

The three core layers are defined in `principles.md`. Relays (the Gateway, a tunnel) may carry instructions and results between the core and an organ. They relay only and do no mapping.

- The LLM does not call TTS as a tool. Speaking is a decision of the core, carried out through the speech organ.
- The brain never emits engine-specific parameters.
- The body owns the IR -> engine mapping; the organ has no character knowledge.

## Body state

The Partner knows the state of its body and behaves accordingly.

- states: can speak / asleep / waking / unavailable
- the core derives body state from each organ's availability, however the organ is reached
- asleep and waking still count as able to speak: when the character chooses to speak, the body wakes the organ and the voice arrives late
- example: when the character cannot speak, it replies in text and does not offer to join a VC

## Scope

- speech: implemented now (see `voice.md`)
- hearing: designed in `voice.md`, not implemented; until then the character knows it cannot hear
- Discord behavior: as described in `discord.md`
