import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { scalarToUtf16 } from '../lib/review-report.js';
import { scalarOffset } from '../lib/workbench-model.ts';

const ROOT = process.cwd();
const WORKER_JS_MODULES = [
  'lib/manuscript.js',
  'lib/review-report.js',
  'lib/semantic-review.js',
  'lib/wuwaterm-proxy.js',
  'lib/shared-pool.js',
];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

test('Miniflare and Windows raw ESModule .js files contain no runtime .ts imports', () => {
  for (const relPath of WORKER_JS_MODULES) {
    const code = stripComments(readFileSync(join(ROOT, relPath), 'utf8'));
    assert.doesNotMatch(
      code,
      /\bfrom\s+['"][^'"]+\.ts['"]|\bimport\s*\(\s*['"][^'"]+\.ts['"]\s*\)/u,
      `${relPath} must not import .ts at runtime`,
    );
  }
});

test('scalarToUtf16 converts surrogate-pair scalar offsets and compiler rejects coordinate mixups', () => {
  const sample = 'A\u{20000}B';
  assert.deepEqual([0, 1, 2, 3].map(n => scalarToUtf16(sample, scalarOffset(n))), [0, 1, 3, 4]);

  const configPath = join(ROOT, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, p => readFileSync(p, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT);
  const options = { ...parsed.options, incremental: false };
  const probeFile = join(ROOT, 'lib', '__coordinate_probe__.ts');
  const probeSource = [
    "import { scalarToUtf16 } from './review-report.js';",
    "import { scalarOffset, utf16Offset, type ScalarOffset, type Utf16Offset } from './workbench-model.ts';",
    "const s: ScalarOffset = scalarOffset(1);",
    "const u: Utf16Offset = utf16Offset(2);",
    "export const ok: Utf16Offset | null = scalarToUtf16('A\\u{20000}B', s);",
    "export const badAssign: ScalarOffset = u;",
    "export const badCall = scalarToUtf16('A\\u{20000}B', u);",
  ].join('\n');

  const host = ts.createCompilerHost(options);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = fileName => fileName === probeFile || ts.sys.fileExists(fileName);
  host.readFile = fileName => (fileName === probeFile ? probeSource : ts.sys.readFile(fileName));
  host.getSourceFile = (fileName, lang, onError, shouldCreate) => (
    fileName === probeFile
      ? ts.createSourceFile(fileName, probeSource, lang)
      : origGetSourceFile(fileName, lang, onError, shouldCreate)
  );

  const program = ts.createProgram([probeFile], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(probeFile));
  assert.equal(diagnostics.length, 2, 'expected two coordinate-mismatch diagnostics');
  assert.deepEqual(diagnostics.map(d => d.code), [2322, 2345]);
});
