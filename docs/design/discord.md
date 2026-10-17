# Discord Behavior

## Role

Discord is a primary embodiment of the Partner.

The UX should feel like:

> Yukarin exists in the server.

Not:

> Use commands to operate an AI bot.

## Text interaction

Default:
- can be mentioned in any channel
- mention does not guarantee reply
- continued conversation may proceed without repeated mentions

Continuation detection:

- recency of Yukarin's last reply
- same-channel context
- LLM judgment when ambiguous

## reply / ignore

Use hybrid logic.

- deterministic rules handle obvious cases
- LLM handles ambiguous social decisions

MVP should start biased toward replying, but must support intentional silence from the first vertical slice.

Audit:
- reply / ignore
- short decision summary
- no private chain-of-thought

## Sending a reply

A reply is a list of Discord messages (`messages`, 1–10, each ≤ 2000 characters).

- Splitting is the model's choice, instructed in `TASK_BLOCK`: casual chat may be a few short messages; explanations, serious topics, and anything that reads as one unit stay in one message. The Worker never splits text mechanically.
- `performance` and `speak_aloud` apply to the whole reply.
- The Worker sends in order. Before each message after the first it shows typing and waits `min(600 + 40 × characters, 2500)` ms, counting the characters of the message about to be sent. The gaps in one reply total at most 8000 ms; once that is spent, the rest go out without a gap, keeping the turn well inside the Gateway's 60 s wait.
- Only the first message may be a Discord reply, and only when another message sits between the trigger and the reply (`hasMessagesAfter`). Later messages are plain.
- Each message carries `nonce = <inbound message id>:<index>` (≤ 25 characters) with `enforce_nonce: true`, so reprocessing the same inbound message does not post duplicates while Discord still remembers the nonce.
- If a send fails, the remaining messages are not sent. Each sent message gets its own `recent_messages` row (`partner:<id>:<index>`) bound to its Discord id; unsent messages are not recorded.
- Voice follows the messages: in VC, `voice.speak_queue` has one entry per sent message and the Gateway queues them in order; in a text channel, each sent message gets its own WAV attachment job.
- The Worker and the Gateway deploy separately, so the response keeps the single-message fields: `reply.content` (all messages joined by newlines, or the first one if that exceeds 2000 characters) with the first `partner_message_id`, and `voice.speak` (the first entry). An older Gateway ignores `messages` and `speak_queue` and sends or speaks one item; a newer Gateway falls back to `content` and `speak` when the new fields are absent.

## Spontaneous speech

Not in first vertical slice.

Design now, implement after reactive conversation stabilizes.

Inputs may include:
- current conversation
- current State
- Interest
- recent Episodes
- Open Loops
- external events

Suppression:
- cooldown
- current conversational situation
- recent ignored speech
- living rhythm
- character parameters:
  - initiative
  - interruptiveness
  - patience
  - event_interest

## Notification bots

Bots are not normal conversation participants.

However alert/status/notification messages may be converted into external events.

Reaction decision can use:
- importance
- current conversation
- Partner interests

## Channels

Architecture supports per-channel policy.

MVP default:
- same behavior in all channels

Later overrides may mark:
- chat
- development
- alerts
- ignore

Recent conversation:
- isolated per channel

Shared:
- Partner State
- Relationship
- long-term Memory

Cross-channel context:
- only retrieve other channel summaries when needed

## DM

Supported in design.
Low priority in MVP.

DM uses:
- separate recent conversation context
- shared long-term state

## Attachments / images

MVP first vertical slice:
- retain attachment metadata only

Later behavior:
- image attached → store temporarily in R2 without analysis
- later "read that image" may resolve reference and invoke vision
- rule narrows candidate images
- LLM resolves ambiguity when multiple remain

R2 lifecycle:
- short TTL if never referenced
- extend TTL if referenced
- explicit "remember this" may retain longer

If content no longer exists:
- treat it as unavailable
- do not invent or reconstruct

Long-term Memory may keep a semantic summary if important.

## Voice (future)

Discord VC will later be the primary voice interface.

The Worker decides and the Gateway executes: the Gateway reports voice-state changes, and the Worker answers join / leave / ignore. Following requires relationship tier "親しい" or higher (`apps/worker/README.md`).

General rule:
- user enters VC → Yukarin normally follows
- presence states may prevent joining
- user leaves → Yukarin leaves
- `sleeping` may produce no response
- explicit invite while busy may result in a text explanation

Home Docker owns the always-on Discord Gateway.

No HA/failover requirement when Home is down.
