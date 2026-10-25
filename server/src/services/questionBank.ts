import { randomInt } from 'node:crypto';
import mongoose from 'mongoose';
import { Interview, type AnswerTurn, type InterviewLevel, type InterviewType } from '../models/Interview.js';
import { REMOVED_QUESTION } from './documents.js';

// Curated practice questions. Authored for Phase A4; pending human content review (see docs/QUESTION_BANK.md).
export const QUESTION_BANK_VERSION = '2026-10-24.v2';
export type BankTopic = 'DSA' | 'React' | 'Node.js' | 'DBMS' | 'Behavioral' | 'General';
export interface BankQuestion { id: string; topic: BankTopic; difficulty: InterviewLevel; question: string }

type Levels = Record<InterviewLevel, string[]>;
const source: Record<BankTopic, { prefix: string; levels: Levels }> = {
  DSA: { prefix: 'dsa', levels: {
    Beginner: [
      'Explain the difference between an array and a linked list. When would you use each?',
      'What is the time complexity of searching an unsorted array versus a sorted array, and why?',
      'How does a stack differ from a queue? Give a real-world use for each.',
      'What is a hash map, and why are lookups usually O(1) on average?',
      'Explain BFS versus DFS and describe a scenario where each is preferable.',
      'What is recursion? What is a base case, and what happens if it is missing?',
    ],
    Intermediate: [
      'How do you detect a cycle in a linked list? Explain the time and space complexity.',
      'What is a monotonic stack? Give a practical problem where it is useful.',
      'How would you find the maximum value in each sliding window of size k?',
      'Explain how a binary heap supports a priority queue. What do insert and extract cost?',
      'What causes hash collisions, and how do chaining and open addressing handle them?',
      'When would you use dynamic programming instead of plain recursion? Illustrate with an example.',
    ],
    Advanced: [
      'Design an LRU cache with O(1) get and put. Which data structures would you combine and why?',
      'How would you find the k most frequent elements in a stream that does not fit in memory?',
      "Explain Dijkstra's algorithm. Why does it fail with negative edge weights, and what would you use instead?",
      'How would you detect a cycle in a directed graph, and how does that relate to topological sorting?',
      'Compare a balanced binary search tree with a hash table for an ordered key-value store. Which trade-offs matter?',
      'How would you track the median of a continuously growing stream of numbers efficiently?',
    ],
  } },
  React: { prefix: 'react', levels: {
    Beginner: [
      'Explain the difference between state and props with an example.',
      'What are React keys, and why do stable keys matter?',
      'What is JSX, and how does it differ from HTML?',
      'What is the difference between a controlled and an uncontrolled form input?',
      'How does the useEffect dependency array control when an effect runs?',
      'How do you lift state up to share it between sibling components?',
    ],
    Intermediate: [
      'What causes a React component to re-render?',
      'How would you prevent unnecessary network requests in a React app?',
      'When are useMemo and useCallback worth using, and when do they add needless complexity?',
      'How does the Context API work, and what performance problems can it introduce?',
      'How would you handle loading, error and empty states for data fetched from an API?',
      'How would you clean up subscriptions or timers created in an effect, and why does it matter?',
    ],
    Advanced: [
      'How would you structure reusable components in a large application?',
      'How does React reconciliation decide what to update in the DOM, and where can it go wrong?',
      'How would you diagnose and fix a slow, frequently re-rendering list of thousands of items?',
      'Compare client-side rendering, server-side rendering and static generation. When would you choose each?',
      'What belongs in local state, context, a server cache or a global store in a large React app?',
      'How would you prevent race conditions when several requests update the same component state?',
    ],
  } },
  'Node.js': { prefix: 'node', levels: {
    Beginner: [
      'Explain the Node.js event loop at a high level.',
      'What is the difference between synchronous and asynchronous functions in Node.js?',
      'What does middleware do in an Express application? Give an example.',
      'How do environment variables help configure a Node.js app, and what should never be committed to Git?',
      'What is the difference between require and import in Node.js?',
      'How would you handle errors in an async Express route?',
    ],
    Intermediate: [
      'How would you design authentication for an Express API?',
      'How would you protect your API from excessive requests?',
      'When should you use a background job instead of a normal HTTP request?',
      'How do streams help when processing large files in Node.js?',
      'How would you validate and sanitize request input in an Express API?',
      'What is the difference between process.nextTick, setImmediate and setTimeout?',
    ],
    Advanced: [
      'How would you diagnose a slow endpoint in production?',
      'How would you make a payment or order endpoint idempotent when clients retry?',
      'How would you scale a Node.js service across CPU cores and machines? Which state must change?',
      'How would you find and fix a memory leak in a long-running Node.js process?',
      'Design a rate limiter that works correctly across several API instances.',
      'How would you shut down a Node.js server gracefully without losing in-flight work?',
    ],
  } },
  DBMS: { prefix: 'dbms', levels: {
    Beginner: [
      'What is the difference between an index and a primary key?',
      'What is the difference between SQL and NoSQL databases? Give a use case for each.',
      'Explain the difference between INNER JOIN and LEFT JOIN with an example.',
      'What is normalization, and why is it useful?',
      'What is a foreign key, and how does it maintain integrity?',
      'What is the difference between WHERE and HAVING in SQL?',
    ],
    Intermediate: [
      'Explain database transactions and why atomicity matters.',
      'When is denormalization useful? What trade-offs does it create?',
      'How would you debug a slow database query?',
      'What are transaction isolation levels, and which anomalies does each prevent?',
      'How does a compound index work, and why does the order of its fields matter?',
      'Would you embed or reference a one-to-many relationship in MongoDB? Explain the trade-offs.',
    ],
    Advanced: [
      'Explain optimistic concurrency control with an example.',
      'How would you shard a large table or collection, and how do you choose a shard key?',
      'What is replication lag, how can it cause stale reads, and how would you handle them?',
      "How would you change a large production table's schema without downtime?",
      'What is a deadlock, and how would you prevent or resolve one?',
      'How would you paginate a feed with millions of rows, and why is offset pagination a problem?',
    ],
  } },
  Behavioral: { prefix: 'beh', levels: {
    Beginner: [
      'Tell me about a project you are proud of and what you personally built.',
      'Describe a situation when you had to learn a tool quickly.',
      'Tell me about a time you worked in a team to meet a deadline.',
      'Describe a time you received feedback. What did you change afterward?',
      'Tell me about a time you helped a classmate or colleague solve a problem.',
      'Describe a goal you set for yourself and how you achieved it.',
    ],
    Intermediate: [
      'Describe a time you faced a difficult technical problem.',
      'Tell me about a disagreement with a teammate and how you handled it.',
      'Tell me about a mistake and what changed in your process afterward.',
      'Describe a time you had to balance several priorities. How did you decide what came first?',
      'Tell me about a time you explained a technical idea to a non-technical person.',
      'Describe a time requirements changed late in a project. How did you respond?',
    ],
    Advanced: [
      'Tell me about a decision you made with incomplete information. How did it turn out?',
      'Describe a time you influenced a team decision without formal authority.',
      'Tell me about a project that failed or was cancelled. What did you learn?',
      'Describe a time you pushed back on a deadline or scope. How did you make your case?',
      'Tell me about a time you improved a process others had accepted for a long time.',
      'Describe a conflict between quality and speed you had to resolve. Which trade-off did you choose?',
    ],
  } },
  General: { prefix: 'hr', levels: {
    Beginner: [
      'Tell me about yourself and why this role interests you.',
      'What skills make you a good fit for this role?',
      'What are your strengths, and how have you used them recently?',
      'What is one area you are working to improve, and what are you doing about it?',
      'Why do you want to work at a company like ours?',
      'Where do you see yourself in the next two to three years?',
    ],
    Intermediate: [
      'Describe the most challenging project you have worked on.',
      'How do you approach unfamiliar problems?',
      'What would you like to improve in your technical skills?',
      'How do you prefer to receive feedback, and how do you act on it?',
      'What kind of work environment helps you do your best work?',
      'Tell me about a time you were proud of how you handled pressure.',
    ],
    Advanced: [
      'How do you decide which opportunities to pursue in your career?',
      'What would your first 90 days in this role look like?',
      'How do you keep your skills current as technology changes?',
      'Tell me about a time a request conflicted with your values. What did you do?',
      'How would you handle being assigned work you believe is not the best use of your skills?',
      'What would make you consider leaving a job, and how would you raise it with your manager?',
    ],
  } },
};

