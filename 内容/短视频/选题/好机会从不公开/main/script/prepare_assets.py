import json
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTCollection
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[4]
FONT_PATH = Path("/System/Library/Fonts/Hiragino Sans GB.ttc")
FACE_INDEX = 2
LOGO_SRC = REPO / "meta/logo/build/logo@3x.png"
TEXT = sys.argv[1]
FONT_SIZE = float(sys.argv[2])
LOGO_WIDTH = int(sys.argv[3])

font = TTCollection(str(FONT_PATH)).fonts[FACE_INDEX]
cmap = font.getBestCmap()
hmtx = font["hmtx"]
upem = font["head"].unitsPerEm
ascent = font["hhea"].ascent
descent = font["hhea"].descent
line_box = FONT_SIZE * (ascent - descent) / upem

widths = {}
for ch in sorted(set(TEXT)):
    glyph = cmap.get(ord(ch))
    if glyph is None:
        widths[ch] = FONT_SIZE
        continue
    widths[ch] = hmtx[glyph][0] / upem * FONT_SIZE

options = Options()
options.layout_features = ["*"]
options.name_IDs = ["*"]
options.notdef_outline = True
subsetter = Subsetter(options=options)
subsetter.populate(text=TEXT)
subsetter.subset(font)
font_dir = ROOT / "asset" / "font"
font_dir.mkdir(parents=True, exist_ok=True)
font_out = font_dir / "HiraginoSansGB-W6.otf"
font.save(str(font_out))

image = Image.open(LOGO_SRC).convert("RGBA")
cropped = image.crop(image.getbbox())
height = max(1, round(cropped.height * (LOGO_WIDTH / cropped.width)))
resized = cropped.resize((LOGO_WIDTH, height), Image.Resampling.LANCZOS)
logo_out = ROOT / "asset" / "logo.png"
resized.save(logo_out)

json.dump(
    {
        "widths": widths,
        "lineBox": line_box,
        "logoHeight": height,
        "font": "asset/font/HiraginoSansGB-W6.otf",
    },
    sys.stdout,
    ensure_ascii=False,
)
