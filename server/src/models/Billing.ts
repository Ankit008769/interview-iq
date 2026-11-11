import mongoose, { Schema } from 'mongoose';
import type { Interval, PackId } from '../billing/plans.js';
import type { TaxedLine } from '../billing/gst.js';

// Billing records (roadmap D5). Amounts are integers in the currency's smallest unit (paise for INR).
// Provider payloads are never stored whole: only the fields needed to apply and reconcile them, plus a hash.
export const PROVIDERS = ['razorpay', 'stripe'] as const;
export type Provider = typeof PROVIDERS[number];
type Id = mongoose.Types.ObjectId;

// A checkout the user started; webhooks find the user through it (its ID travels in the provider's notes).
export interface ICheckoutIntent {
  userId: Id; provider: Provider; kind: 'subscription' | 'pack';
  plan?: 'pro' | 'pro_plus'; interval?: Interval; packId?: PackId;
  amount: number; currency: 'INR' | 'USD'; couponCode?: string; discount: number;
  providerRef?: string; url?: string; status: 'created' | 'paid' | 'expired';
  createdAt: Date; updatedAt: Date;
}
const intentSchema = new Schema<ICheckoutIntent>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: PROVIDERS, required: true }, kind: { type: String, enum: ['subscription', 'pack'], required: true },
  plan: { type: String, enum: ['pro', 'pro_plus'] }, interval: { type: String, enum: ['month', 'year'] }, packId: String,
  amount: { type: Number, required: true }, currency: { type: String, enum: ['INR', 'USD'], required: true },
  couponCode: String, discount: { type: Number, default: 0 },
  providerRef: { type: String, unique: true, sparse: true }, url: String,
  status: { type: String, enum: ['created', 'paid', 'expired'], default: 'created' },
}, { timestamps: true });
export const CheckoutIntent = mongoose.model<ICheckoutIntent>('CheckoutIntent', intentSchema, 'checkout_intents');

export interface ISubscription {
  userId: Id; plan: 'pro' | 'pro_plus'; interval: Interval; provider: Provider; providerSubscriptionId: string;
  status: 'pending' | 'active' | 'past_due' | 'cancelled' | 'expired';
  currentPeriodEnd?: Date; cancelAtPeriodEnd: boolean; couponCode?: string;
  createdAt: Date; updatedAt: Date;
}
const subscriptionSchema = new Schema<ISubscription>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: String, enum: ['pro', 'pro_plus'], required: true }, interval: { type: String, enum: ['month', 'year'], required: true },
  provider: { type: String, enum: PROVIDERS, required: true }, providerSubscriptionId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'active', 'past_due', 'cancelled', 'expired'], default: 'pending' },
  currentPeriodEnd: Date, cancelAtPeriodEnd: { type: Boolean, default: false }, couponCode: String,
}, { timestamps: true });
subscriptionSchema.index({ provider: 1, providerSubscriptionId: 1 }, { unique: true });
export const Subscription = mongoose.model<ISubscription>('Subscription', subscriptionSchema, 'subscriptions');

// A captured payment. Payments and invoices are financial records kept for the statutory period (GST law
// requires about six years), so account deletion detaches them from the user instead of erasing them.
export interface IPayment {
  userId?: Id; orgId?: Id; provider: Provider | 'manual'; providerPaymentId: string;
  kind: 'subscription' | 'pack' | 'campus'; plan?: string; packId?: string; subscriptionId?: Id;
  amount: number; currency: 'INR' | 'USD'; status: 'captured' | 'refunded' | 'partially_refunded';
  refunded: number; capturedAt: Date; invoiceId?: Id; createdAt: Date; updatedAt: Date;
}
const paymentSchema = new Schema<IPayment>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true }, orgId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  provider: { type: String, enum: [...PROVIDERS, 'manual'], required: true }, providerPaymentId: { type: String, required: true },
  kind: { type: String, enum: ['subscription', 'pack', 'campus'], required: true }, plan: String, packId: String, subscriptionId: Schema.Types.ObjectId,
  amount: { type: Number, required: true }, currency: { type: String, enum: ['INR', 'USD'], required: true },
  status: { type: String, enum: ['captured', 'refunded', 'partially_refunded'], default: 'captured' }, refunded: { type: Number, default: 0 },
  capturedAt: { type: Date, required: true }, invoiceId: Schema.Types.ObjectId,
}, { timestamps: true });
paymentSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true });
paymentSchema.index({ capturedAt: 1 });
export const Payment = mongoose.model<IPayment>('Payment', paymentSchema, 'payments');

// Each webhook is applied at most once: the (provider, eventId) pair is unique.
export interface IBillingEvent { provider: Provider; eventId: string; type: string; payloadSha256: string; outcome: 'processing' | 'applied' | 'ignored' | 'failed'; detail?: string; receivedAt: Date }
const billingEventSchema = new Schema<IBillingEvent>({
  provider: { type: String, enum: PROVIDERS, required: true }, eventId: { type: String, required: true }, type: { type: String, required: true },
  payloadSha256: { type: String, required: true }, outcome: { type: String, enum: ['processing', 'applied', 'ignored', 'failed'], required: true }, detail: String,
  receivedAt: { type: Date, default: () => new Date() },
});
billingEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
export const BillingEvent = mongoose.model<IBillingEvent>('BillingEvent', billingEventSchema, 'billing_events');