const letter: Record<InterviewLevel, string> = { Beginner: 'b', Intermediate: 'i', Advanced: 'a' };
export const QUESTION_BANK: BankQuestion[] = Object.entries(source).flatMap(([topic, { prefix, levels }]) =>
  (Object.entries(levels) as [InterviewLevel, string[]][]).flatMap(([difficulty, questions]) =>
    questions.map((question, i) => ({ id: `${prefix}-${letter[difficulty]}${i + 1}`, topic: topic as BankTopic, difficulty, question }))));

export function bankTopicFor(type: InterviewType, topic: string): BankTopic {
  if (type === 'Behavioral') return 'Behavioral';
  if (type === 'HR') return 'General';
  return (['DSA', 'React', 'Node.js', 'DBMS'] as string[]).includes(topic) ? topic as BankTopic : 'General';
}

const normalize = (text: string) => text.trim().toLowerCase();

// Never repeat within a session; prefer questions this user has not seen recently, else the least recently seen.
export function pickPracticeQuestion(input: { type: InterviewType; topic: string; difficulty: InterviewLevel;
  history: Pick<AnswerTurn, 'question' | 'questionId'>[]; recentIds: string[]; random?: (max: number) => number }): BankQuestion {
  const topic = bankTopicFor(input.type, input.topic);
  const askedIds = new Set(input.history.map(t => t.questionId).filter(Boolean));
  const askedText = new Set(input.history.map(t => normalize(t.question)));
  const fresh = (q: BankQuestion) => !askedIds.has(q.id) && !askedText.has(normalize(q.question));
  let available = QUESTION_BANK.filter(q => q.topic === topic && q.difficulty === input.difficulty && fresh(q));
  if (!available.length) available = QUESTION_BANK.filter(q => q.topic === topic && fresh(q));
  if (!available.length) throw new Error('The practice question bank is exhausted for this topic.');
  const unseen = available.filter(q => !input.recentIds.includes(q.id));
  if (unseen.length) return unseen[(input.random ?? randomInt)(unseen.length)];
  return available.reduce((oldest, q) => input.recentIds.indexOf(q.id) > input.recentIds.indexOf(oldest.id) ? q : oldest);
}

