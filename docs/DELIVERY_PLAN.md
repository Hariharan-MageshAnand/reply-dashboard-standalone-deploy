# Reply Intelligence Hub — Delivery Plan (V1)

**Prepared by:** Sajda (build lead) · **Date:** Aug 25, 2026 · **Source:** PRD v1.2 + Aug 25 architecture addendum
**For:** Sugandha (PM), Hari (tech lead / advisory), Joshua — please confirm scope, allocation, and dates.
**Demo reference:** https://reply-intelligence-hub-1.vercel.app/

---

## 1. Where we actually are today (verified in code, not projected)

The standalone app already exists as a monorepo (Express + Prisma + BullMQ backend, Vite/React frontend, shared contracts package) with:

| Done | What |
|---|---|
| ✅ | Local email session auth (no Clerk — matches addendum A.1) |
| ✅ | Microsoft mailbox OAuth (Graph API, Mail.Read/ReadWrite/Send) — POC verified live |
| ✅ | Google mailbox OAuth (Gmail API) — code complete, **blocked on 2FA / sequence-vault setup** |
| ✅ | Mailbox sync engine: polling, thread/message ingestion, dedup by provider message ID, sync state + health tracking |
| ✅ | Data model: workspaces, mailboxes, conversations, messages, participants, labels, assignments, drafts, audit log, idempotency keys |
| ✅ | Unified inbox UI (list + detail), mailboxes page, onboarding, settings skeleton |
| ✅ | Local infra (Postgres + Redis via docker-compose), mock-mailbox mode for demos |

**What this means for estimates:** ingestion (PRD 5.1/5.2) is largely built. The remaining work is the AI layer, Salesforce, approvals, re-engagement, Wrong Person, SLA, and analytics.

---

## 2. Architecture divergences the team must confirm (affects scope)

1. **Mailbox-first ingestion vs. platform adapters.** PRD 5.2 specifies AmpleMarket/Instantly API adapters with `platform_label` hints. The confirmed architecture (addendum A.1, and this codebase) reads the sequencing **mailboxes directly** via Gmail/Graph. Reading mailboxes covers replies from both platforms in one pipeline — but we then **don't receive platform-native labels or platform attribution** for free.
   **Decision needed:** (a) mailbox-only — drop native-label hints, classifier runs on reply text alone (simpler, my recommendation for V1); or (b) hybrid — also poll platform APIs just for labels/attribution (adds ~3–4 days + API credential dependency). This also affects the per-platform filter and per-platform sync banner in PRD 5.1.
