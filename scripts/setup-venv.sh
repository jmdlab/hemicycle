#!/usr/bin/env bash
# Provision the Python venv the card renderer shells out to. Idempotent.
#
#   bash scripts/setup-venv.sh
#   VENV=/opt/scrutin-venv bash scripts/setup-venv.sh
#
# System packages need sudo the first time; if apt isn't available or the libs
# are already present the script skips straight to the venv.
set -euo pipefail

VENV="${VENV:-$HOME/.venvs/hemicycle}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# cairosvg binds libcairo through cffi; librsvg/pango come along for text and
# are what fontconfig hangs off. libffi-dev is needed to build cffi from source
# on distros without a wheel.
SYS_PKGS=(libcairo2 libpango-1.0-0 libpangocairo-1.0-0 librsvg2-2 libffi-dev
          fontconfig unzip)

ok() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
die() { printf '\033[31mfatal:\033[0m %s\n' "$1" >&2; exit 1; }

echo "System libraries:"
missing=()
if command -v dpkg-query >/dev/null; then
  for p in "${SYS_PKGS[@]}"; do
    if dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed"; then
      ok "$p"
    else
      missing+=("$p")
    fi
  done
  if (( ${#missing[@]} )); then
    echo "  installing: ${missing[*]}"
    sudo apt-get update -qq
    sudo apt-get install -y -qq "${missing[@]}" || die "apt install failed"
  fi
else
  echo "  (no dpkg -- assuming cairo/pango/librsvg are present)"
fi

echo "Virtualenv: $VENV"
if [[ ! -x "$VENV/bin/python" ]]; then
  command -v python3 >/dev/null || die "python3 is required"
  python3 -m venv "$VENV" || die "could not create the venv"
  ok "created"
else
  ok "exists"
fi

"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$HERE/render/requirements.txt" \
  || die "pip install failed"
ok "requirements installed"

"$VENV/bin/python" - <<'PY' || die "cairosvg/Pillow import check failed"
import cairosvg, PIL
print(f"  \033[32mok\033[0m   cairosvg {cairosvg.__version__}, Pillow {PIL.__version__}")
PY

# Fonts are a hard dependency of the renderer, so provision them here too.
bash "$HERE/scripts/fonts.sh"

echo
echo "Render a card with:"
echo "  $VENV/bin/python $HERE/render/render_card.py --in payload.json --outdir out"
