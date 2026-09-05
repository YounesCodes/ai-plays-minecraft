#!/usr/bin/env bash
set -euo pipefail

# Swap Paper worlds without ever destroying anything.
#
# Concepts:
#   - The live world stays authoritative for autonomy (memories, deaths,
#     progression). The current abused/depleted lab world is KEEPER as the
#     hostile/stressed test world.
#   - A clean benchmark world (fresh regen from a FIXED seed) makes movement
#     and resource-search tests deterministic and repeatable.
#
# Layout (all under the lab dir, default ~/minecraft-lab):
#   server/world                 active Paper world
#   world-snapshots/<name>/      stored full world dirs (never deleted by this script)
#
# Usage:
#   scripts/benchmark-world.sh status [--lab-dir DIR]
#   scripts/benchmark-world.sh prepare <name|fresh> --confirm [--lab-dir DIR] [--seed N]
#   scripts/benchmark-world.sh restore <name> --confirm [--lab-dir DIR]
#   scripts/benchmark-world.sh id [--lab-dir DIR]
#
# World-instance identity (<world>/.ai-world-id): fresh worlds always mint
# a NEW id (same seed = different instance); restores carry their snapshot's
# own id; `id` assigns one to legacy worlds without touching game data.
#
# prepare <name>:  active world -> snapshots/previous-<timestamp>/, then
#                  snapshots/<name>/ -> active world.
# prepare fresh:   active world stashed as above, then an EMPTY world dir is
#                  created (Paper generates on next start). With --seed N the
#                  seed is written to server.properties first (only affects
#                  fresh generation). Recommended golden seed: 20260904.
# restore <name>:  same mechanics back the other way (active is always
#                  stashed first, never deleted).
#
# Safety: refuses to do anything unless Paper is NOT listening on 25565 AND
# --confirm is passed. Paper must be stopped first (systemd or tmux).

LAB_DIR="${HOME}/minecraft-lab"
CONFIRM=0
SEED=""

# World-instance identity sidecar (src/world/instance.js contract):
# <world>/.ai-world-id = {"id":"world_<16hex>","seed":...,"createdAt":...}.
# Fresh worlds always mint a NEW id (same seed = different instance).
# Snapshots carry their own id inside the world dir. Paper ignores dotfiles.
write_world_id() {
  # $1 = world dir, $2 = seed or empty
  local dir="$1" seed="$2" id now
  id="world_$(od -An -tx1 -N8 /dev/urandom 2>/dev/null | tr -d ' \n' || echo "fallback$RANDOM$RANDOM" | cksum | cut -d' ' -f1)"
  now="$(date -u +%FT%TZ 2>/dev/null || date +%FT%TZ)"
  mkdir -p "$dir"
  printf '{\n  "id": "%s",\n  "seed": %s,\n  "createdAt": "%s"\n}\n' \
    "$id" "$([ -n "$seed" ] && printf '"%s"' "$seed" || printf 'null')" "$now" > "$dir/.ai-world-id"
  echo "$id"
}

read_world_id() {
  # $1 = world dir; prints id or nothing
  local f="$1/.ai-world-id" id
  if [ -f "$f" ]; then
    id="$(grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | cut -d'"' -f4)"
    case "$id" in
      world_*) printf '%s' "$id" ;;
    esac
  fi
}

ensure_world_id() {
  # $1 = world dir, $2 = seed or empty; assigns only when missing
  local cur
  cur="$(read_world_id "$1")"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return 0; fi
  write_world_id "$1" "$2"
}

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

log() { echo "[benchmark-world] $*"; }
die() { echo "[benchmark-world] ERROR: $*" >&2; exit 1; }

paper_running() {
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':25565'; then
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet minecraft-paper 2>/dev/null; then
    return 0
  fi
  return 1
}

CMD="${1:-status}"
shift || true
NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lab-dir) LAB_DIR="${2:?missing value}"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    --seed) SEED="${2:?missing value}"; shift 2 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option: $1" ;;
    *) if [ -z "$NAME" ]; then NAME="$1"; else die "unexpected argument: $1"; fi; shift ;;
  esac
done

