# Reply Dashboard — Front-inspired shared inbox for 10–15 cold-outreach mailboxes.

## Stack
- `frontend/` — Vite + React + TypeScript + TanStack Query
- `backend/` — Express + Prisma + BullMQ + Google/Microsoft mailbox sync & reply
- `packages/contracts/` — shared API types

## Auth model
- **Identity**: local email session (`POST /api/auth/login`) — no Clerk
- **Mailboxes**: direct Google or Microsoft OAuth with mail scopes (or `MAILBOX_MOCK=true`)

## Quick start
```bash
cp .env.example .env
# also copy into backend/.env and frontend/.env (or symlink)
docker compose up -d
npm install
npm run db:push -w backend
npm run build -w @reply/contracts
npm run dev
```

- Frontend: http://localhost:5180
- Backend health: http://localhost:4000/api/health

With `MAILBOX_MOCK=true` (default when OAuth client IDs are empty), mailbox connect/sync/send skip the real provider APIs — used by the automated tests, which create their own fixtures. No sample data is seeded.

## Real mailbox OAuth
Set `MAILBOX_MOCK=false` and configure:
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, redirect `GOOGLE_REDIRECT_URI`
- Microsoft: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, redirect `MICROSOFT_REDIRECT_URI`

Required scopes include Gmail read/modify/send or Microsoft Graph `Mail.Read` / `Mail.ReadWrite` / `Mail.Send` + `offline_access`.

## AI layer (Claude)
Set `ANTHROPIC_API_KEY` to enable:
- **Intent classification** (Claude Haiku): every inbound reply is classified against the internal taxonomy with a confidence score; under 0.7 it routes to the Needs Review queue. The AI's original label is immutable; operator corrections are tracked separately (correction-rate metric).
- **Draft generation** (Claude Sonnet): editable AI drafts with regenerate-with-instruction; never fabricates specifics — defers to a call.

Without a key the PRD-mandated fallbacks apply: classification routes to Needs Review, drafts fall back to a template. Never a silent drop, never a blank editor.
