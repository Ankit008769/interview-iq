// Plans and entitlements (roadmap D5). Prices are the strategy report's hypotheses (section 11.1) and are
// meant to be tested, so they live here in one place. Amounts are in paise and include 18% GST for
// consumers; campus licences are quoted before GST.

export type PlanId = 'free' | 'pro' | 'pro_plus' | 'campus';
export type Interval = 'month' | 'year';
export type Capability = 'resume_jd' | 'delivery' | 'indic_languages' | 'coding_lab' | 'system_design' | 'project_defense' | 'study_plan';

export interface Entitlements {
  plan: PlanId;
  // Monthly limits; null means unlimited.
  textInterviews: number | null;
  voiceInterviews: number | null;
  capabilities: Capability[];
}

export interface Plan {
  id: PlanId; name: string; summary: string;
  prices: Partial<Record<Interval, number>>;  // paise, GST included (consumer plans)
  entitlements: Omit<Entitlements, 'plan'>;
}

const ALL: Capability[] = ['resume_jd', 'delivery', 'indic_languages', 'coding_lab', 'system_design', 'project_defense', 'study_plan'];
export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Free', summary: 'Five text interviews and three voice interviews a month, with evidence-based feedback.',
    prices: {}, entitlements: { textInterviews: 5, voiceInterviews: 3, capabilities: [] } },
  pro: { id: 'pro', name: 'Pro', summary: 'Unlimited text interviews, ten voice interviews a month, resume and job-description tailoring, delivery feedback, Hindi and Hinglish.',
    prices: { month: 29_900, year: 2_49_900 }, entitlements: { textInterviews: null, voiceInterviews: 10, capabilities: ['resume_jd', 'delivery', 'indic_languages'] } },
  pro_plus: { id: 'pro_plus', name: 'Pro+', summary: 'Everything in Pro, thirty voice interviews a month, the coding lab, system design, project defense and the adaptive study plan.',
    prices: { month: 69_900, year: 5_99_900 }, entitlements: { textInterviews: null, voiceInterviews: 30, capabilities: ALL } },
  // Granted through a placement office's licence, not bought by the student.
  campus: { id: 'campus', name: 'Campus', summary: 'Pro access through your college, with a yearly voice allowance.',
    prices: {}, entitlements: { textInterviews: null, voiceInterviews: null, capabilities: ['resume_jd', 'delivery', 'indic_languages', 'study_plan'] } },
};
export const PAID_PLANS = ['pro', 'pro_plus'] as const;

// One-off packs add interviews to the current month's allowance (used before the plan's own count runs out).
export const PACKS = {
  voice_5: { id: 'voice_5', name: '5 voice interviews', price: 9_900, voiceInterviews: 5 },
  voice_15: { id: 'voice_15', name: '15 voice interviews', price: 24_900, voiceInterviews: 15 },
} as const;
export type PackId = keyof typeof PACKS;

// Campus licences: per student per year before GST, with volume tiers.
export const CAMPUS_TIERS = [
  { minStudents: 1, perStudent: 90_000 },
  { minStudents: 300, perStudent: 75_000 },
  { minStudents: 1000, perStudent: 60_000 },
];
export const CAMPUS_VOICE_PER_YEAR = 12;
export function campusPrice(students: number) {
  if (!Number.isInteger(students) || students < 1) throw new Error('A campus licence needs at least one student.');
  const tier = [...CAMPUS_TIERS].reverse().find(t => students >= t.minStudents)!;
  return { perStudent: tier.perStudent, total: tier.perStudent * students };
}

export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
