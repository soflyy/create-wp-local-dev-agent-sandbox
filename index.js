#!/usr/bin/env node
/**
 * create-wp-local-dev-agent-sandbox
 *
 * Scaffolds a local WordPress + AI-agent dev environment (Docker Compose) into
 * a target directory. Does NOT run Docker — the scaffolded project ships npm
 * scripts (npm run start / bash / claude / …) for that.
 *
 * Usage:
 *   npm create wp-local-dev-agent-sandbox -- [dir] [--port=8080]
 *   npx create-wp-local-dev-agent-sandbox [dir] [--port=8080]
 */

import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, 'templates');

// Template filename -> output filename (dotfiles can't ship as dotfiles in npm).
const RENAME = {
  'env.example': '.env',
  'gitignore': '.gitignore',
};

// Key files we refuse to clobber if the target already has them.
const GUARD = ['docker-compose.yml', 'package.json', '.env', 'workspace.Dockerfile', 'sandbox.config.json'];

function parseArgs(argv) {
  const out = { dir: null, port: '8080' };
  for (const a of argv) {
    if (a.startsWith('--port=')) out.port = a.slice('--port='.length);
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!a.startsWith('-') && out.dir === null) out.dir = a;
  }
  return out;
}

function usage() {
  console.log(`create-wp-local-dev-agent-sandbox

Scaffold a local WordPress + AI-agent Docker dev environment.

Usage:
  npm create wp-local-dev-agent-sandbox -- [dir] [--port=8080]
  npx create-wp-local-dev-agent-sandbox [dir] [--port=8080]

Arguments:
  dir            Target directory (default: current directory)
  --port=NNNN    Host port for WordPress (default: 8080)
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
  const collisions = existing.filter((f) => GUARD.includes(f));
  if (collisions.length) {
    console.error(`\n✖ Refusing to overwrite existing files in ${targetDir}:`);
    console.error(`  ${collisions.join(', ')}\n`);
    process.exit(1);
  }

  await copyTemplates(TEMPLATES, targetDir, { projectName, port: String(args.port) });

  const cd = args.dir ? args.dir : '.';
  console.log(`\n✔ Scaffolded WordPress + agent sandbox in ${targetDir}\n`);
  console.log('Next steps:');
  console.log(`  cd ${cd}`);
  console.log('  npm run setup        # first run: build, start & install WordPress (admin / password)');
  console.log(`  open http://localhost:${args.port}`);
  console.log('  npm run start        # subsequent runs: just bring the containers up');
  console.log('  npm run bash         # shell into the workspace container');
  console.log('  npm run claude       # launch Claude Code in the workspace');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
