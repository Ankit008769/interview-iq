import { randomBytes, randomInt } from 'node:crypto';
import mongoose from 'mongoose';
import { PassportCredential, type AchievementKind } from '../models/Passport.js';
import { Interview } from '../models/Interview.js';
import { CodeRun } from '../models/CodeRun.js';
import { DesignSession } from '../models/DesignSession.js';
import { SkillState } from '../models/Learning.js';
import { User } from '../models/User.js';
import { SKILL_BY_ID } from '../learning/skills.js';
import { current, level, lowConfidence, lowerBound, upperBound } from '../learning/model.js';
import { PROBLEM_BY_ID } from '../coding/problems.js';
import { addProof, encodeStatusList, loadSigningKey, publicKeyFromMultibase, publicKeyMultibase, statusBit, STATUS_LIST_BITS, verifyProof } from './crypto.js';

// Skill passport (roadmap E4): signed, revocable W3C Verifiable Credentials (Data Model 2.0) for practice
// achievements, explicitly labelled as a practice record and never a hiring score. The holder chooses what
// goes in, whether their name is shown, and can revoke it at any time.
export const DISCLAIMER = 'Practice record, not a hiring score. It summarises mock-interview practice on Interview IQ, scored by AI against published rubrics; it does not assess suitability for any job.';
const VALID_DAYS = 365;
const oid = (id: string) => new mongoose.Types.ObjectId(id);

export class PassportError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

