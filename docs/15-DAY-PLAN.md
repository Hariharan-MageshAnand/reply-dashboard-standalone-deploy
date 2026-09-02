# Reply Intelligence Hub — 15-Day Build Plan

**Build lead:** Sajda · **Advisory:** Hari · **PM:** Sugandha
**Window:** Tue Aug 26 → Tue Sep 15 (15 working days) · **Pilot starts:** Wed Sep 16
**Full detail & estimates:** see `docs/DELIVERY_PLAN.md` · **Demo:** https://reply-intelligence-hub-1.vercel.app/

---

## What ships on day 15

The **pilot-ready core**: from Sep 16, Jomart handles real replies in this tool — with Front kept open as a safety net, not decommissioned yet.

- Unified inbox on the real sequencing mailboxes (Google + Microsoft, direct API — no Clerk) — with **warm-up/test-email keyword filtering** so the inbox isn't flooded with automated noise
- AI classification (Claude): trustworthy internal taxonomy, confidence score, Needs Review queue for anything under 0.7
- AI-drafted responses (Claude) with edit / regenerate-with-instruction, template fallback
- **Send / Send and Archive / Send Later** on the same thread — hard double-send protection, full draft→sending→sent/failed state machine, scheduled sends auto-cancel if the contact replies first
- **Wrong Person (pilot-minimal):** redirect contact identified from the reply and matched against Salesforce where possible; Jomart drafts and sends manually — no AI draft, no automation, for this pilot
- Snooze + automatic resurface
- Salesforce: context read (Engine, EDIE, Industry, Sequence, Prior Reply Count, Company Description) + status write-back with retry queue and visible sync status

## Week-by-week

| Week | Dates | Deliverable | Checkpoint |
|---|---|---|---|
| **1** | Aug 26 – Sep 1 | Real send on same thread (state machine + double-send protection) · Send and Archive / Send Later · Snooze + resurface · sync-failure banners, inbox filters · warm-up email keyword filtering | **Mon Aug 31: live MVP demo** — real test email exchange |
| **2** | Sep 2 – Sep 8 | AI classifier (taxonomy, confidence, ai_label vs final_label, Needs Review queue, correction log) · AI draft generation (edit, regenerate + free-text instruction, fallback) · Wrong Person: redirect contact identification, minimal (no automation) | Classified + drafted real replies, end of week |
| **3** | Sep 9 – Sep 15 | Salesforce read + write-back (retry queue, sf_write_status, low-confidence holds) · Engine correction + change log · Days 14–15: QA against PRD acceptance criteria | **Sep 16: pilot go-live** |

## Conditions (each one is a yes/no from the team — a "no" moves the date)

| # | Condition | Owner | By when |
|---|---|---|---|
| 1 | **Sajda full-time on this for the 3 weeks** (explicit exception to the 70/30 Hiring-MVP split) | Joshua / Sugandha | Aug 26 |
| 2 | 1Password sequence vault set up, Dona stores mailbox credentials (unblocks Google) | Joshua + Dona | Fri Aug 29 — else pilot starts Microsoft-only |
| 3 | Salesforce API credentials + confirmation the 6 context fields are populated | Hari | Fri Sep 5 — else week 3 ships a held-writes queue and SF sync flips on later; pilot date holds |
| 4 | Confirm **mailbox-only ingestion** (no AmpleMarket/Instantly label polling — doesn't fit in 15 days; classifier runs on reply text alone) | Sugandha + Hari + Jomart | Before Sep 2 |
| 5 | **Scope frozen** for the 15 days — the plan is ~13–18 estimated dev-days in 15; there is no slack | Everyone | Standing |

## Explicitly NOT in the 15 days → fast-follow release (~4–5 weeks after pilot)

Sourcing Lead approval flow · re-engagement scheduled sends (basic Snooze IS included) · Wrong Person / redirect module · SLA alerting · analytics dashboard · scheduling-dashboard deep link (blocked on URL-param confirmation from that team anyway).

**Consequence to be explicit about:** Front cannot be decommissioned on day 15 — approvals and SLA visibility are part of what Front covers today. Decommission lands with the fast-follow.

## Standing risks

- Scheduling dashboard's calendar-sync bug (why Jomart avoids it) — not ours to fix, but the eventual "seamless handoff" claim depends on it. Needs an owner.
- Sponsor confirmed: **Nolan (sponsor)**, **Jomart (primary user/stakeholder)** — pending Nolan's own confirmation before treating as fully settled.
- SF field population is assumed, not verified (PRD §6 discovery item) — verifying it is the first thing in week 3.