SERVER_DIR="$LAB_DIR/server"
SNAP_DIR="$LAB_DIR/world-snapshots"

case "$CMD" in
  status)
    log "lab dir: $LAB_DIR"
    if paper_running; then log "paper: RUNNING (stop it before any swap)"; else log "paper: stopped"; fi
    if [ -d "$SERVER_DIR/world" ]; then
      log "active world: $SERVER_DIR/world ($(du -sh "$SERVER_DIR/world" 2>/dev/null | cut -f1)) id=$(read_world_id "$SERVER_DIR/world" || true)${SEED:+ seed=$SEED}"
    else
      log "active world: MISSING ($SERVER_DIR/world)"
    fi
    if [ -d "$SNAP_DIR" ]; then
      log "snapshots:"
      for d in "$SNAP_DIR"/*/; do
        [ -d "$d" ] || continue
        log "  $(basename "$d") ($(du -sh "$d" 2>/dev/null | cut -f1))"
      done
    else
      log "snapshots: none yet ($SNAP_DIR does not exist)"
    fi
    ;;
  prepare|restore)
    [ -n "$NAME" ] || die "usage: $0 $CMD <name|fresh> --confirm [--lab-dir DIR] [--seed N]"
    [ "$CONFIRM" = "1" ] || die "refusing without --confirm (this moves your live world aside)"
    if paper_running; then
      die "Paper is still running (port 25565 listening). Stop it first, then re-run."
    fi
    [ -d "$SERVER_DIR" ] || die "server dir not found: $SERVER_DIR"
    if [ "$NAME" = "fresh" ]; then
      [ "$CMD" = "prepare" ] || die "restore needs an existing snapshot name, not 'fresh'"
      STAMP="$(date +%F-%H%M%S)-$$"
      mkdir -p "$SNAP_DIR"
      if [ -d "$SERVER_DIR/world" ]; then
        log "stashing active world -> snapshots/previous-$STAMP/"
        mv "$SERVER_DIR/world" "$SNAP_DIR/previous-$STAMP"
      fi
      mkdir -p "$SERVER_DIR/world"
      log "created empty world dir (Paper generates on next start)"
      FRESH_ID="$(write_world_id "$SERVER_DIR/world" "$SEED")"
      log "minted world-instance id=$FRESH_ID (new instance even for repeated seeds)"
      if [ -n "$SEED" ]; then
        if grep -q '^level-seed=' "$SERVER_DIR/server.properties" 2>/dev/null; then
          sed -i "s/^level-seed=.*/level-seed=$SEED/" "$SERVER_DIR/server.properties"
        else
          printf '\nlevel-seed=%s\n' "$SEED" >> "$SERVER_DIR/server.properties"
        fi
        log "wrote level-seed=$SEED (applies to fresh generation only)"
      fi
      log "done. Start Paper to generate the world."
    else
      [ -d "$SNAP_DIR/$NAME" ] || die "snapshot not found: $SNAP_DIR/$NAME"
      STAMP="$(date +%F-%H%M%S)-$$"
      mkdir -p "$SNAP_DIR"
      if [ -d "$SERVER_DIR/world" ]; then
        log "stashing active world -> snapshots/previous-$STAMP/"
        mv "$SERVER_DIR/world" "$SNAP_DIR/previous-$STAMP"
      fi
      log "activating snapshot $NAME -> world/"
      cp -r "$SNAP_DIR/$NAME" "$SERVER_DIR/world"
      RESTORED_ID="$(ensure_world_id "$SERVER_DIR/world" "")"
      log "world-instance id=$RESTORED_ID (travels with the snapshot)"
      log "done. Start Paper."
    fi
    ;;
  id|ensure-id)
    # Print (and assign if missing) the active world's instance identity.
    # Safe on a running server: only a tiny dotfile is written.
    if [ ! -d "$SERVER_DIR/world" ]; then die "no active world dir"; fi
    ID_OUT="$(ensure_world_id "$SERVER_DIR/world" "")"
    log "active world-instance id=$ID_OUT"
    ;;
  *)
    die "unknown command: $CMD (status|prepare|restore|id)"
    ;;
esac
