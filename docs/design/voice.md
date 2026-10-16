# Voice Architecture (Post-MVP)

Voice is not part of the first vertical slice. Speech and hearing are faculties of the Partner's body (see `body.md`). Speech is implemented first; hearing is designed here but not implemented.

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
→ body: IR to A.I.VOICE values (voice profile)
→ A.I.VOICE organ (ochoko, GPU box)
→ Discord VC output
```

Until hearing exists, only the output half applies: users talk to the Partner through the VC's text chat, and the Partner knows it cannot hear.

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

Current engine: A.I.VOICE (1) only. Its Editor API is the only one usable programmatically.

Do not let the LLM emit raw vendor-specific voice parameters as the primary semantic interface.

The brain emits a semantic performance/prosody IR.

Example:

```text
emotion: amused
energy: 0.6
pace: slightly_fast
warmth: 0.8
pause_before_ms: 120
```

The body maps the IR to A.I.VOICE values using the voice profile. This makes the engine replaceable.

### Voice profile

Lives with the character in `partners/yukarin`.

- engine-independent traits: baseline pace/pitch, how readily emotions show
- per-engine realization: for A.I.VOICE, which preset, how emotions map to the preset's style values, master values
- an engine can hold several named realizations plus a default; a preset without styles (e.g. the 雫 preset) sends no `Styles`
- the environment only selects a realization by name (`VOICE_REALIZATION`: production `yukari`, development `shizuku`); an unknown name falls back to the default with a warning
- adding an engine = adding a realization

### Organ (`ochanuco/ochoko`)

Separate public repo, "Voice MCP for yunomi".

- thin C# MCP server: receives text plus A.I.VOICE-specific values, returns WAV
- no IR, no character knowledge
- further engines get their own organ inside `ochoko`
- the tool interface is defined in the `ochoko` repo
- runs on the GPU box because A.I.VOICE requires Windows + COM
- listens on LAN `:8190`; Bearer token auth, with separate tokens for dev and prod callers
- deployed by an external GPU-box app deployer (Release -> deployer -> non-elevated apps runner on the GPU box); the organ repo owns no runner

### Call path

```text
core (Partner DO): the brain decides to speak; the body maps IR to A.I.VOICE values
core -- speech interface --> ochoko adapter -- relay --> ochoko (GPU box)
core <-- WAV
core: delivers the audio through the communication organ (Discord)
```

The Worker cannot reach the home network directly, so the adapter goes through a relay: the Gateway on the LAN, or Cloudflare Tunnel + Access. Which one is an adapter choice (`principles.md`); the core does not depend on it.

### GPU box power

- the core wakes the GPU box through wol when the character decides to speak and the box is asleep; wol is reached the same way as the organ
- while speaking or in VC, the core renews a keep-awake lease on the organ; the organ holds a Windows power request so the box does not sleep
- if the box is unreachable, the Partner's body state is not "can speak" and it behaves accordingly (offline policy `fail`)

### Outputs

- Discord VC playback
- voice attachment in text channels; the character decides whether to attach
- Admin replays past utterances stored in R2; Admin does not synthesize arbitrary text

### VC entry

When invited, the character decides whether to join.

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
