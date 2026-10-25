import mongoose from 'mongoose';
import type { Card } from 'ts-fsrs';
import { Interview, type InterviewLevel, type InterviewType } from '../models/Interview.js';
import { SkillState, StudyPlan, type ISkillState, type IStudyPlan, type SkillHistoryPoint } from '../models/Learning.js';
import { SKILLS, SKILL_BY_ID, skillsForAnswer, type Skill } from '../learning/skills.js';
import { PRIOR_MEAN, PRIOR_VARIANCE, current, drillDifficulty, level, lowConfidence, lowerBound, newCard, observe, readiness, review, sd,
  upperBound, type Belief } from '../learning/model.js';
import { interviewMode } from './ai.js';

// Adaptive practice (roadmap C5). Skill estimates are rebuilt by replaying the user's AI-scored interviews in
// completion order, so a re-reviewed score or a newly finished interview is reflected exactly, and two rebuilds
// racing each other converge on the one that saw the newest data.
export const MAX_REPLAYED_INTERVIEWS = 500;
export const HISTORY_POINTS = 60;
export const INTERVIEW_TYPES: InterviewType[] = ['Technical', 'Behavioral', 'HR'];
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const DAY_MS = 86_400_000;
const DEFAULT_ROLE = 'Software Development Engineer';
const TECHNICAL_TOPICS = SKILLS.filter(s => s.kind === 'topic' && s.type === 'Technical');
// A drill fits the daily time in the plan: questions × minutes per question, with room for reading feedback.
const SESSION: Record<10 | 20 | 30, { totalQuestions: number; timeLimitSeconds: 120 | 180 | 300 }> = {
  10: { totalQuestions: 2, timeLimitSeconds: 180 }, 20: { totalQuestions: 3, timeLimitSeconds: 300 }, 30: { totalQuestions: 4, timeLimitSeconds: 300 },
};

type ScoredInterview = {
  _id: mongoose.Types.ObjectId; type: InterviewType; topic: string; difficulty: InterviewLevel; completedAt: Date;
  feedback?: { answers?: { criteria: { criterionId: string; score?: number | null }[] }[] };
};
type ReplayedSkill = { belief: Belief; card: Card; observations: number; history: SkillHistoryPoint[] };
type StateLike = Pick<ISkillState, 'mean' | 'variance' | 'lastObservedAt' | 'observations' | 'history'> & { card: { due: Date } };

const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const round = (x: number, places = 2) => Math.round(x * 10 ** places) / 10 ** places;

// One observation per skill per interview: the average of that skill's ratings across the interview's answers,
// with "insufficient evidence" counted as 0 like the interview score. When every rating is insufficient the
// observation is null, which the model treats as a weaker, less certain 0.
export function interviewEvidence(doc: ScoredInterview): Map<string, number | null> {
  const ratings = new Map<string, (number | null)[]>();
  const add = (skillId: string, value: number | null) => ratings.set(skillId, [...(ratings.get(skillId) ?? []), value]);
  for (const answer of doc.feedback?.answers ?? []) {
    const scores = new Map(answer.criteria.map(c => [c.criterionId, c.score ?? null]));
    const { topic, competencies } = skillsForAnswer(doc.type, doc.topic, [...scores.keys()]);
    for (const skill of competencies) add(skill.id, scores.get(skill.criterionId!) ?? null);
    const values = [...scores.values()];
    if (topic && values.length) add(topic.id, values.every(v => v === null) ? null : average(values.map(v => v ?? 0)));
  }
  return new Map([...ratings].map(([id, values]) => [id, values.every(v => v === null) ? null : average(values.map(v => v ?? 0))]));
}

