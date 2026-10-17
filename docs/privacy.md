# Privacy Policy

yunomi is a personal AI partner runtime. This deployment is operated by its owner for the owner's own use. It is not offered to other users.

## Data accessed

With the owner's consent, yunomi accesses the owner's Google Calendar through the Google Calendar API (scope `https://www.googleapis.com/auth/calendar.events`):

- It reads events for a requested period, to answer the owner's questions about their schedule.
- It creates an event only after the owner explicitly confirms it in the conversation.

## Use and storage

- Event data is used only to answer the owner in the conversation. It is not used for advertising or for training models.
- Event titles and descriptions are not stored by yunomi. The audit log keeps only the time range and the number of events.
- To produce a reply, the conversation, including event data, is sent to the LLM provider (Anthropic).
- The OAuth refresh token is stored as an encrypted secret of the Cloudflare Worker.
- Data is not sold or shared with any other third party.

## Revoking access

The owner can revoke access at any time from "Third-party apps & services" in their Google Account settings (https://myaccount.google.com/connections).

## Contact

Open an issue at https://github.com/ochanuco/yunomi/issues.
