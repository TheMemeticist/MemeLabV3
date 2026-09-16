#!/usr/bin/env node
// Run one benchmark entry under PLAIN node, from the Vite production bundle.
//
//   node tests/bench/run-node.mjs ts         # TS engine, five geometries, 320²
//   node tests/bench/run-node.mjs backends   # TS vs WASM + parity
//   node tests/bench/run-node.mjs fit        # estimator inner loop
//   node tests/bench/run-node.mjs frame      # frame-post / history payload
//
// All BENCH_* env knobs documented on each entry file apply. Raw output is
// teed to $BENCH_OUT (default ./bench-out) with a self-describing header, so a
// run can be archived next to whatever it is quoted in.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');

const ENTRIES = {
  ts: 'tests/bench/node-ts.ts',
  backends: 'tests/bench/node-backends.ts',
  fit: 'tests/bench/node-fit.ts',
  frame: 'tests/bench/node-frame.ts',
};

export async function runNodeBench(which, { env = {}, outDir, label } = {}) {
  const rel = ENTRIES[which];
  if (!rel) throw new Error(`unknown entry '${which}' — one of ${Object.keys(ENTRIES).join(', ')}`);

  const out = outDir ?? process.env.BENCH_OUT ?? path.join(appRoot, 'bench-out');
  fs.mkdirSync(out, { recursive: true });
  const bundlePath = path.join(out, `bench-${which}.bundle.mjs`);
  await bundle({ entry: rel, outfile: bundlePath, platform: 'node', format: 'esm', cwd: appRoot });

  const childEnv = { ...process.env, ...env };
  if (label) childEnv.BENCH_LABEL = label;

  const text = await new Promise((resolve, reject) => {
    // `node <bundle>` — no loader, no transform, no vite-node.
    const child = spawn(process.execPath, [bundlePath], { cwd: appRoot, env: childEnv });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { buf += d; process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(`${rel} exited ${code}\n${buf}`))));
  });

  const line = text.split('\n').find((l) => l.startsWith('##BENCH_JSON## '));
  const json = line ? JSON.parse(line.slice('##BENCH_JSON## '.length)) : null;
  return { text, json, bundlePath };
}

export function rawHeader({ title, label, runtime, notes = [] }) {
  return [
    `# ${title}`,
    `# harness: MemeLab tests/bench (protocol shared via tests/bench/protocol.ts)`,
    `# runtime: ${runtime}`,
    `# stage:   ${label}`,
    `# date:    ${new Date().toISOString()}`,
    `# node:    ${process.version}`,
    ...notes.map((n) => `# note:    ${n}`),
    '',
  ].join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const which = process.argv[2] ?? 'ts';
  const { text } = await runNodeBench(which);
  const out = process.env.BENCH_OUT ?? path.join(appRoot, 'bench-out');
  const file = path.join(out, `raw-node-${which}.txt`);
  fs.writeFileSync(file, rawHeader({
    title: `MemeLab ${which} benchmark`,
    label: process.env.BENCH_LABEL ?? 'HEAD',
    runtime: `plain node, ${process.env.BENCH_BUNDLER || 'vite'} bundle`,
    notes: [
      'NOT vite-node — see tests/README.md',
      'the vite bundle is the app\'s own production pipeline (esbuild transform + rollup)',
    ],
  }) + text);
  console.log(`\nraw log: ${file}`);
}
