"""Visual theme + layout constants for the scrutin card.

House style (established chart look):
  dark navy vertical gradient, IBM Plex Serif titles, Inter body,
  pour / contre / abstention / non-votants / absents (hatched).

Bump TEMPLATE_VERSION whenever anything here or in render_card.py changes the
pixels: it is mixed into the content hash, so old files stay valid under
`immutable` caching and new renders land on new URLs.
"""

TEMPLATE_VERSION = "2.0.1"

# ---------------------------------------------------------------- palette ---
BG_TOP = "#ffffff"
BG_BOTTOM = "#ffffff"
PAPER = "#1c1a16"        # primary text (ink) on light paper
MUTED = "#6b6456"
FAINT = "#9a9384"

POUR = "#00897b"          # teal encre — pôle "pour", non partisan
CONTRE = "#9e3a25"        # brique/rouille — pôle "contre", pas le rouge politique
ABSTENTION = "#b07f1e"    # ocre foncé
NON_VOTANT = "#b8b2a4"    # gris papier (liseré obligatoire)
ADOPTED = "#00897b"       # chip = couleur du camp vainqueur (pour), jamais vert=jugement

HATCH_STROKE = "rgba(28,26,22,0.30)"
ABSENT_OUTLINE = "rgba(28,26,22,0.28)"
GRID = "rgba(28,26,22,0.07)"
RULE = "rgba(28,26,22,0.14)"

TRICOLOUR = ("#0055A4", "#FFFFFF", "#EF4135")  # vrai drapeau FR

# ----------------------------------------------------------------- canvas ---
# Everything is authored in this logical space and rasterised up.
W = 1920
H = 1080

MARGIN_X = 88
MARGIN_TOP = 60
MARGIN_BOTTOM = 52

# -------------------------------------------------------------- typography ---
EYEBROW_SIZE = 16
EYEBROW_LS = 3.2

HEADLINE_MAX = 64
HEADLINE_MIN = 40
HEADLINE_LINES = 3
HEADLINE_LEADING = 1.10

SUBTITLE_SIZE = 21
CHIP_SIZE = 24
CHIP_H = 48

HERO_NUM_SIZE = 76
HERO_LABEL_SIZE = 17
HERO_LABEL_LS = 1.8

LEGEND_SIZE = 18
LEGEND_SWATCH = 16
LEGEND_GAP = 34

AXIS_SIZE = 15
AXIS_BLOCK = 44  # vertical strip reserved under the rows for the seat scale
FOOTER_SIZE = 17

# ------------------------------------------------------------------ chart ---
ROW_H_MAX = 42
BAR_RATIO = 0.40
LABEL_COL_MAX = 300
LABEL_SIZE_MAX = 21
LABEL_SIZE_MIN = 12
LABEL_SHRINK = 6  # max px the fit ladder may shave off a label
ANNOT_SIZE_MAX = 15
ANNOT_SIZE_MIN = 11
ANNOT_COL_MAX = 210
GUTTER = 20

# Gridline steps, coarsest-last. The renderer picks the first step that keeps
# the gridline count <= MAX_GRIDLINES for the actual largest group.
GRID_STEPS = (1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500)
MAX_GRIDLINES = 8

# ------------------------------------------------------- half-ring (hémicycle) ---
RING_R = 150
RING_SW = 44
RING_CX = 1652
RING_CY = 330
RING_COL = 360   # largeur réservée au bloc anneau à droite du header

# ----------------------------------------------------------------- output ---
CARD_W, CARD_H = 3840, 2160
SHARE_W, SHARE_H = 2048, 1152
PREVIEW_W, PREVIEW_H = 1280, 720
SHARE_MAX_BYTES = 4 * 1024 * 1024
