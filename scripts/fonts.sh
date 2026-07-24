#!/usr/bin/env bash
# Install the six font faces the card renderer needs. Idempotent: files whose
# sha256 already matches are left alone. FORCE=1 re-downloads everything.
#
#   bash scripts/fonts.sh            # install / verify
#   FORCE=1 bash scripts/fonts.sh    # re-download
#   FONT_DIR=/some/where bash scripts/fonts.sh
#
# Requires bash (brace expansion, arrays) -- do not run with sh.
set -euo pipefail

FONT_DIR="${FONT_DIR:-$HOME/.fonts}"

# --- IBM Plex Serif -----------------------------------------------------------
# Pinned to a COMMIT SHA, not a tag or `master`:
#   * `master` broke once already (the repo was restructured into packages/).
#   * every published tag (latest is v6.4.2) still predates that restructure and
#     404s on packages/plex-serif/... -- verified 2026-07-22.
# A commit SHA is the only immutable ref that serves the current layout.
PLEX_REF="2f9ba1b25957d958db71a849e85d72e3ecfb845a"
PLEX_BASE="https://raw.githubusercontent.com/IBM/plex/${PLEX_REF}/packages/plex-serif/fonts/complete/ttf"

# --- Inter --------------------------------------------------------------------
# The release zip's top level ships variable-axis woff2, which Cairo renders at
# the wrong weight. The static TTFs under extras/ttf/ are what we want.
INTER_VER="4.1"
INTER_URL="https://github.com/rsms/inter/releases/download/v${INTER_VER}/Inter-${INTER_VER}.zip"

declare -A SUMS=(
  [IBMPlexSerif-Regular.ttf]=6c490ccd38e856c674e0d163f3f40742a75058b7b935998dbfbc1745ba54e474
  [IBMPlexSerif-SemiBold.ttf]=857edeaaff0f3913f4dfaf6bc0e9c89ef73e475429cf63d6a3cb5d1022a213d5
  [Inter-Regular.ttf]=40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82
  [Inter-Medium.ttf]=97ad806f526e41546d46365bb3a393145f75b7b1568913db74549ad8b8dba872
  [Inter-SemiBold.ttf]=78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3
  [Inter-Bold.ttf]=288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f
)

ok() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
add() { printf '  \033[36mget\033[0m  %s\n' "$1"; }
die() { printf '\033[31mfatal:\033[0m %s\n' "$1" >&2; exit 1; }

have() {  # have <filename> -> 0 if present with the expected checksum
  local f="$FONT_DIR/$1"
  [[ -z "${FORCE:-}" && -f "$f" ]] || return 1
  [[ "$(sha256sum "$f" | cut -d' ' -f1)" == "${SUMS[$1]}" ]]
}

check() {
  local f="$FONT_DIR/$1" got
  got="$(sha256sum "$f" | cut -d' ' -f1)"
  [[ "$got" == "${SUMS[$1]}" ]] || die "checksum mismatch for $1 (got $got)"
}

command -v curl >/dev/null || die "curl is required"
command -v unzip >/dev/null || die "unzip is required"
mkdir -p "$FONT_DIR"

echo "Fonts -> $FONT_DIR"

changed=0
for face in Regular SemiBold; do
  name="IBMPlexSerif-${face}.ttf"
  if have "$name"; then ok "$name"; continue; fi
  add "$name"
  curl -fsSL -o "$FONT_DIR/$name" "${PLEX_BASE}/${name}" \
    || die "download failed: ${PLEX_BASE}/${name}"
  check "$name"; changed=1
done

need_inter=0
for face in Regular Medium SemiBold Bold; do
  have "Inter-${face}.ttf" || need_inter=1
done

if (( need_inter )); then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  add "Inter-${INTER_VER}.zip"
  curl -fsSL -o "$tmp/inter.zip" "$INTER_URL" || die "download failed: $INTER_URL"
  for face in Regular Medium SemiBold Bold; do
    name="Inter-${face}.ttf"
    # -j flattens. The leading * also matches the empty string, so this handles
    # both "extras/ttf/X" (v4.1's layout) and "Inter-N.N/extras/ttf/X".
    unzip -o -j -q "$tmp/inter.zip" "*extras/ttf/${name}" -d "$FONT_DIR" \
      || die "could not extract ${name} from the Inter zip"
    check "$name"; ok "$name"
  done
  changed=1
else
  for face in Regular Medium SemiBold Bold; do ok "Inter-${face}.ttf"; done
fi

if (( changed )) || [[ -n "${FORCE:-}" ]]; then
  fc-cache -f "$FONT_DIR" >/dev/null
  echo "  fc-cache refreshed"
fi

# --- verification -------------------------------------------------------------
# Cairo's toy text API only understands normal/bold and resolves the family
# string through fontconfig, so these are the exact queries the renderer relies
# on. An unresolvable family silently falls back to DejaVu.
echo "fontconfig resolution:"
fail=0
verify() { # verify <fc-pattern> <expected-file>
  local got; got="$(fc-match "$1" 2>/dev/null | cut -d: -f1)"
  if [[ "$got" == "$2" ]]; then ok "$1 -> $got"
  else printf '  \033[31mBAD\033[0m  %s -> %s (expected %s)\n' "$1" "$got" "$2"; fail=1; fi
}
verify "IBM Plex Serif"                 IBMPlexSerif-Regular.ttf
verify "IBM Plex Serif:style=SemiBold"  IBMPlexSerif-SemiBold.ttf
verify "Inter Medium"                   Inter-Medium.ttf
verify "Inter SemiBold"                 Inter-SemiBold.ttf
verify "Inter:style=Bold"               Inter-Bold.ttf
(( fail == 0 )) || die "fontconfig did not resolve the expected faces"

# The authoritative check is the renderer's own fingerprint of what cairo
# actually paints; run it when the venv is available.
VENV="${VENV:-$HOME/.venvs/hemicycle}"
if [[ -x "$VENV/bin/python" ]]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "renderer face fingerprint:"
  "$VENV/bin/python" "$here/render/render_card.py" --selftest >/dev/null \
    && ok "cairo renders all 5 registered faces correctly" \
    || die "render_card.py --selftest failed (see: $VENV/bin/python $here/render/render_card.py --selftest)"
fi

echo "Fonts ready."
