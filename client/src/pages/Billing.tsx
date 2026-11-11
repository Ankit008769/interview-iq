import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CreditCard, Gift, Receipt, Sparkles, Ticket } from 'lucide-react';
import { api } from '../lib/api';
import { LoadingScreen } from '../components/Layout';

type Provider = 'razorpay' | 'stripe';
type PlanId = 'free' | 'pro' | 'pro_plus' | 'campus';
interface PlanView { id: PlanId; name: string; summary: string; prices: { month?: number; year?: number }; entitlements: { textInterviews: number | null; voiceInterviews: number | null; capabilities: string[] };
  buy: Record<Provider, { month: boolean; year: boolean }> }
interface PacksView { id: 'voice_5' | 'voice_15'; name: string; price: number; voiceInterviews: number; buy: Record<Provider, boolean> }
interface PlansResponse { plans: PlanView[]; packs: PacksView[]; providers: Record<Provider, boolean>; referralCredits: number; campus: { tiers: { minStudents: number; perStudent: number }[]; voicePerYear: number } }
interface MeResponse {
  usage: { plan: PlanId; source: 'subscription' | 'campus' | 'free'; until?: string; enforcing: boolean; credits: number;
    entitlements: { textInterviews: number | null; voiceInterviews: number | null; capabilities: string[] }; used: { textInterviews: number; voiceInterviews: number } };
  subscription: { plan: string; interval: string; provider: Provider; status: string; currentPeriodEnd?: string; cancelAtPeriodEnd: boolean } | null;
  payments: { id: string; kind: string; plan?: string; packId?: string; amount: number; currency: string; status: string; refunded: number; capturedAt: string; invoiceId: string | null }[];
  invoices: { id: string; number: string; issuedAt: string; total: number }[];
  referral: { code: string; usedCode: boolean; rewarded: number };
}
const money = (minor: number, currency = 'INR') => (currency === 'INR' ? `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : `$${(minor / 100).toFixed(2)}`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const limit = (n: number | null) => (n === null ? 'Unlimited' : String(n));
const CAPABILITY: Record<string, string> = { resume_jd: 'Resume and job-description tailoring', delivery: 'Delivery feedback', indic_languages: 'Hindi and Hinglish', coding_lab: 'Coding lab',
  system_design: 'System design', project_defense: 'Project defense', study_plan: 'Adaptive study plan' };

// Plans and billing (roadmap D5). Payments open the provider's hosted page; nothing about cards or UPI is
// entered here.
export function BillingPage() {
  const [plans, setPlans] = useState<PlansResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const [coupon, setCoupon] = useState(''); const [referral, setReferral] = useState('');
  const load = useCallback(async () => {
    try { const [p, m] = await Promise.all([api<PlansResponse>('/billing/plans'), api<MeResponse>('/billing/me')]); setPlans(p); setMe(m); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); if (new URLSearchParams(window.location.search).get('returned')) setNotice('Thanks. Your payment is being confirmed; this page updates when the provider tells us.'); }, [load]);

  const provider: Provider | null = plans?.providers.razorpay ? 'razorpay' : plans?.providers.stripe ? 'stripe' : null;
  async function buy(body: object) {
    if (!provider) return;
    setBusy(true); setError('');
    try { const { url } = await api<{ url: string }>('/billing/checkout', { method: 'POST', body: JSON.stringify({ provider, ...body, ...(coupon.trim() ? { coupon: coupon.trim() } : {}) }) }); window.location.assign(url); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  async function act(path: string, body: object, done: string) {
    setBusy(true); setError(''); setNotice('');
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setNotice(done); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!plans || !me) return error ? <div className="alert error" role="alert">{error}</div> : <LoadingScreen/>;
  const u = me.usage;
  const current = plans.plans.find(p => p.id === u.plan);
  return <div className="page-enter billing-page">
    <div className="page-heading"><div><span className="eyebrow"><CreditCard size={14}/> PLAN AND BILLING</span><h1>Plan and billing</h1>
      <p>{u.enforcing ? 'Your plan sets how many interviews you can take each month.' : 'During the beta everything is free and nothing is limited. This is what your plan will include once plans start.'}</p></div></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}

    <section className="card campus-card" aria-label="Your plan"><h2><Sparkles size={18}/> {current?.name ?? (u.plan === 'campus' ? 'Campus' : 'Free')}{u.source === 'campus' ? ' (through your college)' : ''}</h2>
      <div className="usage-grid">
        <div><span>AI interviews this month</span><b>{u.used.textInterviews} / {limit(u.entitlements.textInterviews)}</b></div>
        <div><span>Voice interviews {u.plan === 'campus' ? 'this year' : 'this month'}</span><b>{u.used.voiceInterviews} / {limit(u.entitlements.voiceInterviews)}</b></div>
        <div><span>Extra voice interviews</span><b>{u.credits}</b></div>
        {u.until && <div><span>{me.subscription?.cancelAtPeriodEnd ? 'Ends' : 'Renews'}</span><b>{day(u.until)}</b></div>}
      </div>
      <p className="campus-note">Practice interviews from the question bank are always free and unlimited. A voice interview is one where at least one answer was spoken.</p>
      {me.subscription && ['active', 'past_due'].includes(me.subscription.status) && !me.subscription.cancelAtPeriodEnd &&
        <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm('Cancel at the end of the paid period? You keep access until then.')) void act('/billing/subscription/cancel', {}, 'Your subscription will end at the close of the paid period.'); }}>Cancel subscription</button>}
      {me.subscription?.status === 'past_due' && <div className="alert warning">Your last renewal did not go through. The provider will retry; update your payment method from their email.</div>}
    </section>

    <section className="card campus-card" aria-label="Plans"><h2><CreditCard size={18}/> Plans</h2>
      {!provider && <div className="alert warning">Payments are not switched on yet. Plans and prices are shown so you know what is coming.</div>}
      <div className="segmented" role="group" aria-label="Billing period"><button type="button" className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>Monthly</button>
        <button type="button" className={period === 'year' ? 'active' : ''} onClick={() => setPeriod('year')}>Yearly</button></div>
      <div className="plan-grid">{plans.plans.map(p => {
        const price = p.prices[period];
        const can = provider && p.buy[provider]?.[period];
        return <div key={p.id} className={`plan-card ${u.plan === p.id ? 'current' : ''}`}>
          <h3>{p.name}</h3><p className="plan-price">{price ? <>{money(price)}<small>/{period}</small></> : p.id === 'free' ? '₹0' : '—'}</p>
          <p>{p.summary}</p>
          <ul><li>{limit(p.entitlements.textInterviews)} AI interviews a month</li><li>{limit(p.entitlements.voiceInterviews)} voice interviews a month</li>
            {p.entitlements.capabilities.map(c => <li key={c}>{CAPABILITY[c] ?? c}</li>)}</ul>
          {u.plan === p.id ? <span className="due-chip done">Your plan</span> : p.id !== 'free' && <button className="button primary" disabled={busy || !can} onClick={() => void buy({ kind: 'subscription', plan: p.id, interval: period })}>{can ? `Choose ${p.name}` : 'Not available yet'}</button>}
        </div>;
      })}</div>
      <p className="campus-note">Prices include 18% GST. Colleges: Campus licences cost {plans.campus.tiers.map(t => `${money(t.perStudent)} per student a year from ${t.minStudents} students`).join(', ')}, plus GST, with {plans.campus.voicePerYear} voice interviews per student a year.</p>
    </section>

    <section className="card campus-card" aria-label="Voice packs"><h2><Ticket size={18}/> Extra voice interviews</h2>
      <div className="plan-grid">{plans.packs.map(p => <div key={p.id} className="plan-card"><h3>{p.name}</h3><p className="plan-price">{money(p.price)}</p><p>Used after your monthly allowance; valid for a year.</p>
        <button className="button secondary" disabled={busy || !provider || !p.buy[provider]} onClick={() => void buy({ kind: 'pack', packId: p.id })}>{provider && p.buy[provider] ? 'Buy' : 'Not available yet'}</button></div>)}</div>
      <label className="field coupon-field">Coupon code (optional)<input value={coupon} onChange={e => setCoupon(e.target.value.toUpperCase())} maxLength={20} placeholder="For example LAUNCH20"/></label>
    </section>

    <section className="card campus-card" aria-label="Referrals"><h2><Gift size={18}/> Invite a friend</h2>
      <p className="muted">When someone you invite makes their first payment, you both get {plans.referralCredits} extra voice interviews.</p>
      <div className="join-code"><code data-testid="referral-code">{me.referral.code}</code>
        <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(me.referral.code).then(() => setNotice('Referral code copied.'))}>Copy</button></div>
      {me.referral.rewarded > 0 && <p className="campus-note">{me.referral.rewarded} {me.referral.rewarded === 1 ? 'friend has' : 'friends have'} joined with your code.</p>}
      {!me.referral.usedCode && <form className="campus-create" onSubmit={(e: FormEvent) => { e.preventDefault(); void act('/billing/referral', { code: referral }, 'Referral code saved. You both get extra voice interviews after your first payment.').then(() => setReferral('')); }}>
        <label className="field">Were you invited? Enter their code<input value={referral} onChange={e => setReferral(e.target.value.toUpperCase())} minLength={6} maxLength={12}/></label>
        <button className="button secondary" disabled={busy || referral.trim().length < 6}>Save</button></form>}
    </section>

    {(me.payments.length > 0 || me.invoices.length > 0) && <section className="card campus-card" aria-label="Payments and invoices"><h2><Receipt size={18}/> Payments and invoices</h2>
      <div className="table-scroll"><table className="report-table"><thead><tr><th>Date</th><th>For</th><th>Amount</th><th>Status</th><th>Invoice</th></tr></thead>
        <tbody>{me.payments.map(p => <tr key={p.id}><td>{day(p.capturedAt)}</td><td>{p.kind === 'pack' ? plans.packs.find(x => x.id === p.packId)?.name ?? 'Pack' : `${p.plan === 'pro_plus' ? 'Pro+' : 'Pro'} subscription`}</td>
          <td>{money(p.amount, p.currency)}{p.refunded ? ` (refunded ${money(p.refunded, p.currency)})` : ''}</td><td>{p.status.replace('_', ' ')}</td>
          <td>{p.invoiceId ? <a href={`/api/billing/invoices/${p.invoiceId}`} target="_blank" rel="noreferrer">{me.invoices.find(i => i.id === p.invoiceId)?.number ?? 'View'}</a> : '—'}</td></tr>)}</tbody></table></div>
    </section>}
  </div>;
}
