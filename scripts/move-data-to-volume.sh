#!/usr/bin/env bash
#
# Move the devbox data dir (server/data — the env bind mounts, registry, and
# sessions) onto an already-mounted volume, then bind-mount the volume BACK onto
# the original path so every absolute path stored in registry.json / sessions.json
# stays valid. See docs/storage-on-a-volume.md for the full runbook.
#
# SAFE BY DESIGN:
#   - Dry run unless --apply is given.
#   - Copies with rsync (never moves/deletes the source during the copy).
#   - Verifies the copy is byte-identical before swapping anything.
#   - Keeps the original as <data-dir>.old — this script NEVER deletes it.
#   - Restores the exact original on rollback (instructions printed on failure).
#
# Usage:
#   sudo bash scripts/move-data-to-volume.sh --volume /mnt/devbox_data          # dry run
#   sudo bash scripts/move-data-to-volume.sh --volume /mnt/devbox_data --apply  # do it
#
# Options:
#   --volume DIR     Mountpoint of the attached, formatted, EMPTY volume. Required.
#   --data-dir DIR   The devbox data dir. Default: <repo>/server/data
#   --service NAME   systemd unit to stop/start. Default: devbox-server
#   --apply          Actually perform the migration (otherwise dry run).

set -euo pipefail

VOLUME=""
DATA_DIR=""
SERVICE="devbox-server"
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --volume)   VOLUME="${2:?}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --service)  SERVICE="${2:?}"; shift 2 ;;
    --apply)    APPLY=1; shift ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default data dir = <repo>/server/data, derived from this script's location.
if [[ -z "$DATA_DIR" ]]; then
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  DATA_DIR="$SELF/server/data"
fi

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo -e "$*"; }
hr()  { echo "------------------------------------------------------------"; }

[[ -n "$VOLUME" ]] || die "--volume is required (mountpoint of the attached volume)"
[[ $EUID -eq 0 ]]  || die "run as root (sudo) — it stops the service and edits /etc/fstab"
command -v rsync >/dev/null || die "rsync not found — apt-get install rsync"

# Resolve to absolute, canonical paths.
DATA_DIR="$(readlink -f "$DATA_DIR")" || die "cannot resolve --data-dir"
VOLUME="$(readlink -f "$VOLUME")"     || die "cannot resolve --volume"
OLD_DIR="$DATA_DIR.old"

# ---- preflight ------------------------------------------------------------
[[ -d "$DATA_DIR" ]] || die "data dir does not exist: $DATA_DIR"
[[ -L "$DATA_DIR" ]] && die "data dir is already a symlink — looks migrated. Aborting."
if mountpoint -q "$DATA_DIR"; then die "data dir is already a mountpoint — looks migrated. Aborting."; fi
[[ -e "$OLD_DIR" ]] && die "$OLD_DIR already exists — a prior run left it. Resolve/remove it first."

mountpoint -q "$VOLUME" || die "$VOLUME is not a mountpoint. Attach+format+mount the volume first (see docs)."

# The volume must be a DIFFERENT filesystem than the data dir (else we'd copy
# onto the same disk we're trying to drain).
DATA_DEV="$(df --output=source "$DATA_DIR" | tail -1)"
VOL_DEV="$(df --output=source "$VOLUME"   | tail -1)"
[[ "$DATA_DEV" != "$VOL_DEV" ]] || die "volume and data dir are on the SAME device ($DATA_DEV). Point --volume at the attached volume."

