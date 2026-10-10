# Domain Model

## Partner

A persistent AI entity.

Key identity:

- `partner_id`
- static profile version
- dynamic state version
- external identities
- capability policy
- budget policy
- feature flag overrides

## Partner Profile

Static, Git-managed.

Contains:

- identity
- personality
- dialogue style
- values
- dislikes/boundaries
- interests baseline
- living rhythm
- recurring jokes
- official/fanon/yunomi-specific persona layers
- voice profile placeholders
- capability defaults
- profile schema version

## Partner State

Current mutable state.

Planned fields:

- mood
- energy
- presence
- emotional axes
- short-term goals
- active topic
- recent behavioral state
- system_stress
- degraded_mode

Store current value in Partner DO.
Persist important transitions/events to D1.

## Relationship State

Use both numeric and natural-language representations.

Possible dimensions:

- familiarity
- trust
- closeness
- tension

Also keep:
- relationship summary
- related relationship events
- last summary update
- state version

Do not allow abrupt changes.

## Relationship Event

Fields:

- id
- type
- summary
- occurred_at
- trust_delta
- familiarity_delta
- closeness_delta
- tension_delta
- source
- confidence
- related_episode_id
- reason

The event exists to explain why relationship state changed.

## Interest State

Fields:

- topic
- score
- summary
- baseline
- learned_delta
- last_updated
- source

Interest direction may be suggested by an LLM, but mutation magnitude is constrained by rules.

## Opinion State

Fields:

- topic
- stance
- confidence
- reasons
- source_memory_ids
- updated_at
- stability

Opinions:
- start from initial tendencies
- evolve from experience, values, memory
- change gradually
- should not be recomputed from scratch every turn

## Open Loop

Conversation-level unresolved curiosity or follow-up thread.

Not a generic task manager.

Examples:
- "Tell me how that went."
- "You said the result would be known tomorrow."
- "I'm curious whether that fixed it."

Fields may include:

- id
- summary
- importance
- due_at candidate
- due_confidence
- follow_up_interval
- status
- last_followed_up_at
- source episode/message

## Entity

Generic stable identity.

Examples:

- `user:<id>`
- `partner:yukarin`
- `device:<id>`
- `project:<id>`
- `place:<id>`

Display names are separate from identity.

## Relation

Most relationships may remain Facts.

Important graph-like relationships may be promoted into explicit Relation records.

Promotion is decided by:
- fixed rules
- LLM assistance

## Fact

Use a semantic triple plus metadata.

```text
subject
predicate
object
```

Object is typed.

Examples:
- string
- number
- boolean
- datetime
- entity reference
- quantity with unit
- normalized value + display value

Metadata:

- confidence
- source
- observed_at
- valid_from
- valid_to
- importance
- decay policy

## Episode

Fields:

- id
- summary
- occurred_at
- participants
- importance
- source
- emotional impact
- related entities
- relationship impact
- embedding metadata

## Error model

Errors must carry semantic type.

Domain errors:
- discriminated unions

Boundary/external wrappers:
- classes where useful

Examples:

- MemoryConflict
- InvalidStateTransition
- RelationshipUpdateRejected
- PermissionDenied
- ToolExecutionRejected
- ExternalServiceUnavailable
- RateLimited
- ValidationFailed

Error semantics should expose:

- retryable?
- user-visible?
- degraded-mode effect?
- audit severity?

Unexpected programming errors may throw.

## IDs

Default:
- UUID v7 for internal/distributed IDs

Use random/non-time-revealing identifiers where timestamp inference would be undesirable.

## Time

Internal:
- UTC

Human-visible / conversational:
- Asia/Tokyo / JST

Support lifestyle clock expressions up to 29:59.

Default lifestyle-day boundary:
- 05:00 JST

The lifestyle-day boundary affects:
- "today/yesterday/last night"
- daily summaries
- daily metrics
- partner rhythm
- snapshots where appropriate
