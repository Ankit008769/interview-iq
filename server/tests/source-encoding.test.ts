import { expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Text saved in a Windows code page shows up as � in the browser and in rendered docs.
const root = fileURLToPath(new URL('../../', import.meta.url));
const skip = new Set(['node_modules', 'dist', '.git', '.terraform', 'test-results', 'playwright-report', 'ratings', 'output']);
const text = /\.(ts|tsx|css|html|md|json|jsonl|mjs|cjs|yml|yaml|tf|example)$/;
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path); else if (text.test(name)) yield path;
  }
}

it('keeps every source and documentation file valid UTF-8', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const invalid = [...files(root)].filter(path => { try { decoder.decode(readFileSync(path)); return false; } catch { return true; } });
  expect(invalid.map(path => path.slice(root.length))).toEqual([]);
});
