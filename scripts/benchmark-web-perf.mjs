#!/usr/bin/env node
/**
 * Reproducible frontend performance & bundle benchmark for WuwaTerm-Web.
 *
 * Measures:
 *   1. Production client bundle/chunk sizes (raw & gzip-9) from `dist/client/.vite/manifest.json`.
 *   2. Large-manuscript (50 / 200 / 500 segments) text normalization, segmentation (`pairSegments`),
 *      canonicalization (`canonicalOf` sync vs offloaded `CanonicalComputer`), and controller state updates.
 *   3. Optional (`--browser`) real Chromium metrics against the built app (`dist/`):
 *      quick-mode cold load & JS transfer, manuscript switch/CM6 load, 50/200/500-segment workfile
 *      import render, typing frame latency, and inspector tab switch latency.
 *
 * Usage:
 *   node scripts/benchmark-web-perf.mjs [--root <dir>] [--browser] [--json]
 *   node scripts/benchmark-web-perf.mjs --before <dir> --after <dir> [--browser] [--markdown]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';

const SEGMENT_COUNTS = [50, 200, 500];

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    before: null,
    after: null,
    browser: false,
    json: false,
    markdown: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.root = resolve(argv[++i]);
    else if (arg === '--before') opts.before = resolve(argv[++i]);
    else if (arg === '--after') opts.after = resolve(argv[++i]);
    else if (arg === '--browser') opts.browser = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--markdown') opts.markdown = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function statsOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    samples: sorted.length,
    minMs: round2(sorted[0]),
    medianMs: round2(median),
    meanMs: round2(sum / sorted.length),
    p95Ms: round2(sorted[p95Index]),
    maxMs: round2(sorted[sorted.length - 1]),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function measureSync(fn, { warmup = 2, iterations = 7 } = {}) {
  for (let i = 0; i < warmup; i += 1) fn(i);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  return statsOf(samples);
}

function fileSizes(absPath) {
  const rawBuf = readFileSync(absPath);
  const gzBuf = gzipSync(rawBuf, { level: 9 });
  return {
    rawBytes: rawBuf.byteLength,
    gzipBytes: gzBuf.byteLength,
  };
}

function measureBundle(root) {
  const clientDir = join(root, 'dist', 'client');
  const manifestPath = join(clientDir, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing build manifest at ${manifestPath}. Run "npm run build" in ${root} first.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const findEntry = pred => Object.entries(manifest).find(([, entry]) => pred(entry))?.[1] ?? null;

  const docWorkspace = findEntry(e => e.name === 'document-workspace' || e.src?.endsWith('/document-workspace'));
  const browserEntry = findEntry(e => e.src === 'virtual:vinext-app-browser-entry');
  const clientRefEntry = findEntry(e => e.src === 'virtual:vinext-client-reference-chunks');
  const cm6Editor = findEntry(e => e.name === 'cm6-editor' || e.src === 'app/components/cm6-editor.tsx');

  // Collect static-import closure for initial Quick mode (excluding dynamicImports such as cm6-editor and worker assets).
  const initialFiles = new Set();
  const visitedKeys = new Set();
  function collectStatic(key) {
    if (visitedKeys.has(key)) return;
    visitedKeys.add(key);
    const entry = manifest[key];
    if (!entry) return;
    if (entry.file) initialFiles.add(entry.file);
    for (const imp of entry.imports ?? []) collectStatic(imp);
  }
  for (const [key, entry] of Object.entries(manifest)) {
    if (
      key === 'virtual:vinext-app-browser-entry'
      || key === 'virtual:vinext-app-route-manifest'
      || key === 'virtual:vinext-client-reference-chunks'
      || entry.name === 'document-workspace'
      || entry.name === 'runtime-provider'
      || entry.name === 'site-chrome'
      || entry.name === 'layout-segment-context'
      || entry.name?.startsWith('_virtual_vinext-client-reference-group-')
    ) {
      collectStatic(key);
    }
  }

  let quickInitialRaw = 0;
  let quickInitialGzip = 0;
  for (const rel of initialFiles) {
    const s = fileSizes(join(clientDir, rel));
    quickInitialRaw += s.rawBytes;
    quickInitialGzip += s.gzipBytes;
  }

  const namedChunks = {};
  for (const [, entry] of Object.entries(manifest)) {
    if (!entry.file) continue;
    const label = entry.name ?? entry.file;
    if (
      ['document-workspace', 'cm6-editor', 'index', 'framework', 'vinext', 'messages', 'runtime-provider'].includes(label)
    ) {
      namedChunks[label] = { file: entry.file, ...fileSizes(join(clientDir, entry.file)) };
    }
  }

  const workersDir = join(clientDir, '_next', 'static', 'workers');
  const workerAssets = existsSync(workersDir)
    ? readdirSync(workersDir)
      .filter(f => f.endsWith('.js'))
      .map(f => ({ file: `_next/static/workers/${f}`, ...fileSizes(join(workersDir, f)) }))
    : [];

  const chunksDir = join(clientDir, '_next', 'static', 'chunks');
  let totalChunksRaw = 0;
  let totalChunksGzip = 0;
  const allChunkFiles = readdirSync(chunksDir).filter(f => f.endsWith('.js'));
  for (const f of allChunkFiles) {
    const s = fileSizes(join(chunksDir, f));
    totalChunksRaw += s.rawBytes;
    totalChunksGzip += s.gzipBytes;
  }

  const cssDir = join(clientDir, '_next', 'static', 'css');
  let totalCssRaw = 0;
  let totalCssGzip = 0;
  if (existsSync(cssDir)) {
    for (const f of readdirSync(cssDir).filter(n => n.endsWith('.css'))) {
      const s = fileSizes(join(cssDir, f));
      totalCssRaw += s.rawBytes;
      totalCssGzip += s.gzipBytes;
    }
  }

  return {
    documentWorkspace: docWorkspace ? { file: docWorkspace.file, ...fileSizes(join(clientDir, docWorkspace.file)) } : null,
    browserEntry: browserEntry ? { file: browserEntry.file, ...fileSizes(join(clientDir, browserEntry.file)) } : null,
    clientRefEntry: clientRefEntry ? { file: clientRefEntry.file, ...fileSizes(join(clientDir, clientRefEntry.file)) } : null,
    cm6Editor: cm6Editor ? { file: cm6Editor.file, ...fileSizes(join(clientDir, cm6Editor.file)) } : null,
    workerAssets,
    quickInitialJs: {
      chunkCount: initialFiles.size,
      rawBytes: quickInitialRaw,
      gzipBytes: quickInitialGzip,
    },
    totalJsChunks: {
      chunkCount: allChunkFiles.length,
      rawBytes: totalChunksRaw,
      gzipBytes: totalChunksGzip,
    },
    totalCss: {
      rawBytes: totalCssRaw,
      gzipBytes: totalCssGzip,
    },
    namedChunks,
  };
}

function buildManuscriptFixture(segmentCount) {
  const srcParas = [];
  const tgtParas = [];
  for (let i = 0; i < segmentCount; i += 1) {
    srcParas.push(
      `第${i + 1}段：今汐在乘霄山巡查共鸣异常，确认声骸共鸣频率稳定在 ${1200 + i}.5 Hz。`
      + `漂泊者随后核对了今州城档案馆记录的第 ${i + 1} 份加密文本与术语对照表，确保译名与官方定名完全一致。`,
    );
    tgtParas.push(
      `Paragraph ${i + 1}: Jinhsi inspected the Resonance anomaly at Mt. Firmament and confirmed the Echo frequency stabilized at ${1200 + i}.5 Hz. `
      + `Rover then verified encrypted record #${i + 1} from the Jinzhou Archive against the official glossary so every term stays consistent.`,
    );
  }
  // Use CRLF separators so normalization and coordinate preservation paths are exercised identically.
  const source = srcParas.join('\r\n\r\n');
  const target = tgtParas.join('\r\n\r\n');
  return {
    segmentCount,
    source,
    target,
    sourceChars: Array.from(source).length,
    targetChars: Array.from(target).length,
  };
}

function createNodeWorkerFactory(root) {
  const storeUrl = existsSync(join(root, 'lib', 'workbench-store.ts'))
    ? pathToFileURL(join(root, 'lib', 'workbench-store.ts')).href
    : pathToFileURL(join(root, 'lib', 'workbench-controller.ts')).href;
  const workerScript = `
    import { parentPort } from 'node:worker_threads';
    import { canonicalOf } from ${JSON.stringify(storeUrl)};
    parentPort.on('message', (payload) => {
      const canonical = canonicalOf(payload.draft, payload.choices, payload.reports, payload.semantic, payload.basis);
      parentPort.postMessage({ id: payload.id, canonical });
    });
  `;
  return () => {
    const nw = new NodeWorker(workerScript, { eval: true });
    const listeners = new Map();
    nw.on('message', data => {
      for (const fn of listeners.get('message') ?? []) fn({ data });
    });
    nw.on('error', err => {
      for (const fn of listeners.get('error') ?? []) fn(err);
    });
    return {
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      postMessage(payload) { nw.postMessage(payload); },
      terminate() { return nw.terminate(); },
    };
  };
}

async function measureComputeAndController(root) {
  const segMod = await import(pathToFileURL(join(root, 'lib', 'segmentation.ts')).href);
  const ctrlMod = await import(pathToFileURL(join(root, 'lib', 'workbench-controller.ts')).href);
  const semMod = await import(pathToFileURL(join(root, 'lib', 'semantic-state.js')).href);
  const msMod = await import(pathToFileURL(join(root, 'lib', 'manuscript.js')).href);

  const coordsPath = join(root, 'lib', 'editor-coords.ts');
  const coordsMod = existsSync(coordsPath) ? await import(pathToFileURL(coordsPath).href) : null;

  const workerClientPath = join(root, 'lib', 'canonical-worker-client.ts');
  const workerClientMod = existsSync(workerClientPath) ? await import(pathToFileURL(workerClientPath).href) : null;

  const results = {};

  for (const count of SEGMENT_COUNTS) {
    const fx = buildManuscriptFixture(count);
    const draft = { source: fx.source, target: fx.target, direction: 'en', alignments: null };
    const semantic = semMod.freshSemantic ? semMod.freshSemantic(draft) : semMod.emptySemantic();
    const canonicalInput = { draft, choices: [], reports: [], semantic, basis: null };

    // 1. Text normalization & incremental edit coordinate conversion
    const normalizeStats = measureSync(() => {
      if (coordsMod) coordsMod.normalizeLineBreaks(fx.source);
      else fx.source.replace(/\r\n?/g, '\n');
    }, { warmup: 2, iterations: 15 });

    const domSource = coordsMod ? coordsMod.normalizeLineBreaks(fx.source) : fx.source.replace(/\r\n?/g, '\n');
    const midDomOffset = Math.floor(domSource.length / 2);
    const incrementalEditStats = measureSync(i => {
      if (coordsMod) {
        coordsMod.applyDomChangesToRaw(fx.source, [{ fromA: midDomOffset, toA: midDomOffset, inserted: String(i % 10) }]);
      } else {
        // Baseline textarea normalized the full string on every input event.
        (domSource.slice(0, midDomOffset) + String(i % 10) + domSource.slice(midDomOffset)).replace(/\r\n?/g, '\n');
      }
    }, { warmup: 2, iterations: 15 });

    // 2. Segmentation (`pairSegments`)
    const segmentationStats = measureSync(() => {
      segMod.pairSegments(fx.source, fx.target);
    }, { warmup: 2, iterations: 9 });

    // 3. Canonical serialization: synchronous main-thread vs Worker offload (when available)
    const canonicalSyncStats = measureSync(() => {
      ctrlMod.canonicalOf(draft, [], [], semantic, null);
    }, { warmup: 2, iterations: 9 });

    let canonicalOffloadDispatchStats = null;
    let canonicalOffloadEndToEndStats = null;
    if (workerClientMod) {
      const computer = workerClientMod.createCanonicalComputer({
        workerFactory: createNodeWorkerFactory(root),
      });
      // Warm up worker thread once before timing.
      await computer.compute(canonicalInput);

      const dispatchSamples = [];
      const e2eSamples = [];
      for (let i = 0; i < 7; i += 1) {
        const mutatedDraft = { ...draft, target: `${fx.target}\r\n\r\nEdit ${i}` };
        const mutatedInput = { ...canonicalInput, draft: mutatedDraft };
        const t0 = performance.now();
        const promise = computer.compute(mutatedInput);
        dispatchSamples.push(performance.now() - t0);
        await promise;
        e2eSamples.push(performance.now() - t0);
      }
      canonicalOffloadDispatchStats = statsOf(dispatchSamples);
      canonicalOffloadEndToEndStats = statsOf(e2eSamples);
      computer.dispose();
    }

    // 4. Controller state update: 20 sequential incremental edits (with baseline's sync canonicalOf vs current decoupled kernel)
    const workfileJson = msMod.serializeWorkfile({
      source: fx.source,
      target: fx.target,
      direction: 'en',
      alignments: null,
      choices: [],
      history: [],
    });

    const controllerEditBurstStats = measureSync(() => {
      const doc = ctrlMod.createWorkbenchController({
        onPoolRefresh: () => {},
        fetchCapabilities: async () => [],
      });
      doc.replaceWithWorkfile({ draft, choices: [], reports: [], semantic, importedBody: null });
      for (let k = 0; k < 20; k += 1) {
        const nextTarget = `${fx.target} [${k}]`;
        doc.editText('target', nextTarget);
        if (!workerClientMod) {
          // df0a4d0 ran canonicalOf synchronously on the main thread inside DocumentWorkspace useMemo on every edit.
          const snap = doc.getSnapshot();
          ctrlMod.canonicalOf(snap.draft, snap.choices, snap.reports, snap.semantic, snap.basis);
        }
      }
      doc.dispose();
    }, { warmup: 1, iterations: 5 });

    results[String(count)] = {
      segmentCount: count,
      sourceChars: fx.sourceChars,
      targetChars: fx.targetChars,
      workfileBytes: Buffer.byteLength(workfileJson, 'utf8'),
      normalizeLineBreaks: normalizeStats,
      incrementalEditNormalize: incrementalEditStats,
      pairSegments: segmentationStats,
      canonicalOfSync: canonicalSyncStats,
      canonicalWorkerDispatch: canonicalOffloadDispatchStats,
      canonicalWorkerEndToEnd: canonicalOffloadEndToEndStats,
      controller20EditBurst: controllerEditBurstStats,
    };
  }

  return {
    hasEditorCoords: !!coordsMod,
    hasCanonicalWorker: !!workerClientMod,
    bySegments: results,
  };
}

async function measureBrowser(root) {
  const { chromium } = await import(pathToFileURL(join(root, 'node_modules', '@playwright/test', 'index.mjs')).href);
  const { bootBuilt } = await import(pathToFileURL(join(root, 'tests', 'helpers', 'built-harness.mjs')).href);
  const msMod = await import(pathToFileURL(join(root, 'lib', 'manuscript.js')).href);

  // bootBuilt resolves dist/ relative to its own file path (`root` inside built-harness.mjs).
  const runtime = await bootBuilt();
  const browser = await chromium.launch({ headless: true });

  const POOL = {
    status: 'available',
    translation_enabled: true,
    terms: { used: 0, limit: 100, remaining: 100 },
    translations: { used: 0, limit: 100, remaining: 100 },
    characters: { used: 0, limit: 10000, remaining: 10000 },
    reviews: { used: 0, limit: 60, remaining: 60 },
    reset_at: '2099-01-01T00:00:00Z',
  };

  async function installSyntheticRoutes(page) {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/capabilities') {
        return route.fulfill({ json: { capabilities: ['translation-context-v1', 'semantic-review-v1', 'structure-check-v1'], request_id: 'bench-cap' } });
      }
      if (path === '/api/pool') return route.fulfill({ json: POOL });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'bench' } } });
    });
  }

  try {
    // 1. Cold load in Quick mode + JS network transfer audit
    const quickCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const quickPage = await quickCtx.newPage();
    const jsRequests = [];
    const workerRequests = [];
    quickPage.on('response', async res => {
      const url = res.url();
      const ct = res.headers()['content-type'] ?? '';
      if (url.includes('/_next/static/workers/') || url.includes('worker')) {
        workerRequests.push(url);
      }
      if (url.endsWith('.js') || ct.includes('javascript')) {
        let len = Number(res.headers()['content-length'] ?? 0);
        if (!len) {
          try { len = (await res.body()).byteLength; } catch { len = 0; }
        }
        jsRequests.push({ url: new URL(url).pathname, bytes: len });
      }
    });
    await installSyntheticRoutes(quickPage);
    const navT0 = performance.now();
    await quickPage.goto(runtime.url.href, { waitUntil: 'load' });
    await quickPage.locator('#review-source').waitFor({ state: 'visible' });
    const quickReadyMs = round2(performance.now() - navT0);
    const navTiming = await quickPage.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return nav ? {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd * 100) / 100,
        loadMs: Math.round(nav.loadEventEnd * 100) / 100,
      } : null;
    });
    const quickJsBytes = jsRequests.reduce((acc, r) => acc + r.bytes, 0);

    // Measure switching from Quick -> Manuscript (loads lazy CM6 chunk in current branch, instant textarea in baseline)
    const switchT0 = performance.now();
    await quickPage.locator('.mode-switch button').nth(1).click();
    await quickPage.locator('.document-workspace[data-mode="manuscript"]').waitFor({ state: 'visible' });
    // Wait for CM6 if enhanced editor is present
    const hasCm6 = await quickPage.evaluate(() => {
      return new Promise(resolve => {
        const deadline = performance.now() + 10_000;
        const tick = () => {
          const el = document.querySelector('#review-source');
          if (el?.getAttribute('data-editor-surface') === 'cm6') return resolve(true);
          if (el?.tagName === 'TEXTAREA') {
            // Give React 100ms in case CM6 lazy-load triggers after mode attribute flips
            if (performance.now() - deadline + 10_000 > 150) return resolve(false);
          }
          if (performance.now() > deadline) return resolve(false);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });
    const manuscriptSwitchMs = round2(performance.now() - switchT0);
    const postSwitchJsBytes = jsRequests.reduce((acc, r) => acc + r.bytes, 0);
    await quickCtx.close();

    // 2. Large manuscript import + incremental typing frame latency (50 / 200 / 500 segments)
    const perSegmentBrowser = {};
    for (const count of SEGMENT_COUNTS) {
      const fx = buildManuscriptFixture(count);
      const workfileJson = msMod.serializeWorkfile({
        source: fx.source,
        target: fx.target,
        direction: 'en',
        alignments: null,
        choices: [],
        history: [],
      });

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await installSyntheticRoutes(page);
      await page.goto(runtime.url.href, { waitUntil: 'load' });
      await page.locator('#review-source').waitFor({ state: 'visible' });

      const importT0 = performance.now();
      await page.locator('.manuscript-editor-pane input[type="file"]').setInputFiles({
        name: `bench-${count}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(workfileJson, 'utf8'),
      });
      await page.locator('.document-workspace[data-mode="manuscript"]').waitFor({ state: 'visible' });
      if (hasCm6) {
        await page.locator('#review-source[data-editor-surface="cm6"]').waitFor({ state: 'visible', timeout: 15_000 });
      }
      // Wait for rendered frame after import
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const importMountMs = round2(performance.now() - importT0);

      // Measure 5 incremental edits -> next animation frame commit latency
      const typingLatencies = [];
      for (let step = 0; step < 5; step += 1) {
        const ms = await page.evaluate(async idx => {
          const el = document.querySelector('#review-source');
          const t0 = performance.now();
          if (el.tagName === 'TEXTAREA') {
            const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            proto.set.call(el, `${el.value} ${idx}`);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            const view = el.__cm6View ?? el.cmView?.view;
            if (!view) throw new Error('CM6 EditorView missing');
            const end = view.state.doc.length;
            view.dispatch({ changes: { from: end, to: end, insert: ` ${idx}` } });
          }
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return performance.now() - t0;
        }, step);
        typingLatencies.push(ms);
      }

      // Measure inspector tab switch latency (if unified inspector tabs exist)
      const hasTabs = (await page.locator('[data-inspector-tab="terms"]').count()) > 0;
      let tabSwitchMs = null;
      if (hasTabs) {
        const tabT0 = performance.now();
        await page.locator('[data-inspector-tab="terms"]').click();
        await page.locator('#inspector-panel-terms').waitFor({ state: 'visible' });
        await page.locator('[data-inspector-tab="memory"]').click();
        await page.locator('#inspector-panel-memory').waitFor({ state: 'visible' });
        await page.locator('[data-inspector-tab="review"]').click();
        await page.locator('#inspector-panel-review').waitFor({ state: 'visible' });
        tabSwitchMs = round2(performance.now() - tabT0);
      }

      perSegmentBrowser[String(count)] = {
        importMountMs,
        typingFrameLatency: statsOf(typingLatencies),
        inspectorTabRoundTripMs: tabSwitchMs,
      };
      await ctx.close();
    }

    return {
      hasCm6,
      quickMode: {
        readyMs: quickReadyMs,
        navTiming,
        jsRequests: jsRequests.length,
        jsBytesTransferred: quickJsBytes,
        workerRequestsInQuickMode: workerRequests.length,
      },
      manuscriptSwitch: {
        switchAndMountMs: manuscriptSwitchMs,
        totalJsBytesAfterSwitch: postSwitchJsBytes,
        lazyJsDeltaBytes: Math.max(0, postSwitchJsBytes - quickJsBytes),
      },
      bySegments: perSegmentBrowser,
    };
  } finally {
    await browser.close();
    await runtime.close();
  }
}

async function runSingle(root, { withBrowser }) {
  let gitHead = null;
  try {
    gitHead = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8').trim();
  } catch {
    gitHead = null;
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const docWorkspacePath = join(root, 'app', 'components', 'document-workspace.tsx');
  const docWorkspaceStat = statSync(docWorkspacePath);
  const docWorkspaceLines = readFileSync(docWorkspacePath, 'utf8').split('\n').length - 1;

  const bundle = measureBundle(root);
  const compute = await measureComputeAndController(root);
  const browser = withBrowser ? await measureBrowser(root) : null;

  return {
    root,
    gitHead,
    version: pkg.version,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCores: cpus().length,
      memoryGiB: round2(totalmem() / (1024 ** 3)),
    },
    sourceMetrics: {
      documentWorkspaceLines: docWorkspaceLines,
      documentWorkspaceBytes: docWorkspaceStat.size,
    },
    bundle,
    compute,
    browser,
  };
}

function runChildBenchmark(root, withBrowser) {
  return new Promise((resolvePromise, rejectPromise) => {
    const scriptSelf = resolve(process.argv[1]);
    const args = [scriptSelf, '--root', root, '--json'];
    if (withBrowser) args.push('--browser');
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      if (code !== 0) {
        rejectPromise(new Error(`Benchmark child failed in ${root} (exit ${code}):\n${stderr || stdout}`));
        return;
      }
      const marker = '__BENCH_JSON__\n';
      const idx = stdout.indexOf(marker);
      const jsonText = idx >= 0 ? stdout.slice(idx + marker.length) : stdout.slice(stdout.indexOf('{'));
      try {
        resolvePromise(JSON.parse(jsonText));
      } catch (err) {
        rejectPromise(new Error(`Failed to parse benchmark JSON from ${root}: ${err.message}\n${stdout}`));
      }
    });
  });
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'N/A';
  return `${bytes.toLocaleString('en-US')} B (${round2(bytes / 1024)} KiB)`;
}

function fmtDelta(beforeVal, afterVal, unit = 'ms') {
  if (beforeVal === null || beforeVal === undefined || afterVal === null || afterVal === undefined) return 'N/A';
  const diff = round2(afterVal - beforeVal);
  const pct = beforeVal === 0 ? '0.0%' : `${diff >= 0 ? '+' : ''}${((diff / beforeVal) * 100).toFixed(1)}%`;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${diff} ${unit} (${pct})`;
}

function formatComparisonMarkdown(before, after) {
  const lines = [];
  lines.push(`# Benchmark Comparison: ${before.gitHead ?? 'before'} vs ${after.gitHead ?? 'after'}`);
  lines.push('');
  lines.push(`- Node: \`${after.environment.node}\` | CPU: ${after.environment.cpuModel} (${after.environment.cpuCores} cores) | RAM: ${after.environment.memoryGiB} GiB`);
  lines.push('');
  lines.push('## 1. Source & Bundle Chunk Metrics');
  lines.push('');
  lines.push('| Metric | Before (`df0a4d0`) | After (Current) | Delta |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(`| \`document-workspace.tsx\` lines | ${before.sourceMetrics.documentWorkspaceLines} | ${after.sourceMetrics.documentWorkspaceLines} | ${fmtDelta(before.sourceMetrics.documentWorkspaceLines, after.sourceMetrics.documentWorkspaceLines, 'lines')} |`);
  lines.push(`| \`document-workspace.tsx\` bytes | ${fmtBytes(before.sourceMetrics.documentWorkspaceBytes)} | ${fmtBytes(after.sourceMetrics.documentWorkspaceBytes)} | ${fmtDelta(before.sourceMetrics.documentWorkspaceBytes, after.sourceMetrics.documentWorkspaceBytes, 'B')} |`);
  lines.push(`| \`document-workspace\` chunk (raw) | ${fmtBytes(before.bundle.documentWorkspace?.rawBytes)} | ${fmtBytes(after.bundle.documentWorkspace?.rawBytes)} | ${fmtDelta(before.bundle.documentWorkspace?.rawBytes, after.bundle.documentWorkspace?.rawBytes, 'B')} |`);
  lines.push(`| \`document-workspace\` chunk (gzip-9) | ${fmtBytes(before.bundle.documentWorkspace?.gzipBytes)} | ${fmtBytes(after.bundle.documentWorkspace?.gzipBytes)} | ${fmtDelta(before.bundle.documentWorkspace?.gzipBytes, after.bundle.documentWorkspace?.gzipBytes, 'B')} |`);
  lines.push(`| \`index\` browser entry (raw / gzip-9) | ${fmtBytes(before.bundle.browserEntry?.rawBytes)} / ${fmtBytes(before.bundle.browserEntry?.gzipBytes)} | ${fmtBytes(after.bundle.browserEntry?.rawBytes)} / ${fmtBytes(after.bundle.browserEntry?.gzipBytes)} | ${fmtDelta(before.bundle.browserEntry?.gzipBytes, after.bundle.browserEntry?.gzipBytes, 'B gzip')} |`);
  lines.push(`| \`framework\` chunk (raw / gzip-9) | ${fmtBytes(before.bundle.namedChunks.framework?.rawBytes)} / ${fmtBytes(before.bundle.namedChunks.framework?.gzipBytes)} | ${fmtBytes(after.bundle.namedChunks.framework?.rawBytes)} / ${fmtBytes(after.bundle.namedChunks.framework?.gzipBytes)} | ${fmtDelta(before.bundle.namedChunks.framework?.gzipBytes, after.bundle.namedChunks.framework?.gzipBytes, 'B gzip')} |`);
  lines.push(`| Quick-mode initial JS closure (raw / gzip-9) | ${fmtBytes(before.bundle.quickInitialJs.rawBytes)} / ${fmtBytes(before.bundle.quickInitialJs.gzipBytes)} | ${fmtBytes(after.bundle.quickInitialJs.rawBytes)} / ${fmtBytes(after.bundle.quickInitialJs.gzipBytes)} | ${fmtDelta(before.bundle.quickInitialJs.gzipBytes, after.bundle.quickInitialJs.gzipBytes, 'B gzip')} |`);
  lines.push(`| Lazy \`cm6-editor\` chunk (raw / gzip-9) | N/A | ${fmtBytes(after.bundle.cm6Editor?.rawBytes)} / ${fmtBytes(after.bundle.cm6Editor?.gzipBytes)} | lazy-only |`);
  const afterWorker = after.bundle.workerAssets[0];
  lines.push(`| Lazy \`canonical.worker\` asset (raw / gzip-9) | N/A | ${fmtBytes(afterWorker?.rawBytes)} / ${fmtBytes(afterWorker?.gzipBytes)} | worker-only |`);
  lines.push(`| All client JS chunks total (raw / gzip-9) | ${fmtBytes(before.bundle.totalJsChunks.rawBytes)} / ${fmtBytes(before.bundle.totalJsChunks.gzipBytes)} | ${fmtBytes(after.bundle.totalJsChunks.rawBytes)} / ${fmtBytes(after.bundle.totalJsChunks.gzipBytes)} | ${fmtDelta(before.bundle.totalJsChunks.gzipBytes, after.bundle.totalJsChunks.gzipBytes, 'B gzip')} |`);
  lines.push('');
  lines.push('## 2. Large Manuscript Compute & Controller Burst (50 / 200 / 500 Segments)');
  lines.push('');
  lines.push('| Segments | Operation | Before Median (ms) | After Median (ms) | Delta |');
  lines.push('| ---: | --- | ---: | ---: | ---: |');
  for (const seg of SEGMENT_COUNTS) {
    const b = before.compute.bySegments[String(seg)];
    const a = after.compute.bySegments[String(seg)];
    lines.push(`| ${seg} | \`normalizeLineBreaks\` | ${b.normalizeLineBreaks.medianMs} | ${a.normalizeLineBreaks.medianMs} | ${fmtDelta(b.normalizeLineBreaks.medianMs, a.normalizeLineBreaks.medianMs)} |`);
    lines.push(`| ${seg} | Incremental edit coord/normalize | ${b.incrementalEditNormalize.medianMs} | ${a.incrementalEditNormalize.medianMs} | ${fmtDelta(b.incrementalEditNormalize.medianMs, a.incrementalEditNormalize.medianMs)} |`);
    lines.push(`| ${seg} | \`pairSegments\` | ${b.pairSegments.medianMs} | ${a.pairSegments.medianMs} | ${fmtDelta(b.pairSegments.medianMs, a.pairSegments.medianMs)} |`);
    lines.push(`| ${seg} | \`canonicalOf\` main-thread sync vs Worker dispatch | ${b.canonicalOfSync.medianMs} | ${a.canonicalWorkerDispatch?.medianMs ?? a.canonicalOfSync.medianMs} (e2e ${a.canonicalWorkerEndToEnd?.medianMs ?? 'N/A'}) | ${fmtDelta(b.canonicalOfSync.medianMs, a.canonicalWorkerDispatch?.medianMs ?? a.canonicalOfSync.medianMs)} |`);
    lines.push(`| ${seg} | Controller 20-edit burst (incl. main-thread canonical if sync) | ${b.controller20EditBurst.medianMs} | ${a.controller20EditBurst.medianMs} | ${fmtDelta(b.controller20EditBurst.medianMs, a.controller20EditBurst.medianMs)} |`);
  }

  if (before.browser && after.browser) {
    lines.push('');
    lines.push('## 3. Real Chromium Browser Metrics (`dist/` via Wrangler Harness)');
    lines.push('');
    lines.push('| Metric | Before (`df0a4d0`) | After (Current) | Delta |');
    lines.push('| --- | ---: | ---: | ---: |');
    lines.push(`| Quick mode JS transferred | ${fmtBytes(before.browser.quickMode.jsBytesTransferred)} (${before.browser.quickMode.jsRequests} reqs) | ${fmtBytes(after.browser.quickMode.jsBytesTransferred)} (${after.browser.quickMode.jsRequests} reqs) | ${fmtDelta(before.browser.quickMode.jsBytesTransferred, after.browser.quickMode.jsBytesTransferred, 'B')} |`);
    lines.push(`| Worker requests in Quick mode | ${before.browser.quickMode.workerRequestsInQuickMode} | ${after.browser.quickMode.workerRequestsInQuickMode} | — |`);
    lines.push(`| Mode switch -> manuscript ready | ${before.browser.manuscriptSwitch.switchAndMountMs} ms | ${after.browser.manuscriptSwitch.switchAndMountMs} ms | ${fmtDelta(before.browser.manuscriptSwitch.switchAndMountMs, after.browser.manuscriptSwitch.switchAndMountMs)} |`);
    for (const seg of SEGMENT_COUNTS) {
      const b = before.browser.bySegments[String(seg)];
      const a = after.browser.bySegments[String(seg)];
      lines.push(`| ${seg} seg import & mount | ${b.importMountMs} ms | ${a.importMountMs} ms | ${fmtDelta(b.importMountMs, a.importMountMs)} |`);
      lines.push(`| ${seg} seg typing frame latency (median) | ${b.typingFrameLatency.medianMs} ms | ${a.typingFrameLatency.medianMs} ms | ${fmtDelta(b.typingFrameLatency.medianMs, a.typingFrameLatency.medianMs)} |`);
    }
  }
  return lines.join('\n');
}

const opts = parseArgs(process.argv.slice(2));

if (opts.before && opts.after) {
  const before = await runChildBenchmark(opts.before, opts.browser);
  const after = await runChildBenchmark(opts.after, opts.browser);
  if (opts.json) {
    console.log(JSON.stringify({ before, after }, null, 2));
  } else {
    console.log(formatComparisonMarkdown(before, after));
  }
} else {
  const report = await runSingle(opts.root, { withBrowser: opts.browser });
  if (opts.json) process.stdout.write('__BENCH_JSON__\n');
  console.log(JSON.stringify(report, null, 2));
}
