# Plans, payments and GST invoices (Phase D5, groundwork)

Implemented 11 November 2026. Everything needed to charge for Interview IQ is built and tested with stubbed
providers. It stays **switched off** until the owner adds payment-provider keys, the company's GST details
and `BILLING_ENFORCEMENT=on`. Until then the beta is free and unlimited, and the Billing page shows what each
plan will include.

## Roadmap items and status

| Roadmap item | v1 |
|---|---|
| Razorpay (UPI, cards) and Stripe (international) | Yes, through hosted pages: Razorpay payment links and subscription links, and Stripe Checkout. No card or UPI data, and no third-party script, ever touches Interview IQ's pages. Needs the owner's provider accounts and keys. |
| Subscriptions and usage packs | Pro and Pro+, monthly or yearly; packs of 5 or 15 voice interviews. |
| Campus invoicing with GST | Yes. `npm run billing -- campus-licence` issues a GST tax invoice and the licence. Prices exclude GST; CGST and SGST, or IGST, follow the place of supply. **Needs a chartered accountant's review before the first invoice.** |
| Entitlements tied to quotas | Yes (`billing/entitlements.ts`): monthly AI-interview and voice-interview limits and per-plan features, enforced only when `BILLING_ENFORCEMENT=on`. |
| Coupons and referrals | Yes. Coupons apply to packs directly, and to subscriptions through a provider offer. A referral gives both people 3 voice interviews on the new member's first payment. |
| Webhooks with idempotency | Yes. Signatures are verified on the raw body. Each (provider, event ID) is applied once, and repeated deliveries are acknowledged. Payments, credits and invoices are unique, so replays change nothing. A failed event stays retryable. |
| Revenue analytics in BigQuery | Pseudonymised NDJSON export (`npm run billing -- export`) ready for `bq load`. The dataset is not created, because staging billing is off. |
| Exit gate: 100% billing reconciliation | `npm run billing -- reconcile` compares a provider's payments export with Interview IQ's records to the paisa. It exits non-zero on any difference, a missing invoice is listed, and stuck webhooks are counted. |
| Exit gate: churn, ARPU and LTV/CAC dashboards | `npm run billing -- metrics` reports MRR, ARR, revenue, paying and new paying users, ARPU, monthly churn, LTV and CAC. A live dashboard needs the BigQuery dataset (or Looker Studio on it) once billing is on. |

## Plans

Prices are the strategy report's hypotheses (section 11.1), kept in `server/src/billing/plans.ts`. Consumer
prices include 18% GST.

| Plan | Price | AI interviews a month | Voice interviews | Features |
|---|---|---|---|---|
| Free | ₹0 | 5 | 3 a month | Evidence-based feedback |
| Pro | ₹299 a month or ₹2,499 a year | Unlimited | 10 a month | Resume and job-description tailoring, delivery feedback, Hindi and Hinglish |
| Pro+ | ₹699 a month or ₹5,999 a year | Unlimited | 30 a month | Everything in Pro, plus the coding lab, system design, project defense and the adaptive study plan |
| Campus (through a college licence) | ₹900, ₹750 or ₹600 per student a year (1+, 300+ and 1,000+ students), plus GST | Unlimited | 12 a year | Pro features and the study plan |

Rules for counting:
- **Practice interviews** from the curated bank are always free and unlimited.
- **AI interviews**, including drills, count against the monthly limit, which resets on the first of the
  month in India time.
- **Voice interviews.** An interview becomes a voice interview on its first transcribed answer
  (`Interview.voiceUsedAt`). After the plan's voice allowance, each voice interview uses one extra voice
  interview from a pack or referral. Those last a year and are never charged twice for the same interview.
- **Campus seats** go to the college's earliest-joined students, up to the licence's seats.
- **Precedence.** A paid subscription wins over Campus, and Campus wins over Free.
- **Cancelling.** A cancelled subscription keeps working until its paid period ends.

When enforcement is on, a blocked action returns HTTP 402 with `code: "PLAN_REQUIRED"`, the plan needed and
the capability. Typing an answer is never blocked: only starting a voice interview is.

## Payments

### Checkout and webhooks

`POST /api/billing/checkout` creates a checkout intent and returns the provider's hosted page:
- **Razorpay:** a payment link for packs, or a subscription link for plans.
- **Stripe:** a Checkout Session.

The intent's ID travels in the provider's notes or metadata. Webhooks
(`POST /api/billing/webhooks/razorpay|stripe`) are parsed from the raw body before the JSON parser:

| Provider | Signature check |
|---|---|
| Razorpay | `X-Razorpay-Signature` is the HMAC-SHA256 of the body. The event ID is in `x-razorpay-event-id`. |
| Stripe | `Stripe-Signature` is `t=…,v1=…`, the HMAC of `t.body`. Events older than 5 minutes are refused. |

A failed signature gets 400 and nothing is read. Events are mapped to a few changes: pack paid, subscription
active or renewed, subscription past due, cancelled or expired, and refund.

- **Out-of-order events.** Stripe may deliver `invoice.paid` before `checkout.session.completed`, so either
  one can create the subscription. Billing periods only move forward.
- **Records.** Only the fields needed are kept, plus a SHA-256 of the payload. Full payloads, which can hold
  contact details, are never stored.

### Refunds and coupons

A full refund of a pack takes its voice interviews back.

Coupons (`npm run billing -- coupon …`) give a percentage or amount off. They have a redemption limit and
an expiry date, can be limited to some plans, and can be used once per person. On packs, at least ₹1 is
always charged. Subscriptions use the provider's own offer or promotion, linked with `--razorpay-offer` or
`--stripe-promotion`.

