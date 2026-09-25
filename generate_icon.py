"""Build the static home-screen PNG icon from the app's simple geometric motif."""

from pathlib import Path
from PIL import Image, ImageDraw


SIZE = 512
SCALE = 2
im = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), "#dff1f2")
d = ImageDraw.Draw(im)


def box(points):
    return tuple(int(value * SCALE) for value in points)


d.ellipse(box((290, 16, 498, 224)), fill="#eef7e9")
d.ellipse(box((9, 305, 209, 505)), fill="#fff1e5")
d.arc(box((161, 100, 335, 274)), 180, 360, fill="#2f7180", width=19 * SCALE)
d.rounded_rectangle(box((127, 177, 369, 425)), radius=28 * SCALE, fill="#fffefa", outline="#2f7180", width=17 * SCALE)
d.line(box((193, 176, 302, 176)), fill="#2f7180", width=18 * SCALE)
d.ellipse(box((188, 223, 316, 351)), fill="#f7dfaa", outline="#ceaa6c", width=7 * SCALE)
star = [(252, 245), (261, 273), (290, 274), (267, 291), (275, 319), (252, 302), (228, 319), (236, 291), (214, 274), (243, 273)]
d.polygon([(x * SCALE, y * SCALE) for x, y in star], fill="#c6904f")
d.ellipse(box((337, 132, 369, 164)), fill="#e9a99c")
d.polygon([(x * SCALE, y * SCALE) for x, y in [(80, 142), (85, 154), (98, 159), (85, 164), (80, 176), (75, 164), (62, 159), (75, 154)]], fill="#e9a99c")

im.resize((SIZE, SIZE), Image.Resampling.LANCZOS).convert("RGB").save(Path(__file__).with_name("icon.png"), optimize=True)
