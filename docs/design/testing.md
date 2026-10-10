# Testing and Persona Evaluation

## Test categories

### Unit

Deterministic logic:

- state transitions
- bounded deltas
- permission policy
- rate limit
- dedupe
- time/lifestyle-day calculations
- schema migrations
- Valibot validation

### Conversation E2E

Scenario-based.

Verify:

- message → reply
- message → intentional ignore
- memory persistence
- state persistence
- relationship delta
- fallback
- degraded mode
- audit

### Persona eval

Persona quality is probabilistic.

Do not rely on exact string matching.

Evaluate axes such as:

- politeness
- persona consistency
- official-core consistency
- fanon overuse
- relationship-appropriate distance
- over-agreement
- repetitive joke use
- over-questioning
- always-reply behavior
- spontaneous behavior rate

## Probabilistic evaluation

Treat as statistical quality testing, not strict deterministic pass/fail.

Example metrics:

```text
politeness_score
persona_consistency
over_agreement_rate
reply_rate
fanon_usage_rate
```

Run multiple seeds/samples where useful.

Track:
- mean
- distribution
- variance
- threshold violations

## Evaluation tiers

### Tier 1 — PR

Cheap:

- schema
- deterministic tests
- state transition tests
- static style checks
- basic politeness heuristics
- recurring-joke cooldown tests

### Tier 2 — main/nightly

Moderate cost:

- scenario generation
- lightweight classifier
- LLM judge
- distribution tracking

### Tier 3 — release/persona changes

Expensive:

- larger scenario set
- stronger judge
- human review

JEV or other ML classifiers may be used where useful, but frequency should account for cost.

## Flakiness

LLM output is stochastic.

Do not call expected stochastic variance a conventional flaky test.

Design:
- probabilistic thresholds
- repeated samples
- confidence intervals where useful
- store enough eval metadata to compare regressions