### Referrals

Everyone has a code on the Billing page.
- A new member can enter one code within 30 days of joining, before paying, and not their own.
- On their first payment, both people get 3 extra voice interviews.
- A referrer is rewarded for at most 10 referrals in 30 days.

## GST invoices

`server/src/billing/gst.ts`:

| Topic | Rule |
|---|---|
| GSTIN | Validated with its state code and base-36 check character. |
| Tax split | Intra-state supplies carry CGST and SGST at 9% each. Inter-state supplies carry 18% IGST. |
| Place of supply | For a registered business, the state in its GSTIN. For a consumer, the state on record, otherwise the supplier's state. |
| Rounding | Amounts are whole paise. Inclusive prices are split into taxable value and tax. |
| Numbering | Consecutive per Indian financial year, in the form `IQ/2627/000123`: at most 16 characters, as Rule 46 requires. Counters are atomic. |
| Issue | Automatic for each captured INR payment once `GST_SUPPLIER_NAME`, `GST_SUPPLIER_ADDRESS` and a valid `GST_SUPPLIER_GSTIN` are set. International (USD) payments are not invoiced automatically: exports of services under a LUT need the accountant's setup first. |
| Format | `GET /api/billing/invoices/:id` shows a printable tax invoice to its recipient only. |
| Retention | Invoices and payments are financial records. Account deletion detaches them from the user rather than erasing them, because GST law requires them to be kept for about six years. |

The SAC code defaults to `999293` (commercial training and coaching) and can be changed with `GST_SAC`.
**Confirm this, the rate and the consumer place-of-supply rule with a chartered accountant.**

## Reports

| Command | What it does |
|---|---|
| `npm run billing -- reconcile --provider razorpay --csv payments.csv --from … --to …` | Reads the provider's export; columns are matched by name and amounts are in rupees or dollars unless `--minor-units` is given. Reports matches, amount and refund mismatches, payments missing on either side, INR payments without an invoice, and webhook events stuck for over an hour. Exit code 2 means "not fully reconciled". |
| `npm run billing -- metrics --from … --to … [--marketing-spend-inr …]` | MRR and ARR (yearly plans at a twelfth a month), revenue by currency net of refunds, paying and new paying users, ARPU a month, monthly churn of subscriptions live at the start, LTV (ARPU × gross margin ÷ churn, margin 75% by default) and CAC (spend ÷ new paying users). |
| `npm run billing -- export --out dir` | `payments.ndjson` and `subscriptions.ndjson` for BigQuery. User IDs are replaced by a salted hash (`BILLING_EXPORT_SALT`, at least 16 characters). |

## Going live: what the owner must provide

1. **Razorpay account** (KYC done), and optionally **Stripe**. Then set:
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`;
   - the plan IDs `RAZORPAY_PLAN_PRO_MONTH`, `…_PRO_YEAR`, `…_PRO_PLUS_MONTH` and `…_PRO_PLUS_YEAR`, created in
     the Razorpay dashboard at the prices above;
   - for Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the price IDs `STRIPE_PRICE_PRO_MONTH`
     (and the other plans) and `STRIPE_PRICE_VOICE_5` and `STRIPE_PRICE_VOICE_15`.

   Point the providers' webhooks at `https://<app>/api/billing/webhooks/razorpay` and `…/stripe`. Test-mode
   keys work the same way.
2. **GST registration details:** `GST_SUPPLIER_NAME`, `GST_SUPPLIER_ADDRESS` and `GST_SUPPLIER_GSTIN`. Have a
   chartered accountant confirm the SAC, the rate, invoice wording and the treatment of exports.
3. **Terms, a refund policy and pricing pages** reviewed by a lawyer, as part of D2.
4. **Switch on enforcement** with `BILLING_ENFORCEMENT=on` once paid plans are ready, and tell beta users
   beforehand.

## Data

Collections:
- `checkout_intents`, `subscriptions`, `payments`, `billing_events`
- `credits`
- `coupons`, `coupon_redemptions`
- `referral_codes`, `referrals`
- `invoices`, `invoice_counters`
- `campus_licences`

The account export includes the person's plan, subscription, payments, invoices, credits and referral. Account
deletion:
- removes intents, credits, coupon redemptions, referral codes and referrals;
- detaches payments, subscriptions and invoices instead of deleting them, for the statutory period;
- cancels nothing at the provider automatically. An active subscription must be cancelled first, and the
  Billing page and API say so.

## Tests

`server/tests/billing.test.ts` covers:

| Area | Tests |
|---|---|
| GST | GSTIN check characters (including a published example), tax splits, financial-year boundaries in India time, invoice numbers |
| Signatures | Razorpay and Stripe, including stale and altered payloads |
| Plans and CSV | Campus tiers, CSV parsing |
| Webhooks | Idempotent pack payments with invoices; retry after a failure; a subscription through out-of-order activation, renewal, a late stale update, cancellation and expiry; refunds |
| Coupons and referrals | Coupon rules; referral rewards and limits |
| Enforcement | Off and on, monthly reset and credit use; Campus seats |
| Reports | Reconciliation, matched and mismatched; metrics; the pseudonymised export |

`server/tests/billing-api.test.ts` covers the routes: plans and the beta state; a Razorpay pack bought through the hosted page with a signed, replayed webhook and its invoice (visible only to its recipient); Razorpay and Stripe subscriptions, a stale Stripe signature and cancelling at period end; 402 responses only when enforcement is on; and referral codes. `server/tests/passport.test.ts` checks that a live subscription blocks account deletion and that restoring a backup detaches payments and subscriptions. `server/e2e/passport.spec.ts` opens the Billing page with payments switched off.
