# Events

## Event model

Use a common Envelope + event-specific payload.

Envelope:

- event_id
- type
- source
- partner_id
- occurred_at
- received_at
- schema_version
- payload

ID:
- UUID v7 by default

## Runtime validation

Use:
- TypeScript types
- Valibot at boundaries

Boundary:
- validate with Valibot
- convert into internal domain types

Internal domain should not depend directly on external schema objects.

## Queue usage

Only non-immediate work goes async.

Do not place the primary user response path behind Queue.

## Ordering

Partner-level state mutation:
- serialize through Partner DO

External events:
- may arrive late/out of order
- preserve `occurred_at`
- delayed events must be re-evaluated before mutating current state

## Dedupe

Preferred:

```text
source + event_id
```

Fallback:
- content hash
- time window

## Rate limits

Per:
- user
- Partner
- external event source

Rate-limit handling depends on event class.

- user speech/message: do not silently drop if avoidable
- spontaneous speech: suppress
- bot alerts: aggregate
- duplicate events: dedupe/drop

## External event sources

MVP:
- Discord notification/alert bots

Design interface for:
- Calendar
- Gmail
- GitHub
- Home Assistant
- custom webhook

## Calendar

Not first vertical slice.

Future:
- Google Calendar is the source of truth
- Yunomi does not duplicate calendar data
- read when needed
- write only after explicit confirmation
- external calendar events may trigger proactive speech

No internal two-way calendar model.

## Domain events

Important failures/state changes may become Domain Events.

Examples:
- MemoryWriteFailed
- ToolExecutionFailed
- PartnerEnteredDegradedMode
- RelationshipUpdateRejected
- ExternalServiceRecovered

Event sourcing is NOT used.

Current state remains the source of truth.
Domain Events are history/audit.
