#!/usr/bin/env node
// Drive the benchmark in a REAL browser — the only runtime in which the
// shipped WebGPU engine exists, and the runtime the app actually ships to.
//
//   node tests/bench/run-browser.mjs                       # ts,wasm,gpu @320²
//   BENCH_BACKENDS=gpu BENCH_SIZES=320,2048 node tests/bench/run-browser.mjs
//
// Requirements (none of them are npm dependencies of the app, so this script
// stays optional):
//   * Chrome or Chromium on PATH, or CHROME_PATH=/path/to/chrome
//   * a Playwright package resolvable from here (`npm i -D playwright-core`),
//     or PLAYWRIGHT_MODULE=<path or specifier> pointing at one
//   * on a headless Linux box, run the whole command under `xvfb-run -a`
//
// WebGPU notes that cost real time if you skip them:
//   * WebGPU needs a SECURE CONTEXT, so the page is served over
//     http://127.0.0.1 rather than from a file:// URL.
//   * A software adapter (SwiftShader/llvmpipe) will happily produce numbers.
//     They are worthless. This script REFUSES to report GPU results from one;
//     the fix on Linux is a Vulkan-capable Chrome (chrome://flags#enable-vulkan).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');

const CHROME_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist',
  '--no-first-run',
  '--no-default-browser-check',
];

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_MODULE || 'playwright-core';
  try {
    return await import(spec);
  } catch {
    try {
      return await import('playwright');
    } catch {
      throw new Error(
        'No Playwright package found. Install one (`npm i -D playwright-core`) or set ' +
        'PLAYWRIGHT_MODULE to a resolvable specifier/path.',
      );
    }
  }
}

function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined; // let Playwright use its own download, if it has one
}

/** Serve the bundle from 127.0.0.1 so the page is a secure context. */
function serve(bundleJs) {
  const page = `<!doctype html><meta charset="utf-8"><title>MemeLab bench</title>
<body><pre id="log">running…</pre><script src="/bench.js"></script></body>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/bench.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(bundleJs);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// `root` lets the ladder point this at a worktree of an older commit, where
// only the graftable TS entry exists. `entry` picks which of the two browser
// entries to build.
export async function runBrowserBench(req = {}, { outDir, root, entry } = {}) {
  const out = outDir ?? process.env.BENCH_OUT ?? path.join(appRoot, 'bench-out');
  fs.mkdirSync(out, { recursive: true });
  const bundlePath = path.join(out, 'bench-browser.bundle.js');
  await bundle({
    entry: entry ?? process.env.BENCH_BROWSER_ENTRY ?? 'tests/bench/browser-entry.ts',
    outfile: bundlePath,
    platform: 'browser',
    cwd: root ?? process.env.BENCH_ROOT ?? appRoot,
  });

  const { chromium } = await loadPlaywright();
  const server = await serve(fs.readFileSync(bundlePath, 'utf8'));
  const { port } = server.address();

  const launch = { headless: false, args: CHROME_ARGS };
  const exe = chromeExecutable();
  if (exe) launch.executablePath = exe;

  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage();
    // A 2048² GPU sweep is minutes of work; the default 30 s cap would abort it.
    page.setDefaultTimeout(60 * 60_000);
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof window.memelabBench === 'function', null, { timeout: 30_000 });
    const report = await page.evaluate((r) => window.memelabBench(r), req);
    report.consoleLines = consoleLines;
    return report;
  } finally {
    await browser.close();
    server.close();
  }
}

export function formatBrowserReport(report) {
  const lines = [];
  const a = report.adapter;
  lines.push(`adapter: ${a ? `${a.vendor} / ${a.architecture} / ${a.device} / ${a.description}` : 'none'}`);
  lines.push(`software adapter: ${report.softwareAdapter ? 'YES — GPU numbers refused' : 'no'}`);
  lines.push('');
  for (const r of report.results) {
    lines.push(
      `${r.backend.padEnd(5)} ${String(r.size).padStart(4)}²  ${r.geometry.padEnd(10)} ` +
      `${r.ticksPerSec.toFixed(1).padStart(9)} t/s  ${r.msPerTick.toFixed(4).padStart(8)} ms/tick  best of ${r.reps}  ` +
      `| S=${r.census.s} E=${r.census.e} I=${r.census.i} R=${r.census.r} D=${r.census.d} ` +
      `N=${r.census.s + r.census.e + r.census.i + r.census.r + r.census.d}` +
      `${r.censusStable ? '' : '  ** CENSUS DRIFT **'}`,
    );
  }
  for (const s of report.splits ?? []) {
    if (!s.split) continue;
    const f = (v) => `${(v * 100).toFixed(1).padStart(5)}%`;
    lines.push(
      `split ${String(s.size).padStart(4)}²  ${s.geometry.padEnd(10)} trans ${f(s.split.transmission)}  ` +
      `quar ${f(s.split.quarantine)}  life ${f(s.split.lifecycle)}  stats ${f(s.split.stats)}  other ${f(s.split.other)}`,
    );
  }
  for (const e of report.errors ?? []) lines.push(`ERROR ${e}`);
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const list = (k, d) => (process.env[k] ? process.env[k].split(',').map((s) => s.trim()) : d);
  const req = {
    backends: list('BENCH_BACKENDS', ['ts', 'wasm', 'gpu']),
    geometries: list('BENCH_GEOMETRIES', undefined),
    sizes: (process.env.BENCH_SIZES || '320').split(',').map((s) => parseInt(s, 10)),
    reps: parseInt(process.env.BENCH_REPS || '3', 10),
    label: process.env.BENCH_LABEL || 'HEAD',
    split: process.env.BENCH_SPLIT === '1',
  };
  const report = await runBrowserBench(req);
  const text = formatBrowserReport(report);
  console.log(text);
  const out = process.env.BENCH_OUT ?? path.join(appRoot, 'bench-out');
  const file = path.join(out, 'raw-browser.txt');
  fs.writeFileSync(file, [
    '# MemeLab browser benchmark',
    '# harness: MemeLab tests/bench (protocol shared via tests/bench/protocol.ts)',
    `# runtime: Chrome, ${process.env.BENCH_BUNDLER || 'vite'} IIFE bundle served over http://127.0.0.1 (secure context, required for WebGPU)`,
    `# stage:   ${req.label}`,
    `# date:    ${new Date().toISOString()}`,
    '', text, '',
    `##BENCH_JSON## ${JSON.stringify(report)}`,
  ].join('\n'));
  console.log(`\nraw log: ${file}`);
}