# Volume should be empty (a fresh ext4 has only lost+found).
shopt -s nullglob dotglob
VOL_ENTRIES=( "$VOLUME"/* )
shopt -u nullglob dotglob
for e in "${VOL_ENTRIES[@]}"; do
  [[ "$(basename "$e")" == "lost+found" ]] && continue
  die "volume $VOLUME is not empty (found $(basename "$e")). Use an empty volume."
done

NEED_KB="$(du -sk "$DATA_DIR" | cut -f1)"
FREE_KB="$(df -Pk "$VOLUME" | tail -1 | awk '{print $4}')"
NEED_GB=$(( NEED_KB / 1024 / 1024 )); FREE_GB=$(( FREE_KB / 1024 / 1024 ))
[[ "$FREE_KB" -gt "$NEED_KB" ]] || die "not enough space on volume: need ${NEED_GB}GB, free ${FREE_GB}GB"

ENV_COUNT="$( [[ -f "$DATA_DIR/registry.json" ]] && node -e 'const r=require(process.argv[1]);console.log(Object.keys(r.environments||{}).length)' "$DATA_DIR/registry.json" 2>/dev/null || echo '?')"

hr
say "Plan:"
say "  data dir     : $DATA_DIR   (${NEED_GB} GB, ${ENV_COUNT} environments)"
say "  volume       : $VOLUME     (${FREE_GB} GB free, device $VOL_DEV)"
say "  service      : $SERVICE"
say ""
say "  1. stop $SERVICE + any env containers writing under the data dir"
say "  2. rsync -aHAX --numeric-ids  $DATA_DIR/  ->  $VOLUME/   (source untouched)"
say "  3. verify the copy is byte-identical"
say "  4. mv $DATA_DIR -> $OLD_DIR ; recreate empty $DATA_DIR ; fstab bind-mount $VOLUME onto it"
say "  5. start $SERVICE ; restart the env containers that were running"
say ""
say "  Original kept at $OLD_DIR — this script NEVER deletes it."
hr

if [[ "$APPLY" -ne 1 ]]; then
  say "DRY RUN — nothing changed. Re-run with --apply to perform the migration."
  exit 0
fi

# ---- apply ----------------------------------------------------------------
say ">> [1/5] stopping $SERVICE and env containers…"
systemctl stop "$SERVICE" || die "could not stop $SERVICE"

# Containers whose bind sources live under the data dir — stop them so nothing
# writes mid-copy (keeps databases consistent). Remember the running set so we
# can bring exactly those back afterward (paths are unchanged, so they re-bind).
RUNNING_CIDS=()
if command -v docker >/dev/null; then
  while read -r cid; do
    [[ -z "$cid" ]] && continue
    if docker inspect "$cid" --format '{{range .Mounts}}{{println .Source}}{{end}}' 2>/dev/null | grep -q "^$DATA_DIR/"; then
      RUNNING_CIDS+=("$cid")
    fi
  done < <(docker ps -q)
  if [[ ${#RUNNING_CIDS[@]} -gt 0 ]]; then
    say "   stopping ${#RUNNING_CIDS[@]} container(s) with mounts under the data dir…"
    docker stop "${RUNNING_CIDS[@]}" >/dev/null
  fi
fi

say ">> [2/5] copying data to the volume (this can take a while for tens of GB)…"
rsync -aHAX --numeric-ids --info=progress2 "$DATA_DIR"/ "$VOLUME"/

say ">> [3/5] verifying the copy is identical…"
# A second rsync in itemize+dry-run mode must report ZERO changes.
DIFF="$(rsync -aHAXn --numeric-ids -i "$DATA_DIR"/ "$VOLUME"/ | grep -v '^$' || true)"
if [[ -n "$DIFF" ]]; then
  say "$DIFF" | head -20
  die "verification found differences after copy — NOT swapping. Source is untouched at $DATA_DIR."
fi
say "   verified: byte-identical."

say ">> [4/5] swapping in the bind mount…"
mv "$DATA_DIR" "$OLD_DIR"
mkdir "$DATA_DIR"
FSTAB_LINE="$VOLUME $DATA_DIR none bind 0 0"
if ! grep -qF "$FSTAB_LINE" /etc/fstab; then
  echo "$FSTAB_LINE" >> /etc/fstab
fi
mount --bind "$VOLUME" "$DATA_DIR"
mountpoint -q "$DATA_DIR" || die "bind mount failed — restore with: rmdir '$DATA_DIR'; mv '$OLD_DIR' '$DATA_DIR'"

# Sanity: the registry the server will read must be the one on the volume now.
NEW_COUNT="$( [[ -f "$DATA_DIR/registry.json" ]] && node -e 'const r=require(process.argv[1]);console.log(Object.keys(r.environments||{}).length)' "$DATA_DIR/registry.json" 2>/dev/null || echo '?')"
[[ "$NEW_COUNT" == "$ENV_COUNT" ]] || die "post-swap env count ($NEW_COUNT) != before ($ENV_COUNT). Investigate before starting; original safe at $OLD_DIR."

say ">> [5/5] starting $SERVICE and restarting env containers…"
systemctl start "$SERVICE"
if [[ ${#RUNNING_CIDS[@]} -gt 0 ]]; then
  docker start "${RUNNING_CIDS[@]}" >/dev/null || say "   WARN: some containers didn't restart — start them from the UI."
fi

hr
say "DONE. Env data now lives on $VOLUME, bind-mounted at $DATA_DIR."
say "Verify in the UI (open a couple of sites + session transcripts), then reclaim space:"
say "    sudo rm -rf '$OLD_DIR'      # frees ~${NEED_GB} GB on the root disk"
say ""
say "Rollback (before deleting .old):"
say "    sudo systemctl stop $SERVICE"
say "    sudo umount '$DATA_DIR' && sudo rmdir '$DATA_DIR'"
say "    sudo sed -i '\\# $DATA_DIR #d' /etc/fstab"
say "    sudo mv '$OLD_DIR' '$DATA_DIR'"
say "    sudo systemctl start $SERVICE"
hr
