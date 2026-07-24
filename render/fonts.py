"""Real text measurement for cairosvg output.

Why this module exists
----------------------
Estimating text width by character count under-estimates by up to ~29% and made
group labels collide with their bars. Every string that has to fit somewhere is
measured here with PIL against the *exact* TTF that cairo will select.

The cairosvg / cairo "toy" text API only understands NORMAL and BOLD, and it
resolves the family string through fontconfig. That produces two traps, both
verified empirically on this box:

  * ``font-weight="600"`` does NOT give you SemiBold -- cairo rounds it to BOLD.
  * an unresolvable family (e.g. "IBM Plex Serif SemiBold", "Inter Regular")
    silently falls back to DejaVu Sans, ~4% wider and visually wrong.
  * family "Inter" at normal weight resolves to Inter *Medium*, not Regular;
    Inter Regular is simply not reachable through cairo on this font set.

So FACES below is a registry of (family, weight) pairs that were fingerprinted
by ink mass against the real faces, each paired with the TTF cairo actually
picks. ``verify_faces()`` re-runs that fingerprint and is exposed as
``render_card.py --selftest`` so a font regression fails loudly instead of
silently shifting every layout.
"""

from __future__ import annotations

import functools
import os
from dataclasses import dataclass
from typing import Sequence

from PIL import ImageFont

# PIL reports the unhinted advance width; cairo paints hinted ink, which can be
# WIDER -- it rounds each glyph's advance and snaps stems, and the raster has an
# antialiasing fringe. Calibrated over 2030 samples (5 faces x 14 sizes from 11
# to 84 x 29 strings) against real cairosvg ink extents: the tightest envelope
# that never under-calls is advance * 1.02 + 3.61px, so 1.02 + 4px it is.
# Under-calling is the bug that made group labels collide with their bars, so
# these two numbers must only ever move up. render/check_overflow.py re-measures
# every placed string through cairo and fails if this prediction is ever short.
SAFETY = 1.02
PAD = 4.0

ELLIPSIS = "…"


@dataclass(frozen=True)
class Face:
    key: str
    family: str  # SVG font-family -- must be a string fontconfig resolves
    weight: str  # SVG font-weight -- cairo only honours normal/bold
    filename: str  # the TTF cairo actually selects for (family, weight)


FACES = {
    f.key: f
    for f in (
        Face("serif", "IBM Plex Serif", "normal", "IBMPlexSerif-Regular.ttf"),
        # Only Regular + SemiBold of Plex Serif are installed, so "bold"
        # resolves to SemiBold -- which is the weight the house style wants.
        Face("serif_bold", "IBM Plex Serif", "bold", "IBMPlexSerif-SemiBold.ttf"),
        Face("sans", "Inter Medium", "normal", "Inter-Medium.ttf"),
        Face("sans_semi", "Inter SemiBold", "normal", "Inter-SemiBold.ttf"),
        Face("sans_bold", "Inter", "bold", "Inter-Bold.ttf"),
    )
}

_SEARCH_DIRS = [
    os.environ.get("SCRUTIN_FONT_DIR"),
    os.path.expanduser("~/.fonts"),
    os.path.expanduser("~/.local/share/fonts"),
    "/usr/local/share/fonts",
    "/usr/share/fonts",
]


class FontError(RuntimeError):
    pass


@functools.lru_cache(maxsize=None)
def font_path(filename: str) -> str:
    for d in _SEARCH_DIRS:
        if not d:
            continue
        direct = os.path.join(d, filename)
        if os.path.isfile(direct):
            return direct
        for root, _dirs, files in os.walk(d):
            if filename in files:
                return os.path.join(root, filename)
    raise FontError(
        f"font {filename!r} not found -- run scripts/fonts.sh (searched: "
        + ", ".join(p for p in _SEARCH_DIRS if p)
        + ")"
    )


