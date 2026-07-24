#!/usr/bin/env python3
"""Render a scrutin card to SVG + three rasters.

    python render_card.py --in payload.json --outdir DIR

Prints a JSON result on stdout:

    {"preview": {...}, "share": {...}, "card": {...},
     "svg": {"file": "..."}, "templateVersion": "..."}

On failure it prints {"error": "..."} on stdout and exits non-zero.

Neutrality
----------
This template is deliberately incapable of naming a single group in prose. The
absents figure is only ever rendered as an aggregate ("N absents sur 577"), and
rows are ordered by seat count descending -- never by absence or vote share --
so no argmax over groups is ever printed. Every group's absent segment sits on
the same axis, which is how the absence angle is conveyed.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import os
import re
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import theme as T  # noqa: E402
from fonts import FACES, ellipsize, fit_paragraph, fit_text, measure  # noqa: E402

MONTHS_FR = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
             "août", "septembre", "octobre", "novembre", "décembre")

HERO_MODES = ("absents", "pour", "contre", "participation")


class RenderError(RuntimeError):
    pass


# ----------------------------------------------------------------- helpers ---

def esc(s) -> str:
    return html.escape(str(s), quote=True)


def fmt_date(value) -> str:
    s = str(value or "").strip()
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        try:
            y, m, d = int(s[0:4]), int(s[5:7]), int(s[8:10])
            if 1 <= m <= 12:
                return f"{d} {MONTHS_FR[m - 1]} {y}"
        except ValueError:
            pass
    return s


def ordinal_leg(value) -> str:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return ""
    return f"{n}{'re' if n == 1 else 'e'} législature"


def sentence_case(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default



# AN law titles are a verbose greffe string: "l'ensemble de la proposition de loi
# visant à <sujet> (texte de la commission mixte paritaire)." The subject is what
# a reader needs; the nature (Proposition de loi) and reading (CMP) are metadata
# that belong in the eyebrow, not the headline.
_READING_MAP = {
    "commission mixte paritaire": "CMP", "nouvelle lecture": "Nouvelle lecture",
    "premiere lecture": "1re lecture", "première lecture": "1re lecture",
    "deuxieme lecture": "2e lecture", "deuxième lecture": "2e lecture",
    "lecture definitive": "Lecture définitive", "lecture définitive": "Lecture définitive",
}
_NATURE_MAP = {
    "proposition de loi": "Proposition de loi", "projet de loi": "Projet de loi",
    "proposition de resolution": "Proposition de résolution",
    "proposition de résolution": "Proposition de résolution",
    "motion de censure": "Motion de censure",
}
_READING_RE = re.compile(r"\s*\(([^)]*)\)\s*\.?\s*$")

# Leading boilerplate, stripped iteratively until the actual subject is reached.
# Order matters; the loop reapplies them so "l'ensemble de la proposition de loi
# visant à …" and "la motion de rejet préalable, déposée par Mme X, du projet de
# loi visant à …" both collapse to their subject.
_ENSEMBLE_RE = re.compile(r"^l['\u2019]ensemble\s+(?:de|du|des)\s+", re.I)
_MOTION_RE = re.compile(r"^(?:la\s+)?motion\s+de\s+(rejet\s+pr[ée]alable|rejet|censure|renvoi(?:\s+en\s+commission)?|proc[ée]dure)\s*,?\s*", re.I)
_DEPOSEE_RE = re.compile(r"^(?:d[ée]pos[ée]e?|pr[ée]sent[ée]e?)\s+par\s+(?:mme|mm\.|m\.|monsieur|madame|le\s+groupe|les\s+groupes)?[^,]{0,80},\s*", re.I)
_ARTICLE_RE = re.compile(r"^(?:le|la|les|du|de\s+la|de\s+l['\u2019]|des|d['\u2019]|l['\u2019])\s+", re.I)
_NATURE_RE = re.compile(r"^(proposition\s+de\s+loi|projet\s+de\s+loi|proposition\s+de\s+r[ée]solution)(?:\s+(?:organique|constitutionnelle|de\s+finances(?:\s+rectificative)?(?:\s+pour\s+\d{4})?|de\s+financement[^,]{0,60}))?\s*,?\s*", re.I)
_CONNECTOR_RE = re.compile(r"^(?:visant\s+[a\u00e0]|tendant\s+[a\u00e0]|relati(?:ve|f)s?\s+(?:[a\u00e0]|aux?)|portant|pour|sur|autorisant|ratifiant|instaurant|cr[ée]ant|modifiant|compl[ée]tant|renfor[c\u00e7]ant|am[ée]liorant|garantissant|apr[e\u00e8]s\s+engagement[^,]{0,60},?)\s+", re.I)

_NATURE_LABEL = {
    "proposition de loi": "Proposition de loi", "projet de loi": "Projet de loi",
    "proposition de resolution": "Proposition de résolution",
    "proposition de résolution": "Proposition de résolution",
}
_READING_MAP = {
    "commission mixte paritaire": "CMP", "nouvelle lecture": "Nouvelle lecture",
    "premiere lecture": "1re lecture", "première lecture": "1re lecture",
    "deuxieme lecture": "2e lecture", "deuxième lecture": "2e lecture",
    "lecture definitive": "Lecture définitive", "lecture définitive": "Lecture définitive",
}


def clean_title(raw_title):
    """-> (titre net, nature|None, reading|None). Épluche le préfixe administratif
    de façon itérative et conservatrice : si le reste devient trop court, on garde
    la dernière version viable (jamais de titre vide/absurde)."""
    t = str(raw_title or "").strip()
    if not t:
        return "Scrutin public", None, None
    reading = None
    m = _READING_RE.search(t)
    if m:
        key = m.group(1).strip().lower()
        for k, v in _READING_MAP.items():
            if k in key:
                reading = v
                t = t[:m.start()].strip()
                break
    nature = None
    for _ in range(8):  # bounded: each pass strips at most one segment
        before = t
        mm = _ENSEMBLE_RE.match(t)
        if mm:
            t = t[mm.end():].lstrip(); continue
        mm = _MOTION_RE.match(t)
        if mm:
            kind = re.sub(r"\s+", " ", mm.group(1)).lower()
            nature = "Motion de " + ("rejet" if "rejet" in kind else kind.split()[0])
            t = t[mm.end():].lstrip(); continue
        mm = _DEPOSEE_RE.match(t)
        if mm:
            t = t[mm.end():].lstrip(); continue
        mm = _NATURE_RE.match(t)
        if mm:
            key = re.sub(r"\s+", " ", mm.group(1)).lower()
            if nature is None:
                nature = _NATURE_LABEL.get(key)
            t = t[mm.end():].lstrip(); continue
        mm = _ARTICLE_RE.match(t)
        if mm and _NATURE_RE.match(t[mm.end():]):
            # only drop a leading article if a nature word follows it
            t = t[mm.end():].lstrip(); continue
        mm = _CONNECTOR_RE.match(t)
        if mm:
            t = t[mm.end():].lstrip(); continue
        break
    t = t.strip(" ,.;")
    if len(t) < 6:  # over-stripped -> fall back to the raw (minus reading)
        t = (str(raw_title or "").strip())
        m2 = _READING_RE.search(t)
        if m2 and reading:
            t = t[:m2.start()].strip()
    return sentence_case(t), nature, reading


# ------------------------------------------------------------------- model ---

@dataclass
class Group:
    abbrev: str
    nom: str
    membres: int
    pour: int
    contre: int
    abstention: int
    non_votant: int
    absent: int


@dataclass
class Doc:
    parts: list = field(default_factory=list)
    texts: list = field(default_factory=list)

    def add(self, markup: str) -> None:
        self.parts.append(markup)

    def text(self, x: float, y: float, s: str, face: str, size: float,
             fill: str, anchor: str = "start", ls: float = 0.0,
             box: tuple[float, float] | None = None, tag: str = "") -> float:
        f = FACES[face]
        attrs = [
            f'x="{x:.2f}"', f'y="{y:.2f}"',
            f'font-family="{esc(f.family)}"', f'font-weight="{f.weight}"',
            f'font-size="{size:.2f}"', f'fill="{fill}"',
        ]
        if anchor != "start":
            attrs.append(f'text-anchor="{anchor}"')
        if ls:
            attrs.append(f'letter-spacing="{ls:.2f}"')
        self.add(f"<text {' '.join(attrs)}>{esc(s)}</text>")
        w = measure(s, face, size, ls)
        if box is not None:
            self.texts.append({
                "tag": tag, "text": s, "face": face, "family": f.family,
                "weight": f.weight, "size": size, "letter_spacing": ls,
                "x": round(x, 2), "y": round(y, 2), "anchor": anchor,
                "measured": round(w, 2),
                "box": [round(box[0], 2), round(box[1], 2)],
            })
        return w


# ------------------------------------------------------------------ layout ---

def pick_grid_step(max_value: int, px_per_seat: float) -> int:
    for step in T.GRID_STEPS:
        if step * px_per_seat < 46:  # labels would collide horizontally
            continue
        if max_value // step + 1 <= T.MAX_GRIDLINES:
            return step
    return T.GRID_STEPS[-1]


def normalise(raw: dict) -> dict:
    syn = raw.get("synthese") or {}
    groups = []
    for g in raw.get("groupes") or []:
        membres = as_int(g.get("membres"))
        grp = Group(
            abbrev=str(g.get("abbrev") or "").strip(),
            nom=str(g.get("nom") or "").strip(),
            membres=membres,
            pour=as_int(g.get("pour")),
            contre=as_int(g.get("contre")),
            abstention=as_int(g.get("abstention")),
            non_votant=as_int(g.get("nonVotant")),
            absent=as_int(g.get("absent")),
        )
        if not grp.abbrev and not grp.nom:
            continue
        if grp.membres <= 0:
            grp.membres = (grp.pour + grp.contre + grp.abstention
                           + grp.non_votant + grp.absent)
        groups.append(grp)
    if not groups:
        raise RenderError("payload has no usable groupes[]")
    # Fixed, neutral ordering: seats descending, then abbrev for determinism.
    groups.sort(key=lambda g: (-g.membres, g.abbrev or g.nom))
    _clean = clean_title(raw.get("titre"))
    return {
        "numero": raw.get("numero"),
        "legislature": raw.get("legislature"),
        "date": raw.get("date"),
        # AN stores titles as a mid-sentence fragment ("l'ensemble du projet
        # de loi..."). Upper-casing the first letter is typography, not editing.
        "titre": _clean[0],
        "nature": _clean[1],
        "reading": _clean[2],
        "sort": str(raw.get("sort") or "").strip(),
        "effectif": as_int(raw.get("effectif"), 577) or 577,
        "sourceUrl": str(raw.get("sourceUrl") or "").strip(),
        "syn": {k: as_int(syn.get(k)) for k in
                ("votants", "exprimes", "majorite", "pour", "contre",
                 "abstention", "nonVotants")},
        "groups": groups,
    }



def half_ring(cx, cy, R, sw, total, segs, T):
    """Demi-anneau (hémicycle simplifié) : barre empilée courbée, proportions
    exactes sur `total` sièges. col=None => segment absent (aplat clair distinct,
    la hachure des barres est illisible en petit arc). Gap papier de 2px."""
    import math
    L = math.pi * R
    def pt(deg, r):
        return (cx + r * math.cos(math.radians(deg)), cy - r * math.sin(math.radians(deg)))
    x0, y0 = pt(180, R); x1, y1 = pt(0, R)
    dd = f"M {x0:.1f} {y0:.1f} A {R} {R} 0 0 1 {x1:.1f} {y1:.1f}"
    out, off, gap = [], 0.0, 2.0
    for v, col in segs:
        seg = (v / total) * L if total else 0.0
        if seg <= 0:
            continue
        stroke = col if col else "#dcd5c4"
        out.append(
            f'<path d="{dd}" fill="none" stroke="{stroke}" stroke-width="{sw}" '
            f'stroke-dasharray="{max(0.0, seg - gap):.1f} {L * 2:.1f}" '
            f'stroke-dashoffset="{-off:.1f}"/>')
        off += seg
    return "".join(out)


def build_svg(data: dict, hero_mode: str) -> tuple[str, dict]:
    groups: list[Group] = data["groups"]
    syn = data["syn"]
    n = len(groups)
    effectif = data["effectif"]

    tot_pour = syn["pour"] or sum(g.pour for g in groups)
    tot_contre = syn["contre"] or sum(g.contre for g in groups)
    tot_abst = syn["abstention"] or sum(g.abstention for g in groups)
    tot_nv = sum(g.non_votant for g in groups) or syn["nonVotants"]
    tot_absent = sum(g.absent for g in groups)
    if tot_absent <= 0:
        tot_absent = max(0, effectif - (syn["votants"] + tot_nv))

    sort_raw = data["sort"]
    sort_key = sort_raw.lower()
    adopted = sort_key.startswith("adopt")
    rejected = sort_key.startswith("rejet") or sort_key.startswith("non adopt")
    chip_color = T.ADOPTED if adopted else (T.CONTRE if rejected else T.MUTED)
    chip_label = (sort_raw[:1].upper() + sort_raw[1:]) if sort_raw else "Résultat"

    # ---- hero (factual transcription / arithmetic only) ----
    if hero_mode == "pour":
        hero_num, hero_lab = str(tot_pour), f"POUR SUR {syn['exprimes'] or (tot_pour + tot_contre)} EXPRIMÉS"
    elif hero_mode == "contre":
        hero_num, hero_lab = str(tot_contre), f"CONTRE SUR {syn['exprimes'] or (tot_pour + tot_contre)} EXPRIMÉS"
    elif hero_mode == "participation":
        pct = round(100.0 * syn["votants"] / effectif) if effectif else 0
        hero_num, hero_lab = f"{pct} %", f"DE PARTICIPATION SUR {effectif} DÉPUTÉS"
    else:
        hero_num, hero_lab = str(tot_absent), f"ABSENTS SUR {effectif}"

    d = Doc()

    # ---- top-right: half-ring (hémicycle) whose hollow holds the hero number ----
    hero_max_w = 2 * (T.RING_R - T.RING_SW) - 8
    hero_num_fit = fit_text([hero_num], hero_max_w, "serif_bold", T.HERO_NUM_SIZE,
                            min_size=T.HERO_NUM_SIZE - 22)
    hero_lab_fit = fit_text([hero_lab], hero_max_w + 40, "sans_semi", T.HERO_LABEL_SIZE,
                            min_size=T.HERO_LABEL_SIZE - 4, letter_spacing=T.HERO_LABEL_LS)
    hero_w = T.RING_COL

    # ---- header flow ----
    def header_flow(gap_sub: float, gap_legend: float, gap_chart: float,
                    max_lines: int):
        head_max_w = T.W - 2 * T.MARGIN_X - hero_w - 130
        lines, hsize = fit_paragraph(data["titre"], head_max_w, "serif_bold",
                                     T.HEADLINE_MAX, T.HEADLINE_MIN, max_lines)
        base0 = T.MARGIN_TOP + 118
        last = base0 + (len(lines) - 1) * hsize * T.HEADLINE_LEADING
        sub_base = last + gap_sub
        chip_top = sub_base + 22
        header_bottom = max(sub_base + 24, T.MARGIN_TOP + 130)
        legend_base = header_bottom + gap_legend
        chart_top = legend_base + gap_chart
        return dict(head_max_w=head_max_w, lines=lines, hsize=hsize, base0=base0,
                    sub_base=sub_base, chip_top=chip_top, legend_base=legend_base,
                    chart_top=chart_top)

    footer_base = T.H - T.MARGIN_BOTTOM
    footer_rule_y = footer_base - 26
    chart_floor = footer_rule_y - 24  # hard floor for the whole chart block

    def rows_metrics(chart_top: float) -> tuple[float, float]:
        # Reserve the axis strip first, so row height is derived from the space
        # rows actually get -- this is what stops the legend/footer collision.
        avail = chart_floor - chart_top - T.AXIS_BLOCK
        return avail, min(T.ROW_H_MAX, avail / n)

    hf = header_flow(52, 52, 58, T.HEADLINE_LINES)
    avail_v, rowh = rows_metrics(hf["chart_top"])
    if rowh < 22:  # dense scrutin: tighten the header instead of colliding
        hf = header_flow(36, 28, 18, 2)
        avail_v, rowh = rows_metrics(hf["chart_top"])
    rows_top = hf["chart_top"] + (avail_v - rowh * n) * 0.85  # ancré vers le bas
    # The axis rides directly under the last row, so a sparse chart doesn't
    # leave its scale stranded at the bottom of the canvas.
    axis_base = rows_top + rowh * n + 34

    # ---- label + annotation columns, from real measurement ----
    label_size = int(max(T.LABEL_SIZE_MIN, min(T.LABEL_SIZE_MAX, round(rowh * 0.40))))
    label_min = max(T.LABEL_SIZE_MIN, label_size - T.LABEL_SHRINK)
    label_fits = [
        fit_text([g.nom, g.abbrev] if g.nom and g.nom != g.abbrev else [g.abbrev],
                 T.LABEL_COL_MAX, "sans_semi", label_size, min_size=label_min)
        for g in groups
    ]
    label_col = max((f.width for f in label_fits), default=0.0)

    annot_size = int(max(T.ANNOT_SIZE_MIN, min(T.ANNOT_SIZE_MAX, round(rowh * 0.30))))
    annots = [f"{g.membres} sièges" + (f" · {g.absent} abs." if g.absent else "") for g in groups]
    annots = [ellipsize(a, "sans", annot_size, T.ANNOT_COL_MAX) for a in annots]
    annot_col = max((measure(a, "sans", annot_size) for a in annots), default=0.0)

    bars_x0 = T.MARGIN_X + label_col + T.GUTTER
    bars_x1 = T.W - T.MARGIN_X - annot_col - T.GUTTER
    bars_w = bars_x1 - bars_x0
    max_membres = max(g.membres for g in groups) or 1
    px = bars_w / max_membres
    step = pick_grid_step(max_membres, px)

    # ---- background ----
    d.add(
        '<defs>'
        f'<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{T.BG_TOP}"/>'
        f'<stop offset="1" stop-color="{T.BG_BOTTOM}"/></linearGradient>'
        '<pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" '
        'patternTransform="rotate(45)">'
        f'<line x1="0" y1="0" x2="0" y2="8" stroke="{T.HATCH_STROKE}" stroke-width="2.6"/>'
        '</pattern></defs>'
    )
    d.add(f'<rect width="{T.W}" height="{T.H}" fill="url(#bg)"/>')

    # ---- tricolour rule + eyebrow ----
    for i, col in enumerate(T.TRICOLOUR):
        stk = ' stroke="rgba(28,26,22,0.16)" stroke-width="1"' if col.upper() == "#FFFFFF" else ""
        d.add(f'<rect x="{T.MARGIN_X + i * 36}" y="{T.MARGIN_TOP}" width="36" '
              f'height="5" fill="{col}"{stk}/>')
    eyebrow_bits = [b for b in (
        f"Scrutin n° {data['numero']}" if data["numero"] is not None else "",
        data.get("nature") or "",
        data.get("reading") or "",
        fmt_date(data["date"]),
    ) if b]
    eyebrow = "  ·  ".join(eyebrow_bits).upper()
    eyebrow_max = T.W - 2 * T.MARGIN_X - hero_w - 56
    ef = fit_text([eyebrow], eyebrow_max, "sans_semi", T.EYEBROW_SIZE,
                  min_size=T.EYEBROW_SIZE - 4, letter_spacing=T.EYEBROW_LS)
    d.text(T.MARGIN_X, T.MARGIN_TOP + 34, ef.text, "sans_semi", ef.size, T.MUTED,
           ls=T.EYEBROW_LS, box=(T.MARGIN_X, T.MARGIN_X + eyebrow_max), tag="eyebrow")

    # ---- hero = half-ring (hémicycle) + number in the hollow ----
    ring_segs = [(tot_pour, T.POUR), (tot_contre, T.CONTRE), (tot_abst, T.ABSTENTION),
                 (tot_nv, T.NON_VOTANT), (tot_absent, None)]
    d.add(half_ring(T.RING_CX, T.RING_CY, T.RING_R, T.RING_SW, effectif or 1, ring_segs, T))
    # No big hero number — the ring + bars already show the split; a small scale
    # label is all the hollow needs (JM: "le graph parle de lui-même").
    cxr = T.RING_CX
    vfit = fit_text([chip_label], 2 * (T.RING_R - T.RING_SW) - 6, "serif_bold", 40, min_size=26)
    d.text(cxr, T.RING_CY - 30, vfit.text, "serif_bold", vfit.size, chip_color,
           anchor="middle", box=(cxr - 120, cxr + 120), tag="ring_verdict")
    d.text(cxr, T.RING_CY - 6, f"{effectif} sièges", "sans", 16, T.FAINT, ls=1.2,
           anchor="middle", box=(cxr - 90, cxr + 90), tag="ring_scale")

    # ---- headline ----
    for i, line in enumerate(hf["lines"]):
        d.text(T.MARGIN_X, hf["base0"] + i * hf["hsize"] * T.HEADLINE_LEADING, line,
               "serif_bold", hf["hsize"], T.PAPER,
               box=(T.MARGIN_X, T.MARGIN_X + hf["head_max_w"]), tag=f"headline{i}")

    # ---- subtitle ----
    sub_bits = [f"{syn['votants']} votants", f"{syn['exprimes']} exprimés"]
    if syn["majorite"]:
        sub_bits.append(f"majorité absolue {syn['majorite']}")
    subtitle = "  ·  ".join(sub_bits)
    sf = fit_text([subtitle], hf["head_max_w"], "sans", T.SUBTITLE_SIZE,
                  min_size=T.SUBTITLE_SIZE - 5)
    d.text(T.MARGIN_X, hf["sub_base"], sf.text, "sans", sf.size, T.MUTED,
           box=(T.MARGIN_X, T.MARGIN_X + hf["head_max_w"]), tag="subtitle")

    # (verdict moved into the ring hollow — no separate chip)

    # ---- legend ----
    legend = [("Pour", T.POUR, tot_pour, False), ("Contre", T.CONTRE, tot_contre, False),
              ("Abstention", T.ABSTENTION, tot_abst, False)]
    if tot_nv:
        legend.append(("Non-votants", T.NON_VOTANT, tot_nv, False))
    legend.append(("Absents", None, tot_absent, True))
    lx = T.MARGIN_X
    for name, color, count, hatched in legend:
        sw_y = hf["legend_base"] - T.LEGEND_SWATCH + 3
        fill = "url(#hatch)" if hatched else color
        stroke = (f' stroke="{T.ABSENT_OUTLINE}" stroke-width="1"' if hatched else "")
        d.add(f'<rect x="{lx:.2f}" y="{sw_y:.2f}" width="{T.LEGEND_SWATCH}" '
              f'height="{T.LEGEND_SWATCH}" rx="3" fill="{fill}"{stroke}/>')
        label = f"{name} {count}"
        w = d.text(lx + T.LEGEND_SWATCH + 9, hf["legend_base"], label, "sans",
                   T.LEGEND_SIZE, T.MUTED,
                   box=(lx + T.LEGEND_SWATCH + 9, T.W - T.MARGIN_X), tag=f"legend_{name}")
        lx += T.LEGEND_SWATCH + 9 + w + T.LEGEND_GAP

    # ---- gridlines + axis ----
    grid_top = rows_top - 10
    grid_bottom = rows_top + rowh * n + 10
    k = 0
    last_k = max_membres // step
    while step * k <= max_membres:
        gx = bars_x0 + step * k * px
        d.add(f'<line x1="{gx:.2f}" y1="{grid_top:.2f}" x2="{gx:.2f}" '
              f'y2="{grid_bottom:.2f}" stroke="{T.GRID}" stroke-width="1"/>')
        # No "0" label (the bars' left edge says it); the last tick carries the
        # unit ("120 sièges") so the axis needs no separate axis title.
        if k > 0:
            lbl = f"{step * k} sièges" if k == last_k else str(step * k)
            bw = (T.W - T.MARGIN_X) if k == last_k else (gx + step * px / 2)
            d.text(gx, axis_base, lbl, "sans", T.AXIS_SIZE, T.FAINT,
                   anchor="middle", box=(gx - step * px / 2 - 40, bw),
                   tag=f"axis_{step * k}")
        k += 1

    # ---- rows ----
    bar_h = rowh * T.BAR_RATIO
    for i, (g, lf, annot) in enumerate(zip(groups, label_fits, annots)):
        cy = rows_top + rowh * i + rowh / 2
        by = cy - bar_h / 2
        d.text(bars_x0 - T.GUTTER, cy + lf.size * 0.35, lf.text, "sans_semi", lf.size,
               T.PAPER, anchor="end", box=(T.MARGIN_X, bars_x0 - T.GUTTER),
               tag=f"label_{g.abbrev or i}")
        x = bars_x0
        segments = [(g.pour, T.POUR, False), (g.contre, T.CONTRE, False),
                    (g.abstention, T.ABSTENTION, False),
                    (g.non_votant, T.NON_VOTANT, False), (g.absent, None, True)]
        for value, color, hatched in segments:
            if value <= 0:
                continue
            w = value * px
            if hatched:
                d.add(f'<rect x="{x:.2f}" y="{by:.2f}" width="{w:.2f}" '
                      f'height="{bar_h:.2f}" fill="url(#hatch)" '
                      f'stroke="{T.ABSENT_OUTLINE}" stroke-width="1"/>')
            else:
                d.add(f'<rect x="{x:.2f}" y="{by:.2f}" width="{w:.2f}" '
                      f'height="{bar_h:.2f}" fill="{color}"/>')
            x += w
        d.text(T.W - T.MARGIN_X, cy + annot_size * 0.35, annot, "sans", annot_size,
               T.FAINT, anchor="end", box=(bars_x1 + T.GUTTER, T.W - T.MARGIN_X),
               tag=f"annot_{g.abbrev or i}")

    # ---- footer (single line; the per-group "most absent" line is removed
    #      on purpose -- see the neutrality note in the module docstring) ----
    d.add(f'<line x1="{T.MARGIN_X}" y1="{footer_rule_y}" x2="{T.W - T.MARGIN_X}" '
          f'y2="{footer_rule_y}" stroke="{T.RULE}" stroke-width="1"/>')
    src = (data["sourceUrl"] or "assemblee-nationale.fr").split("//")[-1]
    left = f"Source : {src}"
    right = "Assemblée nationale · scrutin public"
    rw = measure(right, "sans", T.FOOTER_SIZE)
    left_max = T.W - 2 * T.MARGIN_X - rw - 40
    lfit = fit_text([left], left_max, "sans",
                    T.FOOTER_SIZE, min_size=T.FOOTER_SIZE - 3)
    d.text(T.MARGIN_X, footer_base, lfit.text, "sans", lfit.size, T.FAINT,
           box=(T.MARGIN_X, T.MARGIN_X + left_max), tag="footer_left")
    d.text(T.W - T.MARGIN_X, footer_base, right, "sans", T.FOOTER_SIZE, T.FAINT,
           anchor="end", box=(T.W - T.MARGIN_X - rw - 1, T.W - T.MARGIN_X),
           tag="footer_right")

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{T.W}" height="{T.H}" '
           f'viewBox="0 0 {T.W} {T.H}">' + "".join(d.parts) + "</svg>")

    debug = {
        "groups": n, "rowh": round(rowh, 2), "bar_h": round(bar_h, 2),
        "label_col": round(label_col, 2), "annot_col": round(annot_col, 2),
        "bars_x0": round(bars_x0, 2), "bars_x1": round(bars_x1, 2),
        "px_per_seat": round(px, 4), "grid_step": step,
        "gridlines": max_membres // step + 1, "max_membres": max_membres,
        "headline_lines": len(hf["lines"]), "headline_size": hf["hsize"],
        "label_size": label_size,
        "label_strategies": {g.abbrev: f.strategy for g, f in zip(groups, label_fits)},
        "zones": {
            "chart_top": round(hf["chart_top"], 2), "rows_top": round(rows_top, 2),
            "rows_bottom": round(rows_top + rowh * n, 2),
            "chart_bottom": round(grid_bottom, 2), "legend_base": round(hf["legend_base"], 2),
            "axis_base": round(axis_base, 2), "footer_rule": footer_rule_y,
            "footer_base": footer_base,
        },
        "texts": d.texts,
    }
    return svg, debug


# -------------------------------------------------------------- rasterising ---

def content_hash(raw: dict, hero_mode: str) -> str:
    payload = json.dumps(raw, sort_keys=True, ensure_ascii=False,
                         separators=(",", ":"))
    seed = f"{T.TEMPLATE_VERSION}|{hero_mode}|{payload}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


# zlib level 6 (Pillow's default). optimize=True was measured at +245ms on the
# 4K master to save 8KB -- pointless against a 4MB budget the card uses ~10% of.
_PNG = {"compress_level": 6}


def _save_png_under(im, path: str, limit: int) -> int:
    """Save a PNG, degrading to a smaller palette only if the budget demands it.

    share.png is the clipboard/paste payload: Twitter rejects PNGs over 5MB and
    iOS Safari's clipboard chokes well before that, so this one has a hard cap.
    """
    im.save(path, "PNG", **_PNG)
    size = os.path.getsize(path)
    if size <= limit:
        return size
    for colors in (256, 192, 128, 64):
        im.convert("RGB").quantize(colors=colors, method=2, dither=1).save(
            path, "PNG", optimize=True)
        size = os.path.getsize(path)
        if size <= limit:
            return size
    raise RenderError(
        f"share.png is {size} bytes, over the {limit} byte budget even at 64 colours")


def render(raw: dict, outdir: str, hero_mode: str = "absents",
           force: bool = False, want_debug: bool = False,
           svg_only: bool = False) -> tuple[dict, dict]:
    """
    The SVG is the canonical artefact: 12 KB against ~880 KB for the raster set,
    so the whole corpus fits in ~100 MB instead of ~7 GB. Rasters are derived on
    demand (~370 ms each) and are disposable — `svg_only` writes just the source
    and reports raster sizes as null.
    """
    h = content_hash(raw, hero_mode)
    os.makedirs(outdir, exist_ok=True)

    names = {"svg": f"{h}-card.svg", "card": f"{h}-card.png",
             "share": f"{h}-share.png", "preview": f"{h}-preview.webp"}
    paths = {k: os.path.join(outdir, v) for k, v in names.items()}
    want = ["svg"] if svg_only else list(names)
    cached = all(os.path.exists(paths[k]) for k in want)

    debug: dict = {}
    if force or not cached or want_debug:
        data = normalise(raw)
        svg, debug = build_svg(data, hero_mode)

    if svg_only:
        if force or not os.path.exists(paths["svg"]):
            with open(paths["svg"], "w", encoding="utf-8") as fh:
                fh.write(svg)
        return {
            "preview": None, "share": None, "card": None,
            "svg": {"file": names["svg"], "bytes": os.path.getsize(paths["svg"])},
            "templateVersion": T.TEMPLATE_VERSION,
        }, debug

    if force or not cached:
        import cairosvg
        from PIL import Image

        # Explicit output_width/output_height -- scale= compounds rounding and
        # drifts off the exact 3840x2160 the three outputs are derived from.
        png = cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                               output_width=T.CARD_W, output_height=T.CARD_H)
        master = Image.open(io.BytesIO(png)).convert("RGB")
        # Write the SVG only once the raster succeeded, so a failed render never
        # leaves a half-populated content-addressed set behind.
        with open(paths["svg"], "w", encoding="utf-8") as fh:
            fh.write(svg)
        master.save(paths["card"], "PNG", **_PNG)
        share = master.resize((T.SHARE_W, T.SHARE_H), Image.LANCZOS)
        _save_png_under(share, paths["share"], T.SHARE_MAX_BYTES)
        preview = master.resize((T.PREVIEW_W, T.PREVIEW_H), Image.LANCZOS)
        preview.save(paths["preview"], "WEBP", quality=88, method=6)

    result = {
        "preview": {"file": names["preview"], "width": T.PREVIEW_W,
                    "height": T.PREVIEW_H, "bytes": os.path.getsize(paths["preview"])},
        "share": {"file": names["share"], "width": T.SHARE_W, "height": T.SHARE_H,
                  "bytes": os.path.getsize(paths["share"])},
        "card": {"file": names["card"], "width": T.CARD_W, "height": T.CARD_H,
                 "bytes": os.path.getsize(paths["card"])},
        "svg": {"file": names["svg"]},
        "templateVersion": T.TEMPLATE_VERSION,
    }
    return result, debug


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Render a scrutin card")
    ap.add_argument("--in", dest="infile", help="normalised scrutin payload JSON")
    ap.add_argument("--outdir", dest="outdir", help="output directory")
    ap.add_argument("--hero", default="absents", choices=HERO_MODES)
    ap.add_argument("--force", action="store_true", help="re-render even if cached")
    ap.add_argument("--svg-only", dest="svg_only", action="store_true",
                    help="write only the SVG source (rasters are derived on demand)")
    ap.add_argument("--debug-json", dest="debug_json",
                    help="write layout/text-placement debug data here")
    ap.add_argument("--selftest", action="store_true",
                    help="verify cairo resolves every registered font face")
    args = ap.parse_args(argv)

    try:
        if args.selftest:
            from fonts import verify_faces
            print(json.dumps({"fonts": verify_faces()}, ensure_ascii=False, indent=2))
            return 0
        if not args.infile or not args.outdir:
            raise RenderError("--in and --outdir are required")
        with open(args.infile, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        result, debug = render(raw, args.outdir, args.hero, args.force,
                               want_debug=bool(args.debug_json),
                               svg_only=bool(args.svg_only))
        if args.debug_json:
            with open(args.debug_json, "w", encoding="utf-8") as fh:
                json.dump(debug, fh, ensure_ascii=False, indent=1)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 -- contract: JSON error on stdout
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