export function replay(docs: ScoredInterview[]): Map<string, ReplayedSkill> {
  const skills = new Map<string, ReplayedSkill>();
  const ordered = [...docs].sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime() || a._id.toString().localeCompare(b._id.toString()));
  for (const doc of ordered) {
    for (const [skillId, score] of interviewEvidence(doc)) {
      const at = doc.completedAt;
      const state = skills.get(skillId) ?? { belief: { mean: PRIOR_MEAN, variance: PRIOR_VARIANCE }, card: newCard(at), observations: 0, history: [] };
      const belief = observe(state.belief, { score, difficulty: doc.difficulty, at });
      skills.set(skillId, { belief, card: review(state.card, at, score ?? 0), observations: state.observations + 1,
        history: [...state.history, { at, mean: round(belief.mean), sd: round(sd(belief)), interviewId: doc._id }].slice(-HISTORY_POINTS) });
    }
  }
  return skills;
}

const duplicateKeyOnly = (err: any) => {
  const errors = err?.writeErrors ? [].concat(err.writeErrors) : err?.code !== undefined ? [err] : [];
  return errors.length > 0 && errors.every((e: any) => (e.code ?? e.err?.code) === 11000);
};
const scoredFilter = (userId: mongoose.Types.ObjectId) => ({ userId, status: 'completed', 'feedback.source': 'ai', completedAt: { $exists: true } });

export async function refreshSkills(userId: string | mongoose.Types.ObjectId): Promise<void> {
  const owner = new mongoose.Types.ObjectId(userId.toString());
  const [docs, latest] = await Promise.all([
    Interview.find(scoredFilter(owner)).sort({ completedAt: -1, _id: -1 }).limit(MAX_REPLAYED_INTERVIEWS)
      .select('type topic difficulty completedAt feedback.answers.criteria.criterionId feedback.answers.criteria.score').lean<ScoredInterview[]>(),
    Interview.findOne(scoredFilter(owner)).sort({ updatedAt: -1 }).select('updatedAt').lean<{ updatedAt: Date }>(),
  ]);
  // With no scored interviews left, every stored state is out of date.
  const basisAt = latest?.updatedAt ?? new Date();
  const skills = replay(docs);
  const writes = [...skills].map(([skillId, s]) => ({ updateOne: {
    filter: { userId: owner, skillId, basisAt: { $lte: basisAt } },
    update: { $set: { mean: round(s.belief.mean, 4), variance: round(s.belief.variance, 6), observations: s.observations,
      lastObservedAt: s.belief.lastObservedAt, history: s.history, basisAt,
      card: { due: s.card.due, stability: s.card.stability, difficulty: s.card.difficulty, elapsed_days: s.card.elapsed_days,
        scheduled_days: s.card.scheduled_days, learning_steps: s.card.learning_steps, reps: s.card.reps, lapses: s.card.lapses,
        state: s.card.state, last_review: s.card.last_review } } },
    upsert: true } }));
  // An upsert that meets a state written from newer data fails the unique index; that state is kept.
  if (writes.length) await SkillState.bulkWrite(writes, { ordered: false }).catch(err => { if (!duplicateKeyOnly(err)) throw err; });
  await SkillState.deleteMany({ userId: owner, skillId: { $nin: [...skills.keys()] }, basisAt: { $lte: basisAt } });
}

// Rebuilds only when a scored interview changed after the last rebuild (a missed worker update, a re-review).
export async function ensureFreshSkills(userId: string): Promise<void> {
  const owner = new mongoose.Types.ObjectId(userId);
  const [latest, stored] = await Promise.all([
    Interview.findOne(scoredFilter(owner)).sort({ updatedAt: -1 }).select('updatedAt').lean<{ updatedAt: Date }>(),
    SkillState.findOne({ userId: owner }).sort({ basisAt: -1 }).select('basisAt').lean(),
  ]);
  if (latest && (!stored || stored.basisAt.getTime() < latest.updatedAt.getTime())) await refreshSkills(owner);
}

// Calendar days in the learner's time zone, as YYYY-MM-DD, so streaks and countdowns follow their own midnight.
export function validTimeZone(timeZone: unknown): string {
  if (typeof timeZone !== 'string' || timeZone.length > 64) return DEFAULT_TIME_ZONE;
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); return timeZone; } catch { return DEFAULT_TIME_ZONE; }
}
export const localDay = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const dayString = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

