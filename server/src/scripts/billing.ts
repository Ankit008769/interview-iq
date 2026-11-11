import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { CampusLicence, Coupon, Payment } from '../models/Billing.js';
import { Organization } from '../models/Organization.js';
import { campusPrice } from '../billing/plans.js';
import { placeOfSupply, supplier, taxLine, validGstin } from '../billing/gst.js';
import { createInvoice } from '../billing/service.js';
import { analyticsRows, readProviderCsv, reconcile, revenueMetrics } from '../billing/reports.js';

// Operator commands for billing (roadmap D5). Needs MONGODB_URI.
//   npm run billing -- coupon --code LAUNCH20 --percent 20 --max 500 [--plans pro,pro_plus] [--expires 2027-01-31] [--razorpay-offer offer_X] [--stripe-promotion promo_X]
//   npm run billing -- campus-licence --org <orgId> --seats 300 --start 2027-07-01 --months 12 --recipient "College name" --address "..." [--gstin 29...] [--paid-ref UTR123]
//   npm run billing -- reconcile --provider razorpay --csv payments.csv --from 2026-11-01 --to 2026-12-01 [--minor-units]
//   npm run billing -- metrics --from 2026-11-01 --to 2026-12-01 [--marketing-spend-inr 50000] [--gross-margin 0.75]
//   npm run billing -- export --out ./bq   (newline-delimited JSON for BigQuery; needs BILLING_EXPORT_SALT)
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (name: string) => { const v = arg(name); if (!v) throw new Error(`Missing --${name}`); return v; };
const date = (name: string) => { const d = new Date(need(name)); if (Number.isNaN(d.getTime())) throw new Error(`--${name} must be a date`); return d; };

async function main() {
  const command = process.argv[2];
  if (!process.env.MONGODB_URI) throw new Error('Missing MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    if (command === 'coupon') {
      const percent = arg('percent') ? Number(arg('percent')) : undefined, amountInr = arg('amount-inr') ? Number(arg('amount-inr')) : undefined;
      if (!percent === !amountInr) throw new Error('Give exactly one of --percent or --amount-inr');
      const coupon = await Coupon.create({ code: need('code'), ...(percent ? { percentOff: percent } : { amountOff: Math.round(amountInr! * 100) }), maxRedemptions: Number(need('max')),
        ...(arg('plans') ? { plans: arg('plans')!.split(',') } : {}), ...(arg('expires') ? { expiresAt: date('expires') } : {}),
        ...(arg('razorpay-offer') || arg('stripe-promotion') ? { providerOffers: { razorpay: arg('razorpay-offer'), stripe: arg('stripe-promotion') } } : {}) });
      console.log(JSON.stringify({ created: coupon.code }));
    } else if (command === 'campus-licence') {
      // A campus licence is invoiced before payment (net terms) or after a bank transfer; prices exclude GST.
      const s = supplier(); if (!s) throw new Error('Set GST_SUPPLIER_NAME, GST_SUPPLIER_ADDRESS and a valid GST_SUPPLIER_GSTIN first.');
      const org = await Organization.findById(need('org')).select('name').lean(); if (!org) throw new Error('Organisation not found');
      const seats = Number(need('seats')); const start = date('start'); const months = Number(arg('months') ?? 12);
      const gstin = arg('gstin')?.toUpperCase(); if (gstin && !validGstin(gstin)) throw new Error('Invalid --gstin');
      const price = campusPrice(seats);
      const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + months);
      const recipient = { name: need('recipient'), address: need('address'), ...(gstin ? { gstin } : {}), orgId: org._id };
      const place = placeOfSupply(s.stateCode, recipient);
      const line = taxLine({ description: `Interview IQ campus licence, ${seats} students, ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`, sac: s.sac, quantity: seats, unitPrice: price.perStudent, inclusive: false }, place.interState, s.ratePercent);
      const payment = arg('paid-ref') ? await Payment.create({ orgId: org._id, provider: 'manual', providerPaymentId: need('paid-ref'), kind: 'campus', amount: line.total, currency: 'INR', capturedAt: new Date() }) : null;
      const invoice = await createInvoice({ supplier: s, recipient, place, lines: [line], ...(payment ? { paymentId: payment._id } : {}) });
      const licence = await CampusLicence.create({ orgId: org._id, seats, startsAt: start, endsAt: end, perStudent: price.perStudent, ...(payment ? { paymentId: payment._id } : {}) });
      console.log(JSON.stringify({ licence: String(licence._id), invoice: invoice.number, totals: invoice.totals }));
    } else if (command === 'reconcile') {
      const provider = need('provider') as 'razorpay' | 'stripe';
      const rows = readProviderCsv(readFileSync(need('csv'), 'utf8'), process.argv.includes('--minor-units'));
      const report = await reconcile(provider, rows, date('from'), date('to'));
      console.log(JSON.stringify(report, null, 2));
      if (!report.reconciled) process.exitCode = 2;
    } else if (command === 'metrics') {
      console.log(JSON.stringify(await revenueMetrics({ from: date('from'), to: date('to'), ...(arg('gross-margin') ? { grossMargin: Number(arg('gross-margin')) } : {}),
        ...(arg('marketing-spend-inr') ? { marketingSpend: Math.round(Number(arg('marketing-spend-inr')) * 100) } : {}) }), null, 2));
    } else if (command === 'export') {
      const out = need('out'); mkdirSync(out, { recursive: true });
      const rows = await analyticsRows(process.env.BILLING_EXPORT_SALT ?? '');
      for (const [name, list] of Object.entries(rows)) writeFileSync(join(out, `${name}.ndjson`), list.map(r => JSON.stringify(r)).join('\n') + '\n');
      console.log(JSON.stringify({ payments: rows.payments.length, subscriptions: rows.subscriptions.length, out }));
    } else throw new Error('Commands: coupon, campus-licence, reconcile, metrics, export');
  } finally { await mongoose.disconnect(); }
}
main().catch(err => { console.error(err instanceof Error ? err.message : 'Billing command failed.'); process.exitCode = 1; });
