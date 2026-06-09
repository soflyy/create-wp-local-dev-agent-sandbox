/**
 * create-wp-local-dev-agent-sandbox — scaffolding engine.
 *
 * `create()` is the reusable entry point. The bundled CLI (index.js) calls it
 * with no preset; downstream `create-<brand>` packages depend on this package
 * and call it with a preset to add their own plugins. See the README section
 * "Build your own npm create command".
 */

import { readdir, mkdir, readFile, writeFile, chown } from 'node:fs/promises';
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

function usage(pkg, create) {
  console.log(`${pkg}

Scaffold a local WordPress + AI-agent Docker dev environment.

Usage:
  npm ${create} -- [dir] [--port=8080] [--scaffold-only]
  npx ${pkg} [dir] [--port=8080] [--scaffold-only]

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

// Append a preset's plugins to the scaffolded sandbox.config.json. Each entry is
// the same shape install-plugins.sh understands: a wordpress.org slug string, or
// { source, activate?, version? } where source is a slug or a URL/path to a .zip.
async function applyPreset(targetDir, preset) {
  if (!preset.plugins?.length) return;
  const cfgPath = join(targetDir, 'sandbox.config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  cfg.plugins = [...(cfg.plugins ?? []), ...preset.plugins];
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Scaffold the sandbox into a target directory and (unless --scaffold-only) run
 * `npm run setup`.
 *
 * @param {object} [options]
 * @param {object} [options.preset]          Derivative config. MVP: { name?, plugins? }.
 * @param {string} [options.preset.name]     Short name, e.g. "oxygen-wp" — only used to
 *                                           print the right `npm create <name>` in messages.
 * @param {Array}  [options.preset.plugins]  Extra plugins appended to the defaults.
 * @param {string[]} [options.argv]          CLI args (default: process.argv.slice(2)).
 */
export async function create({ preset = {}, argv = process.argv.slice(2) } = {}) {
  // What to call this command in help/error text — wrappers pass preset.name.
  const slug = preset.name ?? 'wp-local-dev-agent-sandbox';
  const pkg = `create-${slug}`;

  const args = parseArgs(argv);
  if (args.help) {
    usage(pkg, `create ${slug}`);
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
    console.error(`    npm create ${slug}@latest my-site\n`);
    process.exit(1);
  }

  await copyTemplates(TEMPLATES, targetDir, { projectName, port: String(args.port) });
  await applyPreset(targetDir, preset);

  // Pre-create the bind-mount host dirs (see docker-compose.yml). If they don't
  // exist when the stack first comes up, Docker creates them as root — on Linux
  // that leaves them owned by root and unwritable from the host.
  for (const d of ['db', 'workspace/wp']) {
    await mkdir(join(targetDir, d), { recursive: true });
  }

  // ./workspace is the workspace container's home (/home/node), and that
  // container runs as the node user (uid/gid 1000). On Linux a bind mount keeps
  // the host's ownership, so node can write there only if the host dir is owned
  // by 1000 — the repo's "anchor everything to uid 1000" model (see
  // APACHE_RUN_USER in docker-compose.yml), which holds when the default Ubuntu
  // host user (also 1000) scaffolds. When scaffolding as root the dir would be
  // root-owned and unwritable, so the agents' configs (~/.claude.json, the seed,
  // ~/.cursor/mcp.json) silently fail to persist. Align it explicitly. (db/ is
  // left alone — the mariadb container manages its own datadir ownership.)
  if (process.getuid && process.getuid() === 0) {
    for (const d of ['workspace', 'workspace/wp']) {
      await chown(join(targetDir, d), 1000, 1000);
    }
  }

  const cd = args.dir ? args.dir : '.';
  console.log(`\n✔ Scaffolded WordPress + agent sandbox in ${targetDir}\n`);

  if (!args.setup) {
    console.log('Next steps:');
    console.log(`  cd ${cd}`);
    console.log('  npm run setup        # build, start & install WordPress + plugins (Docker must be running)');
    console.log('  npm run start        # subsequent runs: just bring the containers up');
    console.log('  npm run claude       # launch Claude Code in the workspace');
    console.log('  npm run cursor       # launch the Cursor CLI agent in the workspace');
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
  console.log('  npm run cursor       # launch the Cursor CLI agent in the workspace');
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