// Consecutive days with at least one AI-scored session, ending today or, before today's session, yesterday.
export function practiceStreak(completedAt: Date[], now: Date, timeZone: string) {
  const days = new Set(completedAt.map(d => localDay(d, timeZone)));
  const today = dayNumber(localDay(now, timeZone));
  let day = days.has(dayString(today)) ? today : today - 1;
  let count = 0;
  while (days.has(dayString(day))) { count++; day--; }
  return { days: count, practisedToday: days.has(dayString(today)) };
}

export type DrillConfig = { mode: 'ai'; purpose: 'drill'; role: string; type: InterviewType; topic: string; difficulty: InterviewLevel;
  totalQuestions: number; timeLimitSeconds: 120 | 180 | 300; focusSkills: string[] };
export type Drill = { skillId: string; skillLabel: string; kind: 'retest' | 'weakest' | 'foundation' | 'baseline' | 'chosen'; reason: string; config: DrillConfig };
type Candidate = { skill: Skill; belief: Belief; due: Date };

const interviewTopic = (type: InterviewType, technicalTopic: string) => type === 'Technical' ? technicalTopic : type === 'Behavioral' ? 'Behavioral' : 'General';
const lowestFirst = (a: Candidate, b: Candidate) => lowerBound(a.belief) - lowerBound(b.belief) || a.skill.id.localeCompare(b.skill.id);
const estimate = (b: Belief) => `${b.mean.toFixed(1)} of 5, give or take ${(1.96 * sd(b)).toFixed(1)}`;

function candidates(states: Map<string, StateLike>, types: InterviewType[], now: Date): Candidate[] {
  return SKILLS.filter(s => types.includes(s.type) && states.has(s.id))
    .map(skill => { const state = states.get(skill.id)!; return { skill, belief: current(state, now), due: new Date(state.card.due) }; });
}

function drillConfig(skill: Skill, belief: Belief | undefined, practised: Candidate[], input: { role: string; dailyMinutes?: 10 | 20 | 30 }): DrillConfig {
  // Competency drills use the weakest practised technical topic; topic drills add the type's weakest competency.
  const weakestTopic = practised.filter(c => c.skill.kind === 'topic' && c.skill.type === 'Technical').sort(lowestFirst)[0]?.skill.topic;
  const weakestCompetency = practised.filter(c => c.skill.kind === 'competency' && c.skill.type === skill.type).sort(lowestFirst)[0]?.skill.id;
  const topic = skill.kind === 'topic' ? skill.topic! : interviewTopic(skill.type, weakestTopic ?? TECHNICAL_TOPICS[0].topic!);
  const focusSkills = skill.kind === 'topic' && weakestCompetency ? [skill.id, weakestCompetency] : [skill.id];
  return { mode: 'ai', purpose: 'drill', role: input.role, type: skill.type, topic, difficulty: belief ? drillDifficulty(belief) : 'Intermediate',
    ...SESSION[input.dailyMinutes ?? 10], focusSkills };
}

