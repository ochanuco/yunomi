# Infrastructure

## Cloudflare first

MVP uses Cloudflare as the primary cloud platform.

Use:
- Workers
- Durable Objects
- D1
- Queues
- Workflows
- R2
- Vectorize
- Analytics Engine
- Workers Logs
- Cloudflare Access
- Cron Triggers

## cf CLI

Start with:

- `cf`
- `cloudflare.config.ts`

Do not start new config around `wrangler.jsonc` unless a feature currently requires Wrangler.

Wrangler may be used selectively where `cf` beta lacks functionality.

## Vite

Use Vite only for Admin Web.

Do not require Vite for the main API/Discord Worker.

Admin:
- Vite
- TypeScript
- plain DOM
- no React
- no Lit initially

## Low-level infra boundary

A separate infrastructure repository owns:

- account-level resources
- shared network/account infrastructure
- general Cloudflare/GCP foundations
- low-level IaC

`ochanuco/yunomi` owns app-scoped resources:

- Yunomi Workers
- Partner DO bindings
- D1
- Yunomi-specific R2
- Yunomi-specific Queues
- Vectorize
- cron/workflow app resources
- application config

## Cloud abstraction

Application layer should depend on interfaces.

MVP implementations are Cloudflare optimized.

Examples:

```text
EventBus interface       -> Cloudflare Queues
VectorStore interface    -> Vectorize
BlobStore interface      -> R2
PersistentStore          -> D1
Partner runtime locking  -> Durable Objects
```

Do not over-engineer alternate providers before needed.

## EventBus

EventBus is an application interface, not a separate service.

MVP implementation:
- Cloudflare Queues

Only asynchronous/non-response-critical work should go through Queue.

Synchronous reply path stays direct.

Queue candidates:
- memory extraction
- Episode creation
- Relationship updates
- audit persistence
- external event processing
- spontaneous speech evaluation

## Workflows

Use Workflows for:
- Episode compression
- Snapshot create/restore
- Vectorize rebuild
- Profile migration
- large memory maintenance

Trigger periodic jobs with Cron.

Workflow failure:
- automatic retry
- persistent failure record
- retry from Admin/CLI
- default replay with same input
- explicit override only when necessary and audited

## dev / prod

Start with:
- dev
- prod

Add staging only when genuinely needed.

Separate physically:
- Discord bot
- D1
- R2
- Vectorize
- other stateful resources

## prod → dev seed

Use Partner Snapshot, not ad-hoc D1 dumping.

dev seed should be able to restore:
- Memory
- Relationship
- Opinion
- Interest
- Open Loops
- recent conversation summary
- current State

Vectorize:
- rebuild from source data

Exclude:
- prod Secrets
- prod Discord identity
- temporary image storage
- raw logs

External integrations in dev:
- disabled by default
- explicitly opt in

Spontaneous speech in dev:
- evaluate normally
- suppress actual send by default
- log "would have spoken"

## GCP

Not used by default.

Potential extension:
- BigQuery
- Cloud Run
- heavier ML/batch
- secondary backup target

Cost is a reason to avoid GCP unless needed.
