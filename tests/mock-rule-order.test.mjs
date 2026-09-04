import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const tempDir = resolve(root, '.tmp-tests');
const bundledFile = resolve(tempDir, 'mockUtils.mjs');

await mkdir(tempDir, { recursive: true });

try {
  await build({
    entryPoints: [resolve(root, 'mockUtils.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundledFile,
    logLevel: 'silent',
  });

  const { reorderMockRules } = await import(pathToFileURL(bundledFile).href);
  const rules = [
    { id: 'first', name: 'First', hitCount: 3 },
    { id: 'second', name: 'Second', hitCount: 7 },
    { id: 'third', name: 'Third', hitCount: 11 },
  ];

  assert.deepEqual(
    reorderMockRules(rules, 'third', 'first').map(rule => rule.id),
    ['third', 'first', 'second'],
    'moving a rule onto another rule places it before that target',
  );

  assert.deepEqual(
    reorderMockRules(rules, 'first', 'second').map(rule => rule.id),
    ['second', 'first', 'third'],
    'moving a rule onto the next row places it below that target',
  );

  assert.deepEqual(
    reorderMockRules(rules, 'first', 'third').map(rule => rule.id),
    ['second', 'third', 'first'],
    'moving a rule downward places it below the target',
  );

  const reordered = reorderMockRules(rules, 'second', 'first');
  assert.equal(reordered[0], rules[1], 'reordering preserves the original rule objects and metadata');
  assert.deepEqual(reorderMockRules(rules, 'missing', 'first'), rules, 'unknown source IDs leave order unchanged');
  assert.deepEqual(reorderMockRules(rules, 'first', 'missing'), rules, 'unknown target IDs leave order unchanged');
  assert.deepEqual(reorderMockRules(rules, 'first', 'first'), rules, 'dropping a rule onto itself leaves order unchanged');

  console.log('Mock rule ordering tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