// Today's drill: a skill due for a spaced retest first, then a first estimate for any focus area never practised,
// then the skill with the lowest plausible level (lower bound), so an uncertain estimate gets measured again.
// When a skill builds on a weaker foundation, the drill works on the foundation instead.
export function selectDrill(input: { states: Map<string, StateLike>; focusTypes: InterviewType[]; dailyMinutes?: 10 | 20 | 30; role: string; now: Date; skillId?: string }): Drill | null {
  const practised = candidates(input.states, INTERVIEW_TYPES, input.now);
  if (input.skillId) {
    const skill = SKILL_BY_ID.get(input.skillId);
    if (!skill) return null;
    const belief = practised.find(c => c.skill.id === skill.id)?.belief;
    return { skillId: skill.id, skillLabel: skill.label, kind: 'chosen', reason: belief ? `You chose ${skill.label} (${estimate(belief)}).` : `You chose ${skill.label}. This drill gives a first estimate.`,
      config: drillConfig(skill, belief, practised, input) };
  }
  const inFocus = practised.filter(c => input.focusTypes.includes(c.skill.type));
  const due = inFocus.filter(c => c.due.getTime() <= input.now.getTime()).sort(lowestFirst);
  let pick: Candidate | undefined = due[0];
  let kind: Drill['kind'] = 'retest';
  if (!pick) {
    const unstarted = input.focusTypes.find(t => !inFocus.some(c => c.skill.type === t));
    if (unstarted) {
      const skill = unstarted === 'Technical' ? TECHNICAL_TOPICS[0] : SKILLS.find(s => s.kind === 'topic' && s.type === unstarted)!;
      return { skillId: skill.id, skillLabel: skill.label, kind: 'baseline',
        reason: `You have no ${unstarted === 'HR' ? 'HR' : unstarted.toLowerCase()} practice yet. This short drill gives a first estimate.`,
        config: drillConfig(skill, undefined, practised, input) };
    }
    pick = [...inFocus].sort(lowestFirst)[0];
    kind = 'weakest';
  }
  if (!pick) return null;
  const chosen: Candidate = pick;
  let target: Candidate = pick;
  for (let depth = 0; depth < 3; depth++) {
    const step: Candidate = target;
    const weaker: Candidate | undefined = step.skill.foundations.map(id => practised.find(c => c.skill.id === id))
      .filter((c): c is Candidate => !!c && c.belief.mean < 2.5 && c.belief.mean < step.belief.mean).sort(lowestFirst)[0];
    if (!weaker) break;
    target = weaker;
  }
  pick = target;
  const reason = pick !== chosen ? `${chosen.skill.label} builds on ${pick.skill.label}, which is weaker (${estimate(pick.belief)}), so this drill starts there.`
    : kind === 'retest' ? `${pick.skill.label} is due for a spaced retest, so you keep what you learned (${estimate(pick.belief)}).`
      : `${pick.skill.label} has your lowest estimate (${estimate(pick.belief)}).`;
  return { skillId: pick.skill.id, skillLabel: pick.skill.label, kind: pick !== chosen ? 'foundation' : kind, reason,
    config: drillConfig(pick.skill, pick.belief, practised, input) };
}

export function skillView(skill: Skill, state: StateLike | undefined, now: Date) {
  const base = { id: skill.id, label: skill.label, kind: skill.kind, type: skill.type, foundations: skill.foundations };
  if (!state) return { ...base, practised: false as const };
  const belief = current(state, now);
  const due = new Date(state.card.due);
  return { ...base, practised: true as const, mean: round(belief.mean), sd: round(sd(belief)), lower: round(lowerBound(belief)), upper: round(upperBound(belief)),
    level: level(belief), lowConfidence: lowConfidence(belief), observations: state.observations, lastObservedAt: state.lastObservedAt,
    due, isDue: due.getTime() <= now.getTime(), history: state.history.slice(-12).map(p => ({ at: p.at, mean: p.mean })) };
}

export function planView(plan: Pick<IStudyPlan, 'interviewDate' | 'focusTypes' | 'dailyMinutes'> | null, now: Date, timeZone: string) {
  if (!plan) return null;
  const interviewDate = plan.interviewDate.toISOString().slice(0, 10);
  return { interviewDate, daysLeft: daysBetween(localDay(now, timeZone), interviewDate), focusTypes: plan.focusTypes, dailyMinutes: plan.dailyMinutes };
}

async function learnerContext(userId: string) {
  const owner = new mongoose.Types.ObjectId(userId);
  await ensureFreshSkills(userId);
  const [states, plan, recent] = await Promise.all([
    SkillState.find({ userId: owner }).lean(),
    StudyPlan.findOne({ userId: owner }).lean(),
    Interview.findOne({ userId: owner }).sort({ createdAt: -1, _id: -1 }).select('role').lean(),
  ]);
  return { owner, states: new Map(states.map(s => [s.skillId, s as StateLike])), plan, role: recent?.role?.trim() || DEFAULT_ROLE };
}

