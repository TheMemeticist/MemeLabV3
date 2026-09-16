#!/usr/bin/env node
// The historical ladder: the SAME harness, run against each stage of the
// engine's history, on plain Node, back to back.
//
//   node tests/bench/ladder.mjs
//   LADDER_REPO=/path/to/clone node tests/bench/ladder.mjs
//
// How it works, and why it is trustworthy:
//   1. `git worktree add` a detached checkout at each historical commit.
//   2. Copy TODAY's `tests/bench/protocol.ts` + `node-ts.ts` (and `node-fit.ts`
//      where the commit has a fit path) into that worktree, replacing whatever
//      benchmark that commit shipped.
//   3. Bundle with esbuild and run under plain `node`.
//
// Step 2 is the whole point. The old commits are NOT measured with their own
// contemporary harness; they are measured with this one. `protocol.ts` imports
// only `src/sim/engine.ts` and `src/types.ts`, which every one of these commits
// has, so the grafted harness compiles and runs unchanged at each of them.
//
// The final census is printed for every rung. Two rungs that report the same
// census ran the same workload; a rung that reports a different one did not,
// and the difference in tick rate between them means nothing. (The engine's
// trajectory was deliberately REDEFINED at the event-driven commit, so the
// census legitimately changes there — and only there.)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';
import { rawHeader } from './run-node.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');

/** The stages the engine actually went through. Ordered oldest first. */
export const RUNGS = [
  { commit: 'db04e30', label: 'pre-optimization', fit: false },
  { commit: '972d38c', label: 'TS hot-loop round', fit: true },
  { commit: '8065c2d', label: 'Phase 1 event-driven core', fit: true },
  { commit: 'c581e44', label: 'Phase 2 WASM+GPU backends (TS engine)', fit: true },
  { commit: 'HEAD', label: 'HEAD', fit: true },
];

/** Files grafted into each worktree. Every one of them must import nothing
 *  outside `src/sim/*` and `src/types.ts` (plus `src/lib/fit-sim.ts` for the
 *  fit entry) or the graft will not build at the older commits. */
const GRAFT = ['tests/bench/protocol.ts', 'tests/bench/node-ts.ts'];
const GRAFT_FIT = ['tests/bench/node-fit.ts'];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function findRepo() {
  if (process.env.LADDER_REPO) return path.resolve(process.env.LADDER_REPO);
  try {
    return git(appRoot, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(
      'Not inside a git repository. Clone the project and run the ladder from the clone, ' +
      'or set LADDER_REPO to a clone that has the historical commits.',
    );
  }
}

export async function runLadder({ repo = findRepo(), rungs = RUNGS, env = {}, keepWorktrees = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memelab-ladder-'));
  const out = process.env.BENCH_OUT ?? path.join(appRoot, 'bench-out');
  fs.mkdirSync(out, { recursive: true });
  const rows = [];

  for (const rung of rungs) {
    const sha = git(repo, ['rev-parse', rung.commit]);
    const shortSha = sha.slice(0, 7);
    const date = git(repo, ['show', '-s', '--format=%cs', sha]);
    const wt = path.join(scratch, shortSha);
    console.error(`\n=== ${rung.label} (${shortSha}, ${date}) ===`);
    git(repo, ['worktree', 'add', '--detach', wt, sha]);

    try {
      for (const rel of [...GRAFT, ...(rung.fit ? GRAFT_FIT : [])]) {
        const dst = path.join(wt, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(appRoot, rel), dst);
      }

      const bundlePath = path.join(out, `ladder-${shortSha}-ts.mjs`);
      await bundle({ entry: 'tests/bench/node-ts.ts', outfile: bundlePath, platform: 'node', format: 'esm', cwd: wt });
      const tsRun = await runBundle(bundlePath, wt, { ...env, BENCH_LABEL: `${rung.label} (${shortSha})` });

      let fitRun = null;
      if (rung.fit) {
        const fitBundle = path.join(out, `ladder-${shortSha}-fit.mjs`);
        await bundle({ entry: 'tests/bench/node-fit.ts', outfile: fitBundle, platform: 'node', format: 'esm', cwd: wt });
        fitRun = await runBundle(fitBundle, wt, { ...env, BENCH_LABEL: `${rung.label} (${shortSha})` });
      }

      fs.writeFileSync(
        path.join(out, `raw-ladder-${shortSha}.txt`),
        rawHeader({
          title: `MemeLab ladder rung — ${rung.label}`,
          label: `${rung.label} @ ${shortSha} (authored ${date})`,
          runtime: `plain node, ${process.env.BENCH_BUNDLER || 'vite'} bundle of TODAY's tests/bench harness, grafted into a worktree at this commit`,
          notes: [
            'NOT vite-node — see tests/README.md',
            'the old commit is measured with the CURRENT harness, not with whatever benchmark it shipped',
          ],
        }) + tsRun.text + (fitRun ? `\n${fitRun.text}` : ''),
      );

      rows.push({
        commit: shortSha, sha, date, label: rung.label,
        ts: tsRun.json, fit: fitRun ? fitRun.json : null,
      });
    } finally {
      if (!keepWorktrees) {
        try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { /* best effort */ }
      }
    }
  }

  if (!keepWorktrees) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ } }
  return rows;
}

async function runBundle(bundlePath, cwd, env) {
  const { spawn } = await import('node:child_process');
  const text = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], { cwd, env: { ...process.env, ...env } });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { buf += d; process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve(buf) : reject(new Error(`${bundlePath} exited ${c}\n${buf}`))));
  });
  const line = text.split('\n').find((l) => l.startsWith('##BENCH_JSON## '));
  return { text, json: line ? JSON.parse(line.slice('##BENCH_JSON## '.length)) : null };
}

export function formatLadder(rows, geometry = 'square') {
  const pick = (row) => (row.ts?.results ?? []).find((r) => r.geometry === geometry);
  const first = pick(rows[0]);
  const lines = [
    `ladder — ${geometry} ${first ? first.size : '?'}², plain Node, best of ${first ? first.reps : '?'}`,
    '',
    'stage                                    commit    t/s        vs prev   vs start   final census',
  ];
  let prev = null;
  const base = first ? first.ticksPerSec : null;
  for (const row of rows) {
    const r = pick(row);
    if (!r) continue;
    const c = r.census;
    lines.push(
      `${row.label.padEnd(40)} ${row.commit}  ${r.ticksPerSec.toFixed(1).padStart(9)}  ` +
      `${(prev ? `${(r.ticksPerSec / prev).toFixed(2)}×` : '—').padStart(7)}  ` +
      `${(base ? `${(r.ticksPerSec / base).toFixed(1)}×` : '—').padStart(8)}   ` +
      `I=${c.i} E=${c.e} D=${c.d}`,
    );
    prev = r.ticksPerSec;
  }
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const rows = await runLadder();
  console.log('');
  for (const g of (process.env.BENCH_GEOMETRIES || 'square').split(',')) {
    console.log(formatLadder(rows, g.trim()));
    console.log('');
  }
  const out = process.env.BENCH_OUT ?? path.join(appRoot, 'bench-out');
  fs.writeFileSync(path.join(out, 'ladder.json'), JSON.stringify({ date: new Date().toISOString(), rows }, null, 2));
  console.log(`raw logs + ladder.json in ${out}`);
}
