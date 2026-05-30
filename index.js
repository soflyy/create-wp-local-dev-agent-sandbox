#!/usr/bin/env node
/**
 * create-wp-local-dev-agent-sandbox
 *
 * Scaffolds a local WordPress + AI-agent dev environment (Docker Compose) into
 * a target directory, then runs `npm run setup` (docker compose up + WordPress
 * and plugin install). Pass --scaffold-only to write files and skip Docker.
 *
 * Usage:
 *   npm create wp-local-dev-agent-sandbox -- [dir] [--port=8080] [--scaffold-only]
 *   npx create-wp-local-dev-agent-sandbox [dir] [--port=8080] [--scaffold-only]
 */

import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, 'templates');

// Template filename -> output filename (dotfiles can't ship as dotfiles in npm).
const RENAME = {
  'env.example': '.env',
  'gitignore': '.gitignore',
};

// When checking that the target dir is empty, these harmless entries don't count.
const ALLOWED_EXISTING = new Set([
  '.git', '.gitignore', '.gitkeep', '.hg', '.svn',
  '.DS_Store', 'Thumbs.db', '.idea', '.vscode',
  'LICENSE', 'LICENSE.md', 'README.md',
]);

function parseArgs(argv) {
  const out = { dir: null, port: '8080', setup: true };
  for (const a of argv) {
    if (a.startsWith('--port=')) out.port = a.slice('--port='.length);
    else if (a === '--scaffold-only') out.setup = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!a.startsWith('-') && out.dir === null) out.dir = a;
  }
  return out;
}

function usage() {
  console.log(`create-wp-local-dev-agent-sandbox

Scaffold a local WordPress + AI-agent Docker dev environment.

Usage:
  npm create wp-local-dev-agent-sandbox -- [dir] [--port=8080] [--scaffold-only]
  npx create-wp-local-dev-agent-sandbox [dir] [--port=8080] [--scaffold-only]

Arguments:
  dir              Target directory (default: current directory)

Options:
  --port=NNNN      Host port for WordPress (default: 8080)
  --scaffold-only  Only write files; skip the automatic \`npm run setup\`
`);
}

async function copyTemplates(srcDir, destDir, vars) {
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, RENAME[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await copyTemplates(src, dest, vars);
    } else {
      const rendered = (await readFile(src, 'utf8'))
        .replaceAll('__PROJECT_NAME__', vars.projectName)
        .replaceAll('__WP_PORT__', vars.port);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, rendered);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const targetDir = resolve(args.dir ?? '.');
  const projectName = basename(targetDir);

  await mkdir(targetDir, { recursive: true });

  const existing = await readdir(targetDir).catch(() => []);
  const blocking = existing.filter((f) => !ALLOWED_EXISTING.has(f));
  if (blocking.length) {
    const shown = blocking.slice(0, 5).join(', ') + (blocking.length > 5 ? ', …' : '');
    console.error(`\n✖ ${targetDir} is not empty (found: ${shown}).`);
    console.error('  This scaffolder needs an empty directory. Point it at a new one, e.g.:');
    console.error('    npm create wp-local-dev-agent-sandbox@latest my-site\n');
    process.exit(1);
  }

  await copyTemplates(TEMPLATES, targetDir, { projectName, port: String(args.port) });

  const cd = args.dir ? args.dir : '.';
  console.log(`\n✔ Scaffolded WordPress + agent sandbox in ${targetDir}\n`);

  if (!args.setup) {
    console.log('Next steps:');
    console.log(`  cd ${cd}`);
    console.log('  npm run setup        # build, start & install WordPress + plugins (Docker must be running)');
    console.log('  npm run start        # subsequent runs: just bring the containers up');
    console.log('  npm run claude       # launch Claude Code in the workspace');
    console.log('');
    console.log(`Once setup finishes, your site is at http://localhost:${args.port} — log in at /wp-admin with admin / password.`);
    return;
  }

  console.log('→ Running initial setup (Docker must be running)…\n');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['run', 'setup'], { cwd: targetDir, stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    console.error('\n✖ Initial setup did not finish (is Docker running?).');
    console.error('  Your files are scaffolded — retry once Docker is up:');
    console.error(`    cd ${cd} && npm run setup\n`);
    process.exit(res.status ?? 1);
  }

  console.log('\nEveryday commands:');
  console.log(`  cd ${cd}`);
  console.log('  npm run start        # bring the stack up next time (it stays up otherwise)');
  console.log('  npm run claude       # launch Claude Code in the workspace');
  console.log('  npm run bash         # shell into the workspace container');
  console.log('');
  console.log('───────────────────────────────────────────────');
  console.log('  Your WordPress site is ready:');
  console.log(`    Site:     http://localhost:${args.port}`);
  console.log(`    Admin:    http://localhost:${args.port}/wp-admin`);
  console.log('    Username: admin');
  console.log('    Password: password');
  console.log('───────────────────────────────────────────────');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
