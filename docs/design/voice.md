# Voice Architecture (Post-MVP)

Voice is not part of the first vertical slice.

Interfaces should be defined early:
- AudioInput
- TTS
- VoiceSession

## Pipeline

```text
Discord VC audio
→ VAD
→ speaker/user stream identity
→ STT
→ Yunomi conversation core
→ structured response + semantic performance
→ A.I.VOICE MCP
→ Discord VC output
```

## VAD

Voice Activity Detection identifies speech intervals.

Use:
- avoid STT on silence
- identify turn boundaries
- reduce cost/noise
- support interruption

Discord provides per-user streams, so voiceprint-based diarization is not necessarily needed for MVP voice.

## STT

Abstract provider.

Design:
- cloud STT
- home/local STT
- GPU STT

Initial voice implementation can start Cloud-first and add local later.

## Interruption

When user speaks while Yukarin is talking:

Do not always stop.

Evaluate:
- timing
- duration
- content

Examples:
- clear interruption → stop TTS
- short backchannel ("うん", "へえ") → continue
- sustained speech → stop and listen

## Clarification

Use:
- STT confidence
- context
- information importance

Examples:
- casual chat → infer more freely
- money/date/tool command → ask again when uncertain

## Silence

Evaluate:
- duration
- previous conversation
- Partner State

Possible behavior:
- wait
- end session
- speak one spontaneous line

## A.I.VOICE

A.I.VOICE is an external capability via MCP.

Do not let the LLM emit raw vendor-specific voice parameters as the primary semantic interface.

Use semantic performance/prosody IR first.

Example:

```text
emotion: amused
energy: 0.6
pace: slightly_fast
warmth: 0.8
pause_before_ms: 120
```

Then map into A.I.VOICE parameters.

This makes voice backend replaceable.

## Performance segmentation

Support utterance segmentation so emotion/prosody can vary within a response.

Example:
- surprised first segment
- pause
- amused second segment

## Voice and persona

The question is not merely:
> How should this text be read?

It is:
> How would this Partner say this right now?