// Most recent first: each interview's current question, then its answered turns newest to oldest.
// The candidate's most recent questions from earlier interviews, newest first, so generated questions stay fresh.
// Questions removed with a deleted document are skipped.
export async function recentQuestionTexts(userId: string, excludeInterviewId?: string, limit = 20): Promise<string[]> {
  const docs = await Interview.find({ userId: new mongoose.Types.ObjectId(userId), ...(excludeInterviewId ? { _id: { $ne: excludeInterviewId } } : {}) })
    .sort({ createdAt: -1, _id: -1 }).limit(10).select('turns.question').lean();
  const seen = new Set<string>();
  return docs.flatMap(d => [...d.turns].reverse().map(t => t.question))
    .filter(q => q !== REMOVED_QUESTION && !seen.has(q) && Boolean(seen.add(q))).slice(0, limit);
}

export async function recentQuestionIds(userId: string, interviews = 30): Promise<string[]> {
  const docs = await Interview.find({ userId: new mongoose.Types.ObjectId(userId) }).sort({ createdAt: -1, _id: -1 })
    .limit(interviews).select('currentQuestionId turns.questionId').lean();
  return docs.flatMap(d => [d.currentQuestionId, ...[...d.turns].reverse().map(t => t.questionId)])
    .filter((id): id is string => Boolean(id));
}
