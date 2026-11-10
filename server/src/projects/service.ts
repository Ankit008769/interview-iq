import mongoose from 'mongoose';
import { Interview } from '../models/Interview.js';
import { MAX_PROJECTS_PER_USER, Project, type IProject } from '../models/Project.js';
import { REMOVED_QUESTION } from '../services/documents.js';
import { findDependencies, indexSymbols, type CodeSymbol } from './codeIndex.js';
import { ingestZip, ProjectZipError } from './ingest.js';

export { ProjectZipError };
export class ProjectLimitError extends Error {}
export type QuestionProject = Pick<IProject, 'name' | 'files' | 'symbols' | 'dependencies'> & { _id: mongoose.Types.ObjectId };

export async function createProject(userId: string, name: string, zip: Buffer) {
  if (await Project.countDocuments({ userId }) >= MAX_PROJECTS_PER_USER) throw new ProjectLimitError(`You can keep up to ${MAX_PROJECTS_PER_USER} projects. Delete one first.`);
  const ingested = await ingestZip(zip);
  const project = await Project.create({ userId, name, files: ingested.files, symbols: await indexSymbols(ingested.files),
    dependencies: findDependencies(ingested.files), secrets: ingested.secrets, secretFiles: ingested.secretFiles, skipped: ingested.skipped });
  // Two uploads racing past the first check: the later one is removed.
  if (await Project.countDocuments({ userId }) > MAX_PROJECTS_PER_USER) {
    await Project.deleteOne({ _id: project._id });
    throw new ProjectLimitError(`You can keep up to ${MAX_PROJECTS_PER_USER} projects. Delete one first.`);
  }
  return project;
}

// What the browser sees: never the full file texts, only paths, sizes and the index.
export function projectView(p: IProject & { _id: mongoose.Types.ObjectId }, detail = false) {
  const languages = new Map<string, number>();
  for (const f of p.files) languages.set(f.language, (languages.get(f.language) ?? 0) + 1);
  return {
    id: String(p._id), name: p.name, createdAt: p.createdAt, deleting: !!p.deletingAt,
    stats: { files: p.files.length, lines: p.files.reduce((n, f) => n + f.lines, 0), bytes: p.files.reduce((n, f) => n + f.size, 0), symbols: p.symbols.length,
      dependencies: p.dependencies.length, languages: [...languages].sort((a, b) => b[1] - a[1]).map(([language, files]) => ({ language, files })) },
    skipped: p.skipped, secrets: p.secrets, secretFiles: p.secretFiles,
    ...(detail ? { files: p.files.map(f => ({ path: f.path, language: f.language, lines: f.lines, size: f.size })), symbols: p.symbols, dependencies: p.dependencies,
      claimChecks: [...p.claimChecks].reverse() } : {}),
  };
}

export async function liveProject(userId: string | mongoose.Types.ObjectId, id: string | mongoose.Types.ObjectId): Promise<QuestionProject | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  return Project.findOne({ _id: id, userId, deletingAt: { $exists: false } }).select('name files symbols dependencies').lean<QuestionProject>();
}

const isTest = (path: string) => /(^|\/)(__tests__|tests?|spec|e2e|__mocks__|fixtures?)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path);
const isConfig = (path: string) => /(^|\/)(\.[^/]+|[^/]*config\.[a-z]+|[^/]*\.config\.[a-z]+|setup\.py|manage\.py)$/i.test(path);
// Small helpers are poor interview material; routes are always worth asking about.
const worthAsking = (s: CodeSymbol) => !isTest(s.path) && !isConfig(s.path) && (s.kind === 'route' || s.endLine - s.line >= 3);

// The app, not the model, chooses what each question is about: a different function, method, class or route
// each time, spread across files, starting from a place that depends on the interview so two interviews on
// the same project differ.
export function pickTarget(project: QuestionProject, asked: { path: string; symbol: string }[], seed: string): CodeSymbol | null {
  const done = new Set(asked.map(a => `${a.path}#${a.symbol}`));
  const candidates = project.symbols.filter(s => worthAsking(s) && !done.has(`${s.path}#${s.name}`));
  if (!candidates.length) return null;
  const byFile = new Map<string, CodeSymbol[]>();
  for (const s of candidates) byFile.set(s.path, [...(byFile.get(s.path) ?? []), s]);
  const askedFiles = new Set(asked.map(a => a.path));
  // Prefer files not asked about yet, then files with more substantial code.
  const files = [...byFile.keys()].sort((a, b) => Number(askedFiles.has(a)) - Number(askedFiles.has(b))
    || byFile.get(b)!.reduce((n, s) => n + s.endLine - s.line, 0) - byFile.get(a)!.reduce((n, s) => n + s.endLine - s.line, 0) || a.localeCompare(b));
  const fresh = files.filter(f => !askedFiles.has(f));
  const pool = (fresh.length ? fresh : files).slice(0, 8);
  const hash = [...seed].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, asked.length + 7);
  const file = pool[hash % pool.length];
  const symbols = byFile.get(file)!.sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line));
  return symbols[hash % Math.min(3, symbols.length)];
}

export const MAX_EXCERPT_LINES = 60;
export function excerptFor(project: Pick<IProject, 'files'>, path: string, start: number, end: number) {
  const file = project.files.find(f => f.path === path);
  if (!file) return null;
  const lines = file.text.split('\n');
  const from = Math.max(1, start), to = Math.min(lines.length, end, from + MAX_EXCERPT_LINES - 1);
  return { startLine: from, endLine: to, text: lines.slice(from - 1, to).join('\n'), truncated: to < Math.min(lines.length, end) };
}

export function projectSummary(project: QuestionProject) {
  return { name: project.name, files: project.files.filter(f => !isTest(f.path)).slice(0, 150).map(f => f.path),
    dependencies: project.dependencies.slice(0, 40).map(d => d.name), symbols: project.symbols.length };
}

// Deleting a project removes every question generated from it, as for documents: the interview keeps the
// answer but the question text is replaced and the code excerpt is dropped.
export async function removeProjectQuestions(userId: string | mongoose.Types.ObjectId, projectId: mongoose.Types.ObjectId) {
  await Interview.updateMany({ userId, projectId }, { $unset: { projectId: 1 } });
  await Interview.updateMany({ userId, 'currentQuestionGrounding.code.projectId': projectId },
    { $set: { currentQuestion: REMOVED_QUESTION }, $unset: { currentQuestionGrounding: 1 } });
  await Interview.updateMany({ userId, 'turns.grounding.code.projectId': projectId },
    { $set: { 'turns.$[t].question': REMOVED_QUESTION }, $unset: { 'turns.$[t].grounding': 1 } },
    { arrayFilters: [{ 't.grounding.code.projectId': projectId }] });
}

export async function deleteProject(userId: string, id: string): Promise<boolean> {
  const project = await Project.findOneAndUpdate({ _id: id, userId }, { $min: { deletingAt: new Date() } }, { new: true }).select('_id');
  if (!project) return false;
  await removeProjectQuestions(userId, project._id);
  await Project.deleteOne({ _id: project._id, userId });
  return true;
}
