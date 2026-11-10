import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { isSecretFile, scanSecrets, type SecretFinding } from './secrets.js';

// Reads an uploaded project zip (roadmap C4) without ever writing it to disk or running it. Limits are checked
// against the sizes the archive declares and, while inflating, against the bytes actually produced, so a
// zip bomb or a lying header stops early. Only source text is kept, and only after secret redaction.
export const LIMITS = { zipBytes: 8 * 1024 * 1024, entries: 5000, fileBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024, files: 1500, ratio: 200 };

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', swift: 'swift', dart: 'dart', scala: 'scala', sql: 'sql', sh: 'shell', bash: 'shell',
  vue: 'vue', svelte: 'svelte', html: 'html', css: 'css', scss: 'scss', less: 'less', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  xml: 'xml', gradle: 'gradle', md: 'markdown', graphql: 'graphql', gql: 'graphql', prisma: 'prisma', proto: 'protobuf', tf: 'terraform',
};
const NAMED_FILES: Record<string, string> = { dockerfile: 'docker', makefile: 'make', 'docker-compose.yml': 'yaml', gemfile: 'ruby', procfile: 'text' };
const IGNORED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '.venv', 'env', '__pycache__',
  '.next', '.nuxt', '.svelte-kit', '.turbo', 'coverage', '.idea', '.vscode', 'bower_components', 'pods', '.gradle', 'bin', 'obj', '.terraform', '.cache',
  '.pytest_cache', '.mypy_cache', 'site-packages', '.expo', '.dart_tool', 'deriveddata']);
const IGNORED_FILES = [/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|poetry\.lock|pipfile\.lock|cargo\.lock|gemfile\.lock|composer\.lock|go\.sum|packages\.lock\.json)$/i,
  /\.min\.(js|css)$/i, /\.(map|lock)$/i, /^\.ds_store$/i];

export type ProjectFile = { path: string; language: string; size: number; lines: number; text: string };
export type Skipped = { ignoredFolder: number; binaryOrOther: number; tooLarge: number; secretFile: number; overLimit: number };
export type Ingested = { files: ProjectFile[]; skipped: Skipped; secrets: SecretFinding[]; secretFiles: string[] };
export class ProjectZipError extends Error {}

const open = (buffer: Buffer) => new Promise<ZipFile>((resolve, reject) =>
  yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false, decodeStrings: true }, (err, zip) => (err || !zip ? reject(err) : resolve(zip))));

function readEntry(zip: ZipFile, entry: Entry, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (err, stream) => {
    if (err || !stream) { reject(err); return; }
    const chunks: Buffer[] = []; let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) { stream.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  }));
}

// GitHub and most tools put everything under one top folder; it is not part of the project's paths.
function stripCommonRoot(paths: string[]) {
  const first = paths[0]?.split('/')[0];
  return first && paths.length > 1 && paths.every(p => p.startsWith(`${first}/`)) ? first.length + 1 : 0;
}
export const normalizePath = (raw: string) => {
  const parts = raw.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || parts.some(p => p === '..')) return null;
  return parts.join('/');
};
export const languageFor = (path: string) => {
  const name = path.split('/').at(-1)!.toLowerCase();
  return NAMED_FILES[name] ?? LANGUAGE_BY_EXTENSION[name.includes('.') ? name.split('.').at(-1)! : ''];
};

export async function ingestZip(buffer: Buffer): Promise<Ingested> {
  if (buffer.length > LIMITS.zipBytes) throw new ProjectZipError('The zip file is larger than 8 MB.');
  let zip: ZipFile;
  try { zip = await open(buffer); } catch { throw new ProjectZipError('This is not a readable zip file.'); }
  if (zip.entryCount > LIMITS.entries) { zip.close(); throw new ProjectZipError(`The zip has more than ${LIMITS.entries} entries.`); }
  const entries: Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: Entry) => { entries.push(entry); zip.readEntry(); });
    zip.on('end', resolve); zip.on('error', reject);
    zip.readEntry();
  }).catch((err: Error) => {
    // yauzl refuses entries that point outside the archive (zip slip), so the whole upload is refused.
    if (/invalid relative path|absolute path/i.test(err?.message ?? '')) throw new ProjectZipError('The zip contains a path outside the project folder (such as ../file). Zip the project folder itself and upload it again.');
    throw new ProjectZipError('The zip file is damaged.');
  });
  const skipped: Skipped = { ignoredFolder: 0, binaryOrOther: 0, tooLarge: 0, secretFile: 0, overLimit: 0 };
  const candidates = entries.flatMap(entry => {
    if (entry.fileName.endsWith('/')) return [];
    const path = normalizePath(entry.fileName);
    return path ? [{ entry, path }] : [];
  });
  const rootLength = stripCommonRoot(candidates.map(c => c.path));
  const files: ProjectFile[] = []; const secrets: SecretFinding[] = []; const secretFiles: string[] = [];
  let total = 0;
  for (const { entry, path: full } of candidates) {
    const path = full.slice(rootLength);
    const segments = path.split('/');
    const name = segments.at(-1)!;
    if (segments.slice(0, -1).some(s => IGNORED_DIRS.has(s.toLowerCase()))) { skipped.ignoredFolder++; continue; }
    if (isSecretFile(name)) { skipped.secretFile++; secretFiles.push(path); continue; }
    const language = languageFor(path);
    if (!language || IGNORED_FILES.some(p => p.test(name)) || (entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) { skipped.binaryOrOther++; continue; }
    if (entry.uncompressedSize > LIMITS.fileBytes || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > LIMITS.ratio && entry.uncompressedSize > 64 * 1024)) {
      skipped.tooLarge++; continue;
    }
    if (files.length >= LIMITS.files || total + entry.uncompressedSize > LIMITS.totalBytes) { skipped.overLimit++; continue; }
    let data: Buffer | null;
    try { data = await readEntry(zip, entry, LIMITS.fileBytes); } catch { skipped.binaryOrOther++; continue; }
    if (!data) { skipped.tooLarge++; continue; }
    if (data.includes(0)) { skipped.binaryOrOther++; continue; }
    const raw = data.toString('utf8');
    const scanned = scanSecrets(path, raw);
    secrets.push(...scanned.findings);
    total += data.length;
    files.push({ path, language, size: data.length, lines: scanned.text.split('\n').length, text: scanned.text });
  }
  zip.close();
  if (!files.length) throw new ProjectZipError('No source files were found in the zip (dependency and build folders are skipped).');
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skipped, secretFiles: secretFiles.sort(),
    secrets: secrets.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line) };
}