2. **Database.** PRD says Neon; addendum A.4 says new tables in the existing Emergence DB; the repo currently runs its own Postgres. Needs a final call from Hari before pilot data starts accumulating. (Schema is Prisma-managed either way; switching targets is cheap *now*, expensive after pilot.)
3. **Sending path.** Sends go out through Gmail/Graph on the same thread (matches Vivek's fixed rule — no domain selection). The PRD's open question about AmpleMarket/Instantly **send-API idempotency keys** becomes moot under mailbox-first sending.

---

## 3. Phased feature plan with estimates

Estimates are **focused dev-days** (includes tests + QA against the PRD's acceptance criteria). Ranges reflect discovery risk.

### Phase 1 — Working core loop / Aug 31 MVP target (4–6 days)
The two "immediate next steps" from the Aug 25 call, plus ingestion hardening.

| Item | PRD | Est. |
|---|---|---|
| Google unblock: connect real sequence mailboxes once 1Password vault exists (external dep) | A.2 | 0.5d |
| **Real test email exchange**: send reply via Gmail/Graph on the same thread; `draft → sending → sent/failed` state machine; double-send protection (button disable + idempotency key); failed send preserves draft | 5.4 | 2–3d |
| **Snooze button** + resurface-on-date job (also the foundation for OOO re-engagement) | A.5, 5.7 | 1d |
| Ingestion hardening: Unmatched filter, per-mailbox sync-failure banner, dead-letter handling for malformed payloads | 5.1, 5.2 | 1–1.5d |

### Phase 2 — AI layer (6–8 days)
| Item | PRD | Est. |
|---|---|---|
| Intent classifier (Claude Haiku): fixed taxonomy, confidence score, `ai_label` (immutable) vs `final_label`, ≥0.7 auto / <0.7 Needs Review queue, classify-failure → Needs Review, metadata extraction (return date, redirect name) | 5.3 | 3–4d |
| Correction storage + correction-rate metric + weekly spot-check sampling query | 5.3 | 1d |
| Draft generation (Claude Sonnet): context assembly, editable draft, Regenerate with free-text instruction, template fallback, defer-don't-fabricate + "recommended for approval" flag, `ai_draft_text` / `final_sent_text` both stored | 5.4 | 2–3d |

### Phase 3 — Salesforce integration (5–7 days) ⚠️ biggest unknown
| Item | PRD | Est. |
|---|---|---|
| Read context fields (Engine, EDIE, Industry, Sequence Name, Prior Reply Count, Company Description) + contact/account matching for incoming replies | 5.4, 8.1 | 2–3d |
| Write-back: contact status, `Has_Replied_Current_Cycle__c`, reply log; retry queue; `sf_write_status` visible; low-confidence writes held | 5.3, 8.1 | 2–3d |
| Engine correction writes to SF + append-only EngineChangeLog | 5.4, 7.4 | 1d |

Risk: assumes SF API credentials + field access exist and the six context fields are actually populated (PRD Section 6 discovery item — unverified).

### Phase 4 — Sourcing Lead approval flow (4–5 days)
| Item | PRD | Est. |
|---|---|---|
| ApprovalRequest/ApprovalComment models; "Request Approval" hard-blocks Send; email via transactional provider (Resend, pending confirmation) with single-use expiring Approve / Request Changes tokens | 5.5 | 2–3d |
| 4-hour reminder + 24-hour manual Override jobs (timestamp-based) | 5.5 | 1d |
| Append-only comment history + full audit-trail reconstruction (AI draft → edits → comments → final send) | 5.5 | 1d |

### Phase 5 — Re-engagement + Wrong Person (5–7 days)
| Item | PRD | Est. |
|---|---|---|
| Re-engagement: immediate follow-up draft on OOO/Not-Now, "Schedule to send on [date]", >7-day re-confirmation prompt, auto-cancel on early reply + flag, dedicated Scheduled filter, resurface fallback | 5.7 | 2.5–3.5d |
| Wrong Person module: show up to 3 enriched SF contacts, redirect-name matching, add-new-contact form (local DB write + SF-sync flag, visible partial-write error), clean-thread referral draft with touchpoint reset, exhausted-contacts escalation | 5.7a | 2.5–3.5d |

### Phase 6 — SLA, analytics, scheduling handoff (4–6 days)
| Item | PRD | Est. |
|---|---|---|
| SLA breach job + card tag + Lead notification; auto-clear on response | 5.8 | 1d |
| "Schedule Meeting →" deep link with account/contact URL params (blocked on the other dashboard confirming param support) | 5.6 | 0.5d |
| Analytics: funnel (per defined denominators), response time by Engine, reply-type breakdown (Unsubscribed separate from Negative), Needs Review queue, SLA log, 30-day heatmap | 5.9, 12 | 2.5–4d |

### Phase 7 — Pilot hardening & Front cutover (3–4 days)
QA sweep against every acceptance criterion, double-click send test vs. mocked slow API, spot-check audit tooling, error/alert monitoring, parallel run alongside Front, cutover checklist.

### Total remaining: **~31–43 focused dev-days (midpoint ≈ 37)**

---

## 4. Calendar scenarios — the honest math

My confirmed allocation is **30%** (≈1.5 days/week; 70% on Hiring MVP).

| Scenario | Throughput | Full V1 (~37d) lands | Pilot-ready core (Phases 1–3, ~17d) lands |
|---|---|---|---|
| 30% allocation (current) | ~1.5 d/wk | **~Feb 2027** ❌ | ~early Nov ❌ |
| 50% allocation | ~2.5 d/wk | ~mid-Dec ❌ | ~mid-Oct ⚠️ |
| Full-time on this | ~5 d/wk | ~late Oct ⚠️ | **~Sep 19** ✅ |
| 30% + one additional dev | ~6 d/wk | ~mid-Oct ⚠️ | ~mid-Sep ✅ |

**The Q3 target (Sep 30) is not reachable at 30% allocation.** This isn't an estimating problem — it's an allocation decision, and it belongs to the team, which is exactly why this plan exists.

### Proposed commitment: the 15-day plan (Aug 26 → Sep 15)

**What ships in 15 working days: the pilot-ready core** — Jomart works real replies in this tool (alongside Front) from day 16. Unified inbox on real mailboxes, AI classification with Needs Review queue, AI drafts, one-click send on the same thread, snooze, Salesforce read + write-back.

| Week | Days | Deliverable |
|---|---|---|
| **Week 1** (Aug 26 – Sep 1) | 1–5 | Phase 1 complete: real send on same thread with `draft → sending → sent/failed` state machine + double-send protection; Snooze + resurface; Unmatched filter, sync banners. **Mon Aug 31: MVP demo** (Microsoft live; Google if vault is done). |
| **Week 2** (Sep 2 – Sep 8) | 6–10 | Phase 2 complete: Claude classifier (taxonomy, confidence, ai_label/final_label, ≥0.7 auto / <0.7 Needs Review), correction storage, Claude draft generation with Regenerate + instruction, template fallback. |
| **Week 3** (Sep 9 – Sep 15) | 11–15 | Phase 3 (reduced): SF context read (6 fields) + contact matching; write-back with retry queue + `sf_write_status`; Engine correction + change log. Days 14–15: QA sweep against acceptance criteria, double-click send test. |
| **Day 16** (Sep 16) | — | **Pilot starts.** Jomart runs real replies here, Front stays open as safety net. |

**Conditions this commitment depends on (say no to any of these and the date moves):**

1. **Full-time on this for the 3 weeks** — not 30%. At 30%, 15 calendar days is ~4.5 dev-days, which buys Phase 1 only. This is the allocation exception to get signed off with the Hiring MVP owner.
2. 1Password sequence vault done by **Fri Aug 29** (Joshua + Dona) — otherwise pilot starts Microsoft-only.
3. SF API credentials + field access confirmed by **Fri Sep 5** — otherwise week 3 swaps to a held-writes queue (classifications stored, SF sync flips on later) and pilot still starts on time, just without live SF write-back.
4. Mailbox-only ingestion confirmed (no platform-label hybrid — §2.1). The hybrid option does not fit in 15 days.
5. Scope is fixed for the 15 days. The plan is ~13–18 estimated dev-days squeezed into 15 — there is no slack for additions.

**Explicitly NOT in the 15 days (fast-follow, ~4–5 weeks after pilot at the allocation then agreed):** Sourcing Lead approval flow, re-engagement scheduling (basic snooze IS included), Wrong Person module, SLA alerting, analytics, scheduling-dashboard deep link. **Front decommission waits for the fast-follow** — the approval flow and SLA alerting are part of what Front does today.

*Note: "15 days" here means 15 working days (3 weeks, → Sep 15). If the commitment is 15 calendar days (→ Sep 9, ~11 working days), drop item 3's live SF write-back to the held-queue variant and move QA into the pilot week.*

---

## 5. External blockers (none owned by the build; all can stall it)

| # | Blocker | Owner | Blocks | Needed by |
|---|---|---|---|---|
| 1 | 1Password "sequence vault" + Dona storing mailbox credentials | Joshua + Dona | Google mailboxes → Aug 31 MVP scope | **This week** |
| 2 | Salesforce API credentials + confirmation the 6 context fields are populated | Hari / Eng | Phase 3 | Before Sep 8 |
| 3 | Transactional email provider (Resend?) account + keys | Hari / Eng | Phase 4 | Before approvals build |
| 4 | Scheduling dashboard URL-param pre-fill confirmed (or small change there) | Owner of that system | Phase 6 handoff | Before Phase 6 |
| 5 | Platform-label decision: mailbox-only vs. hybrid (see §2.1) | Sugandha + Hari + Jomart | Classifier design | Before Phase 2 |
| 6 | Database decision: standalone Postgres vs. shared Emergence DB (A.4) | Hari | Everything (cheap now, costly later) | Before pilot |
| 7 | Sponsor named (P0 sign-off rule) | Sugandha | Formal sign-off | Before build formally starts |

Known-risk reminder (from PRD §11): the scheduling dashboard's calendar-sync bug means our "seamless handoff" inherits a broken landing spot — worth resolving in parallel, though it's not ours to fix.

---

## 6. Deliberately out of V1 (per PRD — restated so nobody re-asks)

HeyReach adapter · auto-send without human review · AI meeting-time detection/auto-booking (V2 Priority 1) · automated model retraining · sequence health analytics · deliverability monitoring · Engine classification itself · multi-operator UI · trust-ramp batch confirm (designed, activated post-launch with real correction data).