export async function learningOverview(userId: string, timeZone: string, now = new Date()) {
  const { owner, states, plan, role } = await learnerContext(userId);
  const focusTypes = plan?.focusTypes?.length ? plan.focusTypes : INTERVIEW_TYPES;
  const completions = await Interview.find({ ...scoredFilter(owner), completedAt: { $gte: new Date(now.getTime() - 400 * DAY_MS) } })
    .select('completedAt').lean<{ completedAt: Date }[]>();
  const competencyBeliefs = (types: InterviewType[]) => SKILLS.filter(s => s.kind === 'competency' && types.includes(s.type) && states.has(s.id))
    .map(s => current(states.get(s.id)!, now));
  const skills = SKILLS.map(s => skillView(s, states.get(s.id), now));
  const weekAhead = now.getTime() + 7 * DAY_MS;
  const aiAvailable = interviewMode() === 'ai';
  return {
    aiAvailable,
    readiness: readiness(competencyBeliefs(focusTypes)),
    readinessByType: Object.fromEntries(INTERVIEW_TYPES.map(t => [t, readiness(competencyBeliefs([t]))])),
    plan: planView(plan, now, timeZone),
    drill: aiAvailable ? selectDrill({ states, focusTypes, dailyMinutes: plan?.dailyMinutes, role, now }) : null,
    skills,
    dueCount: skills.filter(s => s.practised && s.isDue && focusTypes.includes(s.type)).length,
    upcoming: skills.flatMap(s => s.practised && !s.isDue && s.due.getTime() <= weekAhead ? [{ skillId: s.id, label: s.label, due: s.due }] : [])
      .sort((a, b) => a.due.getTime() - b.due.getTime()),
    streak: practiceStreak(completions.map(c => c.completedAt), now, timeZone),
  };
}

export async function drillForSkill(userId: string, skillId: string, now = new Date()) {
  const { states, plan, role } = await learnerContext(userId);
  return selectDrill({ states, focusTypes: INTERVIEW_TYPES, dailyMinutes: plan?.dailyMinutes, role, now, skillId });
}

// Rolling seven-day weeks ending now, newest first, and the skills that moved most over the last 28 days.
export async function progressReport(userId: string, weeks: number, timeZone: string, now = new Date()) {
  const owner = new mongoose.Types.ObjectId(userId);
  await ensureFreshSkills(userId);
  const since = new Date(now.getTime() - weeks * 7 * DAY_MS);
  const [sessions, states] = await Promise.all([
    Interview.find({ userId: owner, status: 'completed', completedAt: { $gte: since } })
      .select('purpose feedback.source feedback.score completedAt').lean(),
    SkillState.find({ userId: owner }).select('skillId history').lean(),
  ]);
  const weekly = Array.from({ length: weeks }, (_, i) => {
    const end = new Date(now.getTime() - i * 7 * DAY_MS);
    const start = new Date(end.getTime() - 7 * DAY_MS);
    const inWeek = sessions.filter(s => s.completedAt! > start && s.completedAt! <= end);
    const scores = inWeek.flatMap(s => s.feedback?.source === 'ai' && typeof s.feedback.score === 'number' ? [s.feedback.score] : []);
    return { start: localDay(new Date(start.getTime() + 1), timeZone), end: localDay(end, timeZone),
      drills: inWeek.filter(s => s.purpose === 'drill').length, interviews: inWeek.filter(s => s.purpose !== 'drill').length,
      averageScore: scores.length ? Math.round(average(scores)) : null };
  });
  const cutoff = now.getTime() - 28 * DAY_MS;
  const changes = states.flatMap(state => {
    const skill = SKILL_BY_ID.get(state.skillId);
    const history = state.history ?? [];
    if (!skill || history.length < 2) return [];
    const before = history.filter(p => new Date(p.at).getTime() <= cutoff).at(-1);
    const from = before ?? history[0];
    const to = history.at(-1)!;
    return from === to ? [] : [{ skillId: skill.id, label: skill.label, from: from.mean, to: to.mean, change: round(to.mean - from.mean),
      sinceFirstPractice: !before }];
  });
  return {
    weeks: weekly,
    gains: changes.filter(c => c.change >= 0.1).sort((a, b) => b.change - a.change).slice(0, 3),
    declines: changes.filter(c => c.change <= -0.1).sort((a, b) => a.change - b.change).slice(0, 3),
  };
}
