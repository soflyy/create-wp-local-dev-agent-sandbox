// Configure GitHub auth + git identity inside an environment's workspace
// container, so the Cursor worker can clone/commit/push. Uses the shared
// GITHUB_TOKEN via `gh auth login --with-token` + `gh auth setup-git` (gh is
// installed in the image). Secrets are passed by env name (-e), never on argv.
//
// Non-fatal: a bad/expired token shouldn't abort environment creation — we log
// a warning and continue (the worker still runs; pushes will just fail until
// the token is fixed and /start is re-run).

import { exec } from './docker.js';
import { log } from './log.js';

// The token is carried in DEVBOX_GH_TOKEN (NOT GH_TOKEN/GITHUB_TOKEN): gh refuses
// to *store* credentials with `--with-token` when GH_TOKEN/GITHUB_TOKEN is set in
// the env (it would just use the env var, which the worker process doesn't have).
// Storing via gh + `gh auth setup-git` persists a credential helper in
// /home/node so the worker can clone/commit/push without the token in its env.
const SCRIPT = [
  'set -e',
  'printf %s "$DEVBOX_GH_TOKEN" | gh auth login --with-token',
  'gh auth setup-git',
  'git config --global user.name "$GIT_AUTHOR_NAME"',
  'git config --global user.email "$GIT_AUTHOR_EMAIL"',
].join(' && ');

export async function configure(env, config, githubToken) {
  if (!githubToken) {
    log.warn(`[${env.name}] no GitHub token set (Settings) — skipping git auth; clone/push of private repos will fail.`);
    return false;
  }
  try {
    await exec(env, 'workspace', ['sh', '-lc', SCRIPT], {
      envNames: ['DEVBOX_GH_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'],
      envValues: {
        DEVBOX_GH_TOKEN: githubToken,
        GIT_AUTHOR_NAME: config.gitAuthorName,
        GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
      },
      timeout: 60_000,
    });
    return true;
  } catch (err) {
    log.warn(`[${env.name}] git auth setup failed (continuing):`, err.message);
    return false;
  }
}
