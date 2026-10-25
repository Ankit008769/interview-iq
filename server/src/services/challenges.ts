import { randomUUID } from 'node:crypto';
import { Interview } from '../models/Interview.js';
import { User } from '../models/User.js';
import { reviewChallenge } from './ai.js';
import { operationalEvent } from './monitoring.js';
import { ConsentRequiredError } from './providerConsent.js';
import { consumeAIQuota, QuotaError } from './quotas.js';
import { workLeaseMs } from './providerConfig.js';

export const MAX_CHALLENGES_PER_INTERVIEW = 3;
export const MAX_CHALLENGE_ATTEMPTS = 3;
const failureMessage = 'The re-review could not finish. Your challenge is saved; you can try again.';

// Same formula as summarizeEvidence (mean of all criteria × 20, no evidence counted as 0), computed in one
// atomic update from the stored ratings so concurrent revisions converge on the latest state.
const recomputeScore = [{ $set: { 'feedback.score': { $let: {
  vars: { all: { $reduce: { input: { $ifNull: ['$feedback.answers', []] }, initialValue: [], in: { $concatArrays: ['$$value', '$$this.criteria'] } } } },
  in: { $cond: [{ $gt: [{ $size: '$$all' }, 0] },
    { $floor: { $add: [{ $multiply: [{ $avg: { $map: { input: '$$all', in: { $ifNull: ['$$this.score', 0] } } } }, 20] }, 0.5] } }, null] } } } } }];

// Challenges live inside the interview document, so export and account deletion already cover them.
// Lease tokens fence out a late result from a worker whose lease was reclaimed, as for interview jobs.
export async function processNextChallengeJob(): Promise<boolean> {
  const now = new Date();
  await Interview.updateMany({ challenges: { $elemMatch: { state: 'processing', leaseUntil: { $lte: now }, attempts: { $gte: MAX_CHALLENGE_ATTEMPTS } } } },
    { $set: { 'challenges.$[c].state': 'failed', 'challenges.$[c].error': failureMessage },
      $unset: { 'challenges.$[c].leaseToken': 1, 'challenges.$[c].leaseUntil': 1 } },
    { arrayFilters: [{ 'c.state': 'processing', 'c.leaseUntil': { $lte: now }, 'c.attempts': { $gte: MAX_CHALLENGE_ATTEMPTS } }] });

  const token = randomUUID();
  const doc = await Interview.findOneAndUpdate({ challenges: { $elemMatch: { attempts: { $lt: MAX_CHALLENGE_ATTEMPTS },
    $or: [{ state: 'queued', nextAttemptAt: { $lte: now } }, { state: 'processing', leaseUntil: { $lte: now } }] } } },
  { $set: { 'challenges.$.state': 'processing', 'challenges.$.leaseToken': token, 'challenges.$.leaseUntil': new Date(now.getTime() + workLeaseMs()) },
    $inc: { 'challenges.$.attempts': 1 } }, { new: true, sort: { 'challenges.nextAttemptAt': 1 } });
  const challenge = doc?.challenges.find(c => c.leaseToken === token);
  if (!doc || !challenge) return Boolean(doc);
  const fence = { _id: doc._id, challenges: { $elemMatch: { id: challenge.id, state: 'processing', leaseToken: token } } };
  const mine = { 'ch.id': challenge.id, 'ch.state': 'processing', 'ch.leaseToken': token };
  const unlock = { 'challenges.$[ch].leaseToken': 1, 'challenges.$[ch].leaseUntil': 1 };
  try {
    // A deleted account's interviews are removed by account cleanup; spend nothing on them.
    if (!await User.exists({ _id: doc.userId, deletionRequestedAt: { $exists: false } })) return true;
    await consumeAIQuota(doc.userId.toString());
    const { rating, generation } = await reviewChallenge({ usageContext: { userId: doc.userId.toString(), interviewId: doc.id },
      role: doc.role, type: doc.type, difficulty: doc.difficulty, topic: doc.topic, turn: doc.turns[challenge.questionIndex],
      criterionId: challenge.criterionId, original: challenge.original, reason: challenge.reason });
    const decision = rating.score === challenge.original.score ? 'upheld' : 'revised';
    const set: Record<string, unknown> = { 'challenges.$[ch].state': 'resolved', 'challenges.$[ch].resolvedAt': new Date(),
      'challenges.$[ch].outcome': { decision, rating, generation } };
    const arrayFilters: Record<string, unknown>[] = [mine];
    if (decision === 'revised') {
      // The original rating stays in the challenge record; the scorecard shows the revision and who made it.
      set['feedback.answers.$[a].criteria.$[k]'] = { ...rating, revisedBy: challenge.id };
      arrayFilters.push({ 'a.questionIndex': challenge.questionIndex }, { 'k.criterionId': challenge.criterionId });
    }
    const result = await Interview.updateOne(fence, { $set: set,
      $unset: { ...unlock, 'challenges.$[ch].error': 1, 'challenges.$[ch].nextAttemptAt': 1 } }, { arrayFilters });
    if (result.modifiedCount && decision === 'revised') await Interview.updateOne({ _id: doc._id }, recomputeScore);
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      await Interview.updateOne(fence, { $set: { 'challenges.$[ch].state': 'failed', 'challenges.$[ch].error': err.message }, $unset: unlock }, { arrayFilters: [mine] });
      return true;
    }
    operationalEvent('score_challenge_failure', 'WARNING');
    if (err instanceof QuotaError) {
      await Interview.updateOne(fence, { $set: { 'challenges.$[ch].state': 'queued', 'challenges.$[ch].error': err.message,
        'challenges.$[ch].nextAttemptAt': err.resetAt }, $inc: { 'challenges.$[ch].attempts': -1 }, $unset: unlock }, { arrayFilters: [mine] });
      return true;
    }
    // Never store provider payloads or candidate content in the error.
    await Interview.updateOne(fence, { $set: { 'challenges.$[ch].state': challenge.attempts >= MAX_CHALLENGE_ATTEMPTS ? 'failed' : 'queued',
      'challenges.$[ch].error': failureMessage, 'challenges.$[ch].nextAttemptAt': new Date(Date.now() + 1000 * 2 ** challenge.attempts) },
    $unset: unlock }, { arrayFilters: [mine] });
  }
  return true;
}
