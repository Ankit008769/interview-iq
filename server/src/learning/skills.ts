import type { InterviewType } from '../models/Interview.js';

// The skill graph for adaptive practice (roadmap C5). Topic skills follow the interview topics; competency skills
// are the rubric criteria, so every scored answer feeds both. "foundations" are prerequisite links: when a
// foundation is weak, drills work on it before the skill that builds on it.
export type SkillKind = 'topic' | 'competency';
export type Skill = {
  id: string; label: string; kind: SkillKind; type: InterviewType;
  topic?: string; criterionId?: string; foundations: string[]; drillFocus: string;
};

const topic = (id: string, label: string, type: InterviewType, interviewTopic: string, drillFocus: string): Skill =>
  ({ id: `topic.${id}`, label, kind: 'topic', type, topic: interviewTopic, foundations: [], drillFocus });
const competency = (type: InterviewType, criterionId: string, label: string, foundations: string[], drillFocus: string): Skill =>
  ({ id: `${type.toLowerCase()}.${criterionId}`, label, kind: 'competency', type, criterionId, foundations, drillFocus });

export const SKILLS: Skill[] = [
  topic('dsa', 'Data structures and algorithms', 'Technical', 'DSA', 'data structures, algorithms and their time and space complexity'),
  topic('react', 'React', 'Technical', 'React', 'React components, state, hooks and rendering performance'),
  topic('nodejs', 'Node.js', 'Technical', 'Node.js', 'Node.js, the event loop, asynchronous code and building APIs'),
  topic('dbms', 'Databases', 'Technical', 'DBMS', 'database design, SQL, indexing and transactions'),
  topic('behavioral', 'Behavioral stories', 'Behavioral', 'Behavioral', 'telling a concrete story about past work'),
  topic('hr', 'HR and career questions', 'HR', 'General', 'motivation, career goals and fit for the role'),
  competency('Technical', 'correctness', 'Technical correctness', [], 'stating technically correct facts and reasoning'),
  competency('Technical', 'depth', 'Depth of understanding', ['technical.correctness'], 'explaining how and why something works, not only what it does'),
  competency('Technical', 'approach', 'Problem-solving approach', ['technical.correctness'], 'working through a problem step by step before answering'),
  competency('Technical', 'tradeoffs', 'Trade-off awareness', ['technical.depth'], 'comparing alternatives and their costs'),
  competency('Technical', 'clarity', 'Technical communication', [], 'explaining a technical idea clearly and in order'),
  competency('Behavioral', 'star', 'STAR structure', [], 'describing the situation, task, action and result'),
  competency('Behavioral', 'ownership', 'Personal ownership', ['behavioral.star'], 'making clear what you personally did'),
  competency('Behavioral', 'impact', 'Impact', ['behavioral.star'], 'stating a specific, measurable outcome'),
  competency('Behavioral', 'reflection', 'Reflection and learning', ['behavioral.star'], 'what you learned and would do differently'),
  competency('Behavioral', 'relevance', 'Answering the question asked', [], 'choosing an example that directly answers the question'),
  competency('HR', 'understanding', 'Role understanding', [], 'showing a specific understanding of the target role'),
  competency('HR', 'motivation', 'Motivation', ['hr.understanding'], 'connecting your interests and experience to the role'),
  competency('HR', 'framing', 'Professional framing', [], 'framing difficult topics constructively'),
  competency('HR', 'consistency', 'Consistency', [], 'keeping your statements consistent within an answer'),
];
export const SKILL_BY_ID = new Map(SKILLS.map(s => [s.id, s]));

// Which skills one scored answer informs: its topic skill and the competency for every rubric criterion.
export function skillsForAnswer(type: InterviewType, interviewTopic: string, criterionIds: string[]): { topic?: Skill; competencies: Skill[] } {
  const topicSkill = SKILLS.find(s => s.kind === 'topic' && s.type === type && (type !== 'Technical' || s.topic === interviewTopic));
  return { topic: topicSkill, competencies: criterionIds.map(id => SKILL_BY_ID.get(`${type.toLowerCase()}.${id}`)).filter((s): s is Skill => !!s) };
}
