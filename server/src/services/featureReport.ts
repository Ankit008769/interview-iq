import { FeatureEvent, FEATURES } from '../models/FeatureEvent.js';
import { Interview } from '../models/Interview.js';

const DAY = 86_400_000;
const rate = (n: number, d: number) => (d ? Math.round(1000 * n / d) / 10 : null);

// D4 exit gate: opt-in rate and satisfaction for optional features, and whether users who turned a feature on
// came back more often. Counts only; no user IDs are returned.
// - active: users who started an interview in the window;
// - opted in: active users who switched the feature on in the window;
// - returned within 7 days: users whose first interview in the window (at least 7 days before the end) was
//   followed by another one starting more than an hour and at most 7 days later.
export async function featureReport(days = 30, now = new Date()) {
  const from = new Date(now.getTime() - days * DAY);
  const firsts = await Interview.aggregate<{ _id: unknown; first: Date; starts: Date[] }>([
    { $match: { createdAt: { $gte: from, $lte: now } } },
    { $group: { _id: '$userId', first: { $min: '$createdAt' }, starts: { $push: '$createdAt' } } },
  ]);
  const returned = new Map(firsts.filter(u => u.first.getTime() <= now.getTime() - 7 * DAY)
    .map(u => [String(u._id), u.starts.some(t => t.getTime() > u.first.getTime() + 3_600_000 && t.getTime() <= u.first.getTime() + 7 * DAY)]));
  const features: Record<string, unknown> = {};
  for (const feature of FEATURES) {
    const [enabledBy, ratings] = await Promise.all([
      FeatureEvent.distinct('userId', { feature, kind: 'enabled', createdAt: { $gte: from, $lte: now } }),
      FeatureEvent.find({ feature, kind: 'rating', createdAt: { $gte: from, $lte: now } }).select('rating').lean(),
    ]);
    const on = new Set(enabledBy.map(String));
    const optedIn = firsts.filter(u => on.has(String(u._id))).length;
    const group = (withFeature: boolean) => {
      const users = [...returned].filter(([id]) => on.has(id) === withFeature);
      return { users: users.length, returnedWithin7Days: rate(users.filter(([, r]) => r).length, users.length) };
    };
    const values = ratings.map(r => r.rating!).filter(Boolean);
    features[feature] = {
      activeUsers: firsts.length, optedIn, optInRate: rate(optedIn, firsts.length),
      ratings: values.length, meanRating: values.length ? Math.round(100 * values.reduce((a, b) => a + b, 0) / values.length) / 100 : null,
      ratingCounts: [1, 2, 3, 4, 5].map(n => values.filter(v => v === n).length),
      retention: { withFeature: group(true), withoutFeature: group(false) },
    };
  }
  return { windowDays: days, from: from.toISOString(), to: now.toISOString(), features };
}
