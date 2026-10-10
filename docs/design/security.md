# Security and Permissions

## Admin UI

Use Cloudflare Access.

Personal use:
- allow only the owner

No custom login system.

## Home Agent authentication

Use machine-oriented Cloudflare Access Service Token or equivalent.

Optionally add request signing if needed.

## Secrets

Separate:

### Common secrets
- Claude API key
- shared system credentials

### Partner-specific secrets
- Discord bot token
- Partner-scoped MCP credentials
- identity-specific credentials

Secrets do not belong in snapshots.

## Tool permissions

Per Partner / operation category:

- auto
- confirm
- deny

High-risk actions require explicit confirmation.

Discord confirmation:
- natural explanation
- buttons for execute / cancel

## Self-management

Yukarin may use internal management capabilities within policy.

Allowed examples:
- Open Loop maintenance
- memory candidate cleanup
- bounded Relationship update
- bounded Interest/Opinion update

Forbidden self-modification:
- official persona core
- permission policy
- foundational identity
- secrets
- unrestricted capability access

All self-updates:
- bounded
- audited

## Backup

Encrypt before storage.

Encryption key:
- stored separately from backup location

Store backup in:
- R2
- separate failure domain (home or GCP)

## dev safety

Prod snapshots may seed dev.

But dev external actions:
- disabled by default

Dev must not accidentally:
- write prod Calendar
- send prod Discord events
- run destructive MCP actions
- notify real external systems

## Public IDs

Use UUID v7 internally.

Where timestamp inference is undesirable:
- use UUID v4 / random opaque token
