// Agent Connector for WP integration: replace the release-zip plugin with a live
// git checkout of the repo (TARGET_REPO, default soflyy/agent-connector-for-wp),
// so the agent operates on — and commits to — the real repository.
//
// Mirrors the repo's own documented local-dev flow:
//   clone <repo> → (cd <subdir> && composer install --no-dev) →
//   symlink <subdir> into wp-content/plugins/<slug> → wp plugin activate <slug>
//
// Runs once in the create pipeline (after git auth, before the worker starts).
// Requires git auth to be configured first (so a private repo can be cloned and
// later pushed). Fatal on error — an environment whose whole purpose is to work
// on this repo isn't useful without it.

import { appendFile } from 'node:fs/promises';
import { exec } from './docker.js';

// Run in the workspace container. All inputs arrive via env (off argv). The
// plugin lives at $DEST/$SUBDIR; vendor/ is gitignored so composer install is
// required when a composer.json is present.
const SCRIPT = `set -e
DEST="/home/node/$T_SLUG"
PLUGIN_DIR="/home/node/wp/wp-content/plugins/$T_SLUG"

echo "→ Removing any installed '$T_SLUG' (replacing release zip with the git checkout)…"
wp plugin delete "$T_SLUG" >/dev/null 2>&1 || true

if [ -d "$DEST/.git" ]; then
  echo "→ Repo already present at $DEST — updating…"
  git -C "$DEST" remote set-url origin "$T_REPO"
  git -C "$DEST" fetch --all --prune
else
  echo "→ Cloning $T_REPO → $DEST…"
  rm -rf "$DEST"
  git clone "$T_REPO" "$DEST"
fi
if [ -n "$T_REF" ]; then
  echo "→ Checking out $T_REF…"
  git -C "$DEST" checkout "$T_REF"
fi

if [ -f "$DEST/$T_SUBDIR/composer.json" ]; then
  echo "→ composer install --no-dev in $T_SUBDIR (vendor/ is gitignored)…"
  composer install --no-dev --no-interaction --no-progress -d "$DEST/$T_SUBDIR"
fi

echo "→ Symlinking $DEST/$T_SUBDIR → $PLUGIN_DIR…"
rm -rf "$PLUGIN_DIR"
ln -s "$DEST/$T_SUBDIR" "$PLUGIN_DIR"

echo "→ Activating '$T_SLUG'…"
wp plugin activate "$T_SLUG"

# If the repo ships a skill installer (convention: abilities-generator), run it
# so its Claude/Cursor skill(s) are linked into the agents' skills dirs. The skill
# dirs are made node-writable by install-skills.sh during \`npm run setup\` (which
# runs before this). Non-fatal — a skill-install hiccup shouldn't fail the env.
SKILL_INSTALLER="$DEST/abilities-generator/scripts/install-skill.sh"
if [ -f "$SKILL_INSTALLER" ]; then
  echo "→ Installing repo skill(s) via abilities-generator/scripts/install-skill.sh…"
  ( cd "$DEST/abilities-generator" && bash scripts/install-skill.sh ) || echo "  (claude skill install failed; continuing)"
  ( cd "$DEST/abilities-generator" && CLAUDE_SKILLS_DIR=/home/node/.cursor/skills bash scripts/install-skill.sh ) || echo "  (cursor skill install failed; continuing)"
fi
echo "✓ '$T_SLUG' is now served from the git checkout at $DEST"
`;

export async function setup(env, config) {
  if (!config.targetRepo) return false; // disabled → general-purpose worker
  let out = '';
  try {
    const res = await exec(env, 'workspace', ['sh', '-lc', SCRIPT], {
      envNames: ['T_SLUG', 'T_REPO', 'T_REF', 'T_SUBDIR'],
      envValues: {
        T_SLUG: config.targetPluginSlug,
        T_REPO: config.targetRepo,
        T_REF: config.targetRepoRef || '',
        T_SUBDIR: config.targetPluginSubdir,
      },
      timeout: 5 * 60 * 1000,
    });
    out = `${res.stdout || ''}${res.stderr || ''}`;
    await appendFile(env.setupLogPath, `\n=== target repo: ${config.targetPluginSlug} ===\n${out}\n`).catch(() => {});
    return true;
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || err.message || err}`;
    await appendFile(env.setupLogPath, `\n=== target repo FAILED ===\n${out}\n`).catch(() => {});
    throw new Error(`target repo setup failed for ${config.targetPluginSlug}`);
  }
}