// Extra voice interviews from packs and referrals. Positive entries add, negative entries use; each lasts a year.
export interface ICredit { userId: Id; voiceInterviews: number; reason: 'pack' | 'referral' | 'used' | 'refund' | 'adjustment'; ref?: string; expiresAt?: Date; createdAt: Date }
const creditSchema = new Schema<ICredit>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, voiceInterviews: { type: Number, required: true },
  reason: { type: String, enum: ['pack', 'referral', 'used', 'refund', 'adjustment'], required: true }, ref: String, expiresAt: Date,
  createdAt: { type: Date, default: () => new Date() },
});
creditSchema.index({ reason: 1, ref: 1 }, { unique: true, partialFilterExpression: { ref: { $type: 'string' } } });
export const Credit = mongoose.model<ICredit>('Credit', creditSchema, 'credits');

export interface ICoupon {
  code: string; percentOff?: number; amountOff?: number; plans: string[]; intervals: Interval[];
  maxRedemptions: number; redeemed: number; expiresAt?: Date; active: boolean;
  // Subscriptions are discounted by the provider, so a code works for them only with the provider's offer or promotion ID.
  providerOffers?: { razorpay?: string; stripe?: string };
  createdAt: Date; updatedAt: Date;
}
const couponSchema = new Schema<ICoupon>({
  code: { type: String, required: true, unique: true, uppercase: true, match: /^[A-Z0-9]{4,20}$/ },
  percentOff: { type: Number, min: 1, max: 100 }, amountOff: { type: Number, min: 1 },
  plans: { type: [String], default: ['pro', 'pro_plus'] }, intervals: { type: [String], default: ['month', 'year'] },
  maxRedemptions: { type: Number, required: true, min: 1 }, redeemed: { type: Number, default: 0 }, expiresAt: Date, active: { type: Boolean, default: true },
  providerOffers: { type: new Schema({ razorpay: String, stripe: String }, { _id: false }) },
}, { timestamps: true });
export const Coupon = mongoose.model<ICoupon>('Coupon', couponSchema, 'coupons');
const redemptionSchema = new Schema({ code: { type: String, required: true }, userId: { type: Schema.Types.ObjectId, required: true }, intentId: Schema.Types.ObjectId, createdAt: { type: Date, default: () => new Date() } });
redemptionSchema.index({ code: 1, userId: 1 }, { unique: true });
export const CouponRedemption = mongoose.model('CouponRedemption', redemptionSchema, 'coupon_redemptions');

// Referrals: everyone has a code; a new user can enter one within 30 days of joining. Both get extra voice
// interviews when the new user's first payment is captured.
const referralCodeSchema = new Schema({ userId: { type: Schema.Types.ObjectId, required: true, unique: true }, code: { type: String, required: true, unique: true } });
export const ReferralCode = mongoose.model('ReferralCode', referralCodeSchema, 'referral_codes');
export interface IReferral { referrerId: Id; refereeId: Id; status: 'pending' | 'rewarded'; rewardedAt?: Date; createdAt: Date }
const referralSchema = new Schema<IReferral>({
  referrerId: { type: Schema.Types.ObjectId, required: true, index: true }, refereeId: { type: Schema.Types.ObjectId, required: true, unique: true },
  status: { type: String, enum: ['pending', 'rewarded'], default: 'pending' }, rewardedAt: Date, createdAt: { type: Date, default: () => new Date() },
});
export const Referral = mongoose.model<IReferral>('Referral', referralSchema, 'referrals');

// GST invoices. Numbers are consecutive per financial year (InvoiceCounter) and invoices never change once issued.
export interface IInvoice {
  number: string; financialYear: string; sequence: number; issuedAt: Date;
  supplier: { name: string; address: string; gstin: string; stateCode: string };
  recipient: { name: string; address?: string; gstin?: string; stateCode?: string; userId?: Id; orgId?: Id };
  placeOfSupply: { code: string; name: string; interState: boolean };
  lines: TaxedLine[]; totals: { taxable: number; cgst: number; sgst: number; igst: number; total: number };
  currency: 'INR'; paymentId?: Id; createdAt: Date;
}
const invoiceSchema = new Schema<IInvoice>({
  number: { type: String, required: true, unique: true }, financialYear: { type: String, required: true }, sequence: { type: Number, required: true },
  issuedAt: { type: Date, required: true }, supplier: { type: Object, required: true }, recipient: { type: Object, required: true },
  placeOfSupply: { type: Object, required: true }, lines: { type: [Object], required: true }, totals: { type: Object, required: true },
  currency: { type: String, enum: ['INR'], default: 'INR' }, paymentId: { type: Schema.Types.ObjectId, unique: true, sparse: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
invoiceSchema.index({ 'recipient.userId': 1 });
invoiceSchema.index({ 'recipient.orgId': 1 });
export const Invoice = mongoose.model<IInvoice>('Invoice', invoiceSchema, 'invoices');
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
export const InvoiceCounter = mongoose.model('InvoiceCounter', counterSchema, 'invoice_counters');

// A placement office's licence: seats for a period, giving its students the Campus plan.
export interface ICampusLicence { orgId: Id; seats: number; startsAt: Date; endsAt: Date; perStudent: number; paymentId?: Id; createdAt: Date; updatedAt: Date }
const licenceSchema = new Schema<ICampusLicence>({
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true }, seats: { type: Number, required: true, min: 1 },
  startsAt: { type: Date, required: true }, endsAt: { type: Date, required: true }, perStudent: { type: Number, required: true }, paymentId: Schema.Types.ObjectId,
}, { timestamps: true });
export const CampusLicence = mongoose.model<ICampusLicence>('CampusLicence', licenceSchema, 'campus_licences');
