# Core and Organs

Yunomi keeps its core on Cloudflare and treats everything else as replaceable organs attached to it.

## Principles

1. Decisions and state live only in the core (Cloudflare: Worker + Partner DO): identity, persona, memory, relationship and emotional state, body state, and every decision about what the Partner says and does.
2. Organs only execute and sense. They hold no character knowledge and make no decisions.
3. The core defines one interface per faculty, and organs attach to it through adapters. Where an organ runs and how it is reached (external API, Cloudflare binding, the home network through the Gateway, Cloudflare Tunnel + Access) stays inside the adapter. The core never assumes a location or a transport.
4. Relays may sit between the core and an organ (the Discord Gateway, a tunnel). They relay only; they hold no state and make no decisions.
5. When an organ is unavailable, the core keeps running and the Partner experiences it as body state (see `body.md`).

## Faculties and organs

| Faculty | Interface owned by the core | Current organ | Possible replacements |
|---|---|---|---|
| thinking aid | LLM provider (`packages/llm`) | Claude API | another Cloudflare-hosted model; a local LLM on the GPU box |
| speech | text + engine values -> audio | `ochoko` (A.I.VOICE, GPU box) | an organ for another voice engine |
| communication | receive / send messages | Discord (the Gateway holds the persistent connection) | — |
| sight (future) | image -> observations | none | — |
| hearing (designed) | audio -> text | none | — |

## The mind and the LLM

The mind is part of the core: persona, memory, state, and how the Partner decides what to say. The LLM is an organ that assists the mind's thinking. Replacing the LLM must not change who the Partner is.

## Adding or replacing an organ

- write an adapter for the faculty's interface
- for speech, add a realization for the new engine to the voice profile (`voice.md`)
- report the organ's availability so the core can reflect it in body state
- keep decisions out of the organ and its relay
