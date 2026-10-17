# Memory Architecture

## Goals

Yunomi should behave like a persistent partner, not a stateless chat wrapper.

Memory is split into:

1. Fact
2. Episode
3. Relationship Event

Additionally:
- recent conversation
- conversation summary
- daily machine summary
- partner journal
- Opinion State
- Interest State
- Open Loops

## Storage

### D1
Source of truth for:
- Facts
- Episodes metadata/content
- Relationship Events
- Opinion/Interest
- Open Loops
- summaries
- candidate memories

### Vectorize
Semantic projection for:
- Episodes
- compressed episode clusters
- journal/searchable semantic memory

Vectorize is rebuildable from D1.

### Durable Object
Current short-term state only.

## Retrieval

Do not search memory on every turn.

Decision:
- explicit rules detect obvious recall need
- ambiguous cases may ask a lightweight LLM classifier

Examples of obvious retrieval triggers:
- "前に"
- "この前"
- "覚えてる？"

When retrieval runs:

```text
broad candidate retrieval
→ rerank
→ only a small subset enters Prompt
```

Reranking signals:

- semantic similarity
- importance
- recency
- relationship relevance

Base implementation:
- weighted scoring

Optional:
- LLM rerank on top candidates only

Store candidate/adopted/rejected retrieval data in short-lived Audit for tuning.

## Prompt memory budget

Memory does not get unlimited context.

Prompt blocks have token budgets.

Priority under fallback:
1. Persona
2. Relationship / current State
3. recent conversation
4. Fact / Episode memory
5. extra event/tool context

When reducing context, memory/episode context should shrink before persona identity.

## Memory writes

Hybrid decision:

- deterministic rules for explicit facts
- LLM judgment for experiences / relationship events

Every memory should track:

- confidence
- source
- observed_at
- importance
- decay policy

## Contradictions

Explicit user correction has priority.

Policy:
- clear replacement: update current value, preserve historical trail
- ambiguous conflict: create candidate / review
- explicit delete: physically delete requested memory
- automatic state evolution: old state may remain in history

## Memory candidates

Candidate queue must support:

- source
- confidence
- importance
- conflict target
- proposed change
- TTL
- re-evaluation

Re-evaluate:
- when new relevant information arrives
- near TTL
- during daily processing

## Forgetting

Default "forgetting" is retrieval decay, not physical deletion.

Old low-importance memory:
- becomes harder to retrieve
- may be compressed
- may become deletion candidate if low importance and unused for long periods

MVP behavior:
- A Fact's `decay_policy` is `standard` (lasting: name, preference, residence, job) or `episodic` (a plan or one-off event).
- Episodic Facts appear in the prompt with the date they were heard (JST).
- Once 3 or more JST calendar days have passed, an episodic Fact moves to a section the partner does not bring up on its own.
- Nothing is deleted.

## Compression

Similar Episodes may be clustered.

Keep:

- representative summary
- references to source Episodes

Normal retrieval may use the compressed summary.
Deep recall can still access source episodes.

Run compression:
- scheduled batch
- threshold-triggered batch
- never synchronous in conversation path

Cron triggers Workflows for heavier processing.

## Daily summary

Lifestyle-day based.

Generate only if activity occurred.

Produce both:

### Machine summary
Objective, structured, retrieval-oriented.

### Partner journal
Yukarin's subjective view of the day.

The journal:
- is immutable once written
- may later receive reinterpretation records
- may influence self-concept and Relationship weakly
- participates in semantic search

Use:
- Haiku normally
- Sonnet when relationship change / important episodes warrant higher quality

Daily summary may also extract:
- Fact candidates
- Episode candidates
- Relationship Event candidates

## Snapshot

Snapshot is a first-class portability mechanism.

Uses:
- backup
- restore
- prod → dev seed
- disaster recovery
- local debugging

### Partner Snapshot

Required sections:
- schema version
- profile version
- Memory
- Relationship
- Opinion
- Interest
- Open Loops

Optional:
- Episodes
- audit summaries
- operational state
- recent conversation summary/current state for dev seed

Excluded:
- Secrets
- Discord token
- raw logs
- temporary R2 image content

Format:
- manifest + multiple files

Example:
- `manifest.json`
- `memory.jsonl`
- `episodes.jsonl`
- `relationship.json`
- `opinions.json`
- `open_loops.json`

Migration:
- automatically migrate compatible versions
- destructive/ambiguous changes require explicit review/error

Support:
- Partner Snapshot
- optional System Snapshot aggregating multiple Partners

Creation:
- daily
- before significant migrations/relationship changes
- manual `ykm snapshot create`

Retention:
- daily generations
- weekly generations
- monthly generations
- explicitly retained pre-change snapshots

Backups:
- encrypted before storage
- key stored separately
- keep in R2 plus a separate failure domain such as home or GCP