@functools.lru_cache(maxsize=None)
def _pil_font(filename: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(font_path(filename), size)


def face(key: str) -> Face:
    try:
        return FACES[key]
    except KeyError:
        raise FontError(f"unknown face {key!r}; known: {sorted(FACES)}") from None


def measure(text: str, face_key: str, size: float, letter_spacing: float = 0.0) -> float:
    """Width in logical px of ``text`` as cairo will paint it."""
    if not text:
        return 0.0
    f = _pil_font(face(face_key).filename, max(1, int(round(size))))
    w = f.getlength(text) * SAFETY + PAD
    if letter_spacing:
        # cairo adds the spacing to n-1 gaps -- verified, exactly 8*(n-1) at 8px.
        w += letter_spacing * (len(text) - 1)
    return w


def ellipsize(text: str, face_key: str, size: float, max_width: float,
              letter_spacing: float = 0.0) -> str:
    if measure(text, face_key, size, letter_spacing) <= max_width:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        cand = text[:mid].rstrip() + ELLIPSIS
        if measure(cand, face_key, size, letter_spacing) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    return (text[:lo].rstrip() + ELLIPSIS) if lo else ELLIPSIS


@dataclass(frozen=True)
class Fit:
    text: str
    size: int
    width: float
    strategy: str  # full | alt | shrunk | ellipsis


def fit_text(candidates: Sequence[str], max_width: float, face_key: str,
             size: int, min_size: int | None = None,
             letter_spacing: float = 0.0) -> Fit:
    """Fit ladder: full name -> official abbrev -> shrink -> ellipsis.

    ``candidates`` is tried in order at the full size first, then the whole list
    again at each smaller size, so a longer label is preferred over a smaller
    one only while it still fits.
    """
    cands = [c for c in candidates if c]
    if not cands:
        return Fit("", size, 0.0, "full")
    floor = size if min_size is None else max(1, min_size)
    for s in range(size, floor - 1, -1):
        for i, cand in enumerate(cands):
            w = measure(cand, face_key, s, letter_spacing)
            if w <= max_width:
                if s == size:
                    strategy = "full" if i == 0 else "alt"
                else:
                    strategy = "shrunk"
                return Fit(cand, s, w, strategy)
    text = ellipsize(cands[-1], face_key, floor, max_width, letter_spacing)
    return Fit(text, floor, measure(text, face_key, floor, letter_spacing), "ellipsis")


def wrap_lines(text: str, max_width: float, face_key: str, size: int,
               max_lines: int) -> list[str] | None:
    """Greedy word wrap. Returns None if it needs more than ``max_lines``."""
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    cur = ""
    for word in words:
        cand = f"{cur} {word}".strip()
        if not cur or measure(cand, face_key, size) <= max_width:
            cur = cand
            continue
        lines.append(cur)
        cur = word
        if len(lines) > max_lines:
            return None
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        return None
    if any(measure(l, face_key, size) > max_width for l in lines):
        return None  # a single unbreakable word overflows
    return lines


def fit_paragraph(text: str, max_width: float, face_key: str, size: int,
                  min_size: int, max_lines: int) -> tuple[list[str], int]:
    for s in range(size, min_size - 1, -1):
        lines = wrap_lines(text, max_width, face_key, s, max_lines)
        if lines is not None:
            return lines, s
    lines = wrap_lines(text, max_width, face_key, min_size, max_lines) or []
    if not lines:  # force the split, then ellipsise the overflowing tail
        words, cur, lines = text.split(), "", []
        for word in words:
            cand = f"{cur} {word}".strip()
            if not cur or measure(cand, face_key, min_size) <= max_width:
                cur = cand
            else:
                lines.append(cur)
                cur = word
            if len(lines) == max_lines:
                break
        if cur and len(lines) < max_lines:
            lines.append(cur)
        consumed = len(" ".join(lines))
        rest = text[consumed:].strip()
        if rest and lines:
            lines[-1] = ellipsize(lines[-1] + " " + rest, face_key, min_size, max_width)
    return lines, min_size


# --------------------------------------------------------------- self test ---

_PROBE = "Rassemblement National Horizons"
_PROBE_SIZE = 48
_PROBE_W, _PROBE_H = 1400, 120


def _fingerprint_pil(filename: str) -> tuple[float, float]:
    from PIL import Image, ImageDraw, ImageStat

    f = _pil_font(filename, _PROBE_SIZE)
    im = Image.new("L", (_PROBE_W, _PROBE_H), 0)
    ImageDraw.Draw(im).text((20, 40), _PROBE, font=f, fill=255)
    box = im.getbbox() or (0, 0, 0, 0)
    return ImageStat.Stat(im).sum[0] / 255.0, float(box[2] - box[0])


def _fingerprint_cairo(family: str, weight: str) -> tuple[float, float]:
    import io

    import cairosvg
    from PIL import Image, ImageStat

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_PROBE_W}" '
        f'height="{_PROBE_H}" viewBox="0 0 {_PROBE_W} {_PROBE_H}">'
        f'<rect width="{_PROBE_W}" height="{_PROBE_H}" fill="black"/>'
        f'<text x="20" y="80" font-family="{family}" font-weight="{weight}" '
        f'font-size="{_PROBE_SIZE}" fill="white">{_PROBE}</text></svg>'
    )
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=_PROBE_W,
                           output_height=_PROBE_H)
    im = Image.open(io.BytesIO(png)).convert("L")
    box = im.getbbox() or (0, 0, 0, 0)
    return ImageStat.Stat(im).sum[0] / 255.0, float(box[2] - box[0])


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return abs(a[0] - b[0]) / max(b[0], 1) + abs(a[1] - b[1]) / max(b[1], 1)


def verify_faces() -> list[dict]:
    """Prove cairo really renders each registered face. Raises on mismatch."""
    refs = {f.filename: _fingerprint_pil(f.filename) for f in FACES.values()}
    fallback = _fingerprint_cairo("ZzNoSuchFamilyAtAll", "normal")
    report, problems = [], []
    for f in FACES.values():
        got = _fingerprint_cairo(f.family, f.weight)
        best = min(refs, key=lambda k: _dist(got, refs[k]))
        d_expected = _dist(got, refs[f.filename])
        d_fallback = _dist(got, fallback)
        ok = best == f.filename and d_fallback > 0.02
        report.append({
            "face": f.key, "family": f.family, "weight": f.weight,
            "expects": f.filename, "resolved_to": best,
            "dist_expected": round(d_expected, 4),
            "dist_fallback": round(d_fallback, 4), "ok": ok,
        })
        if not ok:
            problems.append(
                f"{f.key}: font-family={f.family!r} weight={f.weight} rendered as "
                f"{best} (expected {f.filename}, fallback-distance {d_fallback:.3f})"
            )
    if problems:
        raise FontError("font face verification failed:\n  " + "\n  ".join(problems))
    return report