// Issuer identity: did:web for the configured host (the DID document is served at /.well-known/did.json).
export function issuer() {
  const host = process.env.PASSPORT_ISSUER_HOST?.trim();
  const pem = process.env.PASSPORT_SIGNING_KEY?.replace(/\\n/g, '\n');
  if (!host || !pem || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const keys = loadSigningKey(pem);
  const did = `did:web:${host.replace(':', '%3A')}`;
  const origin = `${host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https'}://${host}`;
  return { did, origin, keyId: `${did}#key-1`, name: 'Interview IQ', ...keys, multikey: publicKeyMultibase(keys.publicKey) };
}
export function didDocument() {
  const i = issuer();
  if (!i) return null;
  return { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: i.did,
    verificationMethod: [{ id: i.keyId, type: 'Multikey', controller: i.did, publicKeyMultibase: i.multikey }], assertionMethod: [i.keyId] };
}
const statusListUrl = (origin: string) => `${origin}/api/passport/status/1`;

// What can go into a passport, computed from the holder's own records.
export async function achievements(userId: string, now = new Date()) {
  const id = oid(userId);
  const [interviews, states, solved, designs] = await Promise.all([
    Interview.aggregate<{ _id: string; n: number }>([{ $match: { userId: id, status: 'completed', 'feedback.source': 'ai' } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    SkillState.find({ userId: id }).lean(),
    CodeRun.distinct('problemId', { userId: id, mode: 'submit', verdict: 'accepted' }),
    DesignSession.find({ userId: id, status: 'reviewed' }).select('review.criteria').lean(),
  ]);
  const total = interviews.reduce((n, r) => n + r.n, 0);
  const skills = states.map(s => ({ s, b: current(s, now), skill: SKILL_BY_ID.get(s.skillId) })).filter(x => x.skill && !lowConfidence(x.b) && ['Proficient', 'Strong'].includes(level(x.b)))
    .map(x => ({ skill: x.skill!.label, area: x.skill!.type, level: level(x.b), interval: [Math.round(lowerBound(x.b) * 10) / 10, Math.round(upperBound(x.b) * 10) / 10] as [number, number] }))
    .sort((a, b) => a.area.localeCompare(b.area) || a.skill.localeCompare(b.skill));
  const byDifficulty: Record<string, number> = {};
  for (const p of solved) { const d = PROBLEM_BY_ID.get(p)?.difficulty; if (d) byDifficulty[d] = (byDifficulty[d] ?? 0) + 1; }
  const designScores = designs.map(d => d.review?.criteria.filter(c => typeof c.score === 'number').map(c => c.score as number) ?? []).filter(s => s.length).map(s => s.reduce((a, b) => a + b, 0) / s.length);
  return {
    interviews: total ? { completedAiScoredInterviews: total, byType: Object.fromEntries(interviews.map(r => [r._id, r.n])) } : null,
    skills: skills.length ? { skills, method: 'Kalman-filtered rubric scores on a 0–5 scale; only skills at Proficient or Strong with a 95% interval narrower than about ±1.6 are listed.' } : null,
    coding: solved.length ? { problemsSolved: solved.length, byDifficulty, method: 'Accepted submissions against hidden tests, run in a sandbox.' } : null,
    design: designScores.length ? { designsReviewed: designScores.length, meanRubricScore: Math.round(designScores.reduce((a, b) => a + b, 0) / designScores.length * 10) / 10, method: 'AI review against a six-criterion trade-off rubric with verified quotes, 0–5.' } : null,
  } satisfies Record<AchievementKind, unknown>;
}

async function freeStatusIndex() {
  for (let i = 0; i < 20; i++) { const index = randomInt(STATUS_LIST_BITS); if (!await PassportCredential.exists({ statusIndex: index })) return index; }
  throw new Error('Could not allocate a status index.');
}

export async function issuePassport(userId: string, kinds: AchievementKind[], includeName: boolean, now = new Date()) {
  const i = issuer();
  if (!i) throw new PassportError('The skill passport is not configured on this server.', 503);
  const all = await achievements(userId, now);
  const chosen = [...new Set(kinds)].filter(k => all[k]);
  if (!chosen.length) throw new PassportError('Choose at least one achievement that you have.');
  if (await PassportCredential.countDocuments({ userId: oid(userId), revokedAt: { $exists: false }, validUntil: { $gt: now } }) >= 10) throw new PassportError('You can keep up to 10 active passports. Revoke one first.', 409);
  const user = await User.findById(userId).select('name').lean();
  const publicId = randomBytes(16).toString('base64url');
  const validUntil = new Date(now.getTime() + VALID_DAYS * 86_400_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const statusIndex = await freeStatusIndex();
    const doc = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: `${i.origin}/passport/${publicId}`,
      type: ['VerifiableCredential', 'InterviewPracticeRecord'],
      issuer: { id: i.did, name: i.name },
      validFrom: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), validUntil: validUntil.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      name: 'Interview IQ practice record',
      description: DISCLAIMER,
      credentialSubject: { ...(includeName && user?.name ? { name: user.name } : {}), practiceRecord: Object.fromEntries(chosen.map(k => [k, all[k]])), asOf: now.toISOString().slice(0, 10) },
      credentialStatus: { id: `${statusListUrl(i.origin)}#${statusIndex}`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: String(statusIndex), statusListCredential: statusListUrl(i.origin) },
    };
    const credential = addProof(doc, i.privateKey, i.keyId, now);
    try {
      return (await PassportCredential.create({ userId: oid(userId), publicId, statusIndex, kinds: chosen, includeName, credential, issuedAt: now, validUntil })).toObject();
    } catch (err) { if ((err as { code?: number }).code !== 11000) throw err; }
  }
  throw new Error('Could not issue the passport.');
}

// The revocation list as a signed BitstringStatusListCredential (rebuilt on request; small and cacheable).
export async function statusListCredential(now = new Date()) {
  const i = issuer();
  if (!i) return null;
  const revoked = (await PassportCredential.find({ revokedAt: { $exists: true } }).select('statusIndex').lean()).map(c => c.statusIndex);
  return addProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: statusListUrl(i.origin), type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: i.did, validFrom: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    credentialSubject: { id: `${statusListUrl(i.origin)}#list`, type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList: encodeStatusList(revoked) } }, i.privateKey, i.keyId, now);
}

// Verifies a credential issued by this server: proof, issuer key, validity period and revocation status.
export async function verifyPassport(credential: Record<string, unknown>, now = new Date()) {
  const i = issuer();
  if (!i) throw new PassportError('The skill passport is not configured on this server.', 503);
  const issuerId = typeof credential.issuer === 'string' ? credential.issuer : (credential.issuer as { id?: string } | undefined)?.id;
  const checks = {
    issuer: issuerId === i.did,
    signature: verifyProof(credential, vm => (vm === i.keyId ? publicKeyFromMultibase(i.multikey) : null)),
    current: typeof credential.validFrom === 'string' && Date.parse(credential.validFrom) <= now.getTime() && typeof credential.validUntil === 'string' && Date.parse(credential.validUntil) > now.getTime(),
    notRevoked: false,
  };
  const status = credential.credentialStatus as { statusListIndex?: string; statusListCredential?: string } | undefined;
  if (status?.statusListCredential === statusListUrl(i.origin) && status.statusListIndex && /^\d+$/.test(status.statusListIndex)) {
    const list = await statusListCredential(now);
    checks.notRevoked = !!list && !statusBit((list.credentialSubject as { encodedList: string }).encodedList, Number(status.statusListIndex));
  }
  return { valid: Object.values(checks).every(Boolean), checks };
}
