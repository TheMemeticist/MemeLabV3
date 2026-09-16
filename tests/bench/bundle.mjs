// Bundling for the benchmark entries — two pipelines, and the difference
// between them is itself a measurement result, so read this before choosing.
//
// WHY ANY OF THIS EXISTS: `npm run bench` runs `tests/bench.ts` through
// vite-node, and vite-node is not a neutral measuring instrument. Its SSR
// transform turns every cross-module import into a property on a synthetic
// namespace object whose members are ACCESSOR properties — `Object.
// defineProperty(exports, 'CellState', { get() { return CellState } })`. So a
// `const enum` read in a hot loop becomes a getter CALL plus a property load,
// per read, per cell, per tick. Nothing the app ships does that.
//
// The two honest pipelines:
//
//   'vite'    (DEFAULT) — the app's own production pipeline: esbuild for the
//             per-file TS transform, rollup for bundling, exactly as
//             `vite build` produces the worker chunk that runs the engine in
//             the shipped app. Cross-module `const enum` members survive as
//             plain data-property loads on a module-scope object (`CellState.
//             Infectious`), which is what really ships. Quote these numbers.
//
//   'esbuild' — esbuild in --bundle mode. Faster to run, but it INLINES
//             cross-module const enum members to numeric literals, which the
//             production build does not do. Useful precisely for measuring what
//             that inlining is worth; misleading if quoted as an app number.
//
// Set BENCH_BUNDLER=esbuild to switch. Both are vite dependencies; nothing
// extra to install.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const appRoot = path.resolve(here, '..', '..');

export const DEFAULT_BUNDLER = 'vite';

function loadEsbuild() {
  try {
    return require('esbuild');
  } catch {
    throw new Error('esbuild not found. It normally arrives with vite — run `npm ci` first.');
  }
}

async function loadVite() {
  try {
    return await import('vite');
  } catch {
    // When bundling inside a worktree that has no node_modules of its own,
    // fall back to the toolchain of the checkout this harness lives in.
    return await import(path.join(appRoot, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  }
}

/**
 * Bundle one benchmark entry.
 * @param {{ entry: string, outfile: string, platform?: 'node'|'browser',
 *           cwd?: string, bundler?: 'vite'|'esbuild', globalName?: string }} opts
 * @returns {Promise<string>} the path actually written
 */
export async function bundle(opts) {
  const cwd = opts.cwd ?? appRoot;
  const platform = opts.platform ?? 'node';
  const bundler = opts.bundler ?? process.env.BENCH_BUNDLER ?? DEFAULT_BUNDLER;

  if (bundler === 'esbuild') {
    const esbuild = loadEsbuild();
    await esbuild.build({
      entryPoints: [opts.entry],
      outfile: opts.outfile,
      bundle: true,
      platform,
      format: platform === 'node' ? 'esm' : 'iife',
      target: 'es2022',
      minify: false,
      sourcemap: false,
      logLevel: 'warning',
      absWorkingDir: cwd,
    });
    return opts.outfile;
  }

  if (bundler !== 'vite') throw new Error(`unknown bundler '${bundler}' (expected 'vite' or 'esbuild')`);

  const { build } = await loadVite();
  const outDir = path.join(path.dirname(opts.outfile), `.vite-${path.basename(opts.outfile)}`);
  // Not minified: minification is not part of what makes a tick fast, and an
  // unminified bundle can be read to check what the transform actually did to
  // the hot loop.
  await build({
    configFile: false,
    root: cwd,
    logLevel: 'error',
    build: {
      target: 'es2022',
      minify: false,
      sourcemap: false,
      emptyOutDir: true,
      outDir,
      ssr: platform === 'node',
      lib: {
        entry: opts.entry,
        formats: [platform === 'node' ? 'es' : 'iife'],
        name: opts.globalName ?? 'memelabBenchBundle',
        fileName: () => 'bench-bundle.js',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
    ssr: platform === 'node' ? { noExternal: true, target: 'node' } : undefined,
  });

  // Vite's lib mode names SSR output after the entry rather than honouring
  // `fileName`, so take whatever single JS chunk landed in the scratch dir.
  const produced = fs.readdirSync(outDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  if (produced.length !== 1) {
    throw new Error(`expected exactly one bundle in ${outDir}, found: ${produced.join(', ') || '(none)'}`);
  }
  fs.copyFileSync(path.join(outDir, produced[0]), opts.outfile);
  return opts.outfile;
}
