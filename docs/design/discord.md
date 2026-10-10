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

General future rule:
- user enters VC → Yukarin normally follows
- presence states may prevent joining
- user leaves → Yukarin leaves
- `sleeping` may produce no response
- explicit invite while busy may result in a text explanation

Home Docker owns the always-on Discord Gateway.

No HA/failover requirement when Home is down.
