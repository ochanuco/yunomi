# Observability

## Audit

Short-lived detailed audit should record:

- inbound message/event
- reply/ignore/defer decision
- model selected
- fallback
- decision summary
- memory retrieval candidates
- memory selected/rejected
- state deltas
- relationship deltas
- tool/capability calls
- external events
- spontaneous-speech decisions

Do not store private chain-of-thought.

Use short operational decision summaries only.

## Storage split

Workers Logs:
- raw/debug logs

Analytics Engine:
- operational metrics

D1:
- searchable audit summaries
- long-term daily KPI aggregates

## Admin UI

Read-only.

Initial pages:
- Partner State
- Memory
- Audit

Later:
- Relationship
- Open Loops
- Memory Candidates
- External Events
- costs
- workflow failures
- snapshot status

Real-time:
- normal pages may poll
- State/Audit may use SSE
- WebSocket only if future bidirectional need appears

SSE source:
- Partner DO

## SLO/metrics

Monitor:

- Discord receive → reply success rate
- response latency p50/p95
- Claude failures
- fallback rate
- Queue failure/backlog
- Memory read/write failures
- capability/MCP failures
- degraded mode frequency

## Long-term KPI

Daily aggregate in D1:

- success rate
- p50/p95 latency
- fallback rate
- reply/ignore rate
- memory writes
- spontaneous speech rate
- tool/capability failure rate

Use lifestyle-day boundary (default 05:00 JST) where appropriate.

## Cost monitoring

Track daily estimate for:

LLM:
- model
- input tokens
- output tokens
- cache usage
- estimated cost

Cloudflare:
- Workers
- DO
- Vectorize
- R2
- Queue
- other major resources where practical

## Cost control

Use:
- total monthly budget
- API credit balance
- daily burn rate

Suggested policy:
- ~70%: warning
- ~85%: prefer Haiku for light conversations
- ~95%: Sonnet only for important conversations
- near 100%: suppress high-cost optional work

Budget policy:
- global budget
- per-Partner soft budget / priority
- unused budget can be shared

Do not expose normal model fallback to user unless functionality/quality meaningfully degrades.
