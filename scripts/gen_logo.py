"""Gera a logo do app (PNG, com anti-aliasing via SDF) a partir de formas
simples: fundo em quadrado arredondado com gradiente, mais 4 barras — as
mesmas cores de nivel de log (D/I/W/E) que o app ja usa na tabela. Sem
dependencias externas (sem Pillow), pra rodar em qualquer maquina com Python
puro.

Uso: python3 scripts/gen_logo.py
Gera build/logo-master.png (1024x1024) e variantes menores em build/.
"""

import math
import os
import struct
import zlib

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "logo")


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_rgb(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def smoothstep(edge0, edge1, x):
    t = clamp((x - edge0) / (edge1 - edge0)) if edge1 != edge0 else 0.0
    return t * t * (3 - 2 * t)


def rounded_rect_sdf(px, py, cx, cy, hw, hh, r):
    """Distancia (em px) ate a borda de um retangulo arredondado. Negativo dentro."""
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    outside = math.hypot(ax, ay) - r
    inside = min(max(dx, dy), 0.0)
    return outside + inside


class Canvas:
    def __init__(self, size):
        self.size = size
        # RGB (float 0..1) pre-multiplicado por alpha, e alpha separado.
        self.rgb = [[0.0, 0.0, 0.0] for _ in range(size * size)]
        self.a = [0.0] * (size * size)

    def blend_pixel(self, x, y, color, coverage):
        if coverage <= 0:
            return
        i = y * self.size + x
        cr, cg, cb = (c / 255.0 for c in color)
        da = self.a[i]
        out_a = coverage + da * (1 - coverage)
        if out_a <= 0:
            return
        for k, cc in enumerate((cr, cg, cb)):
            self.rgb[i][k] = (cc * coverage + self.rgb[i][k] * da * (1 - coverage)) / out_a
        self.a[i] = out_a

    def fill_shape(self, sdf_fn, color_fn, bbox, feather=1.2):
        x0, y0, x1, y1 = bbox
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(self.size, int(math.ceil(x1))), min(self.size, int(math.ceil(y1)))
        for y in range(y0, y1):
            py = y + 0.5
            for x in range(x0, x1):
                px = x + 0.5
                d = sdf_fn(px, py)
                if d > feather:
                    continue
                coverage = clamp(0.5 - d / feather)
                if coverage <= 0:
                    continue
                self.blend_pixel(x, y, color_fn(px, py), coverage)

    def to_png_bytes(self):
        size = self.size
        raw = bytearray()
        # Fundo (fora do quadrado arredondado) fica transparente: escreve RGBA.
        for y in range(size):
            raw.append(0)  # sem filtro
            for x in range(size):
                i = y * size + x
                a = self.a[i]
                r, g, b = self.rgb[i]
                raw += bytes([
                    int(clamp(r) * 255 + 0.5),
                    int(clamp(g) * 255 + 0.5),
                    int(clamp(b) * 255 + 0.5),
                    int(clamp(a) * 255 + 0.5),
                ])

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

        sig = b"\x89PNG\r\n\x1a\n"
        ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
        idat = zlib.compress(bytes(raw), 9)
        return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def build_master():
    c = Canvas(SIZE)
    cx = cy = SIZE / 2
    r = SIZE * 0.225  # cantos arredondados, no estilo "squircle" moderno
    hw = hh = SIZE / 2

    # --- fundo: gradiente diagonal, do azul-ardosia escuro (mesmo tom do
    # tema escuro do app) a um teal profundo, dando uma sensacao de
    # "terminal"/ferramenta de dev sem copiar a cor de nenhum app conhecido.
    top_left = hex_to_rgb("#1b2027")
    bottom_right = hex_to_rgb("#0d3b4a")

    def bg_sdf(px, py):
        return rounded_rect_sdf(px, py, cx, cy, hw, hh, r)

    def bg_color(px, py):
        t = clamp(((px - 0) / SIZE + (py - 0) / SIZE) / 2)
        return lerp_rgb(top_left, bottom_right, t)

    c.fill_shape(bg_sdf, bg_color, (0, 0, SIZE, SIZE), feather=2.0)

    # Brilho suave no canto superior esquerdo (glossy sutil, sem ficar
    # skeuomorfico) - um radial simples, so mais claro por cima do gradiente.
    glow_center = (SIZE * 0.30, SIZE * 0.26)
    glow_r = SIZE * 0.55

    def glow_sdf(px, py):
        return math.hypot(px - glow_center[0], py - glow_center[1]) - glow_r

    def glow_color(px, py):
        d = math.hypot(px - glow_center[0], py - glow_center[1]) / glow_r
        t = clamp(1 - d)
        # so aclara um pouco, nao pinta branco solido
        return lerp_rgb(bg_color(px, py), (255, 255, 255), 0.10 * t)

    # Aplica o glow so dentro do quadrado (reaproveita a mascara do fundo).
    x0, y0, x1, y1 = (0, 0, SIZE, SIZE)
    for y in range(y0, y1):
        py = y + 0.5
        for x in range(x0, x1):
            px = x + 0.5
            if rounded_rect_sdf(px, py, cx, cy, hw, hh, r) > 0.5:
                continue
            d = math.hypot(px - glow_center[0], py - glow_center[1]) / glow_r
            t = clamp(1 - d) ** 1.6
            if t <= 0.002:
                continue
            base = bg_color(px, py)
            col = lerp_rgb(base, (255, 255, 255), 0.14 * t)
            c.blend_pixel(x, y, tuple(int(v) for v in col), 1.0)

    # --- barras de log: as mesmas cores de nivel do tema escuro do app
    # (D azul, I verde, W ambar, E vermelho), decrescentes em largura, como
    # um trecho de log real. E o elemento que faz a logo dizer "log viewer"
    # de longe, sem precisar de texto.
    bars = [
        ("#5c9ded", 0.62),  # D
        ("#62c462", 0.50),  # I
        ("#f0a44a", 0.40),  # W
        ("#ff6b6b", 0.30),  # E
    ]
    bar_h = SIZE * 0.072
    gap = SIZE * 0.045
    total_h = len(bars) * bar_h + (len(bars) - 1) * gap
    start_y = cy - total_h / 2 + bar_h / 2
    left_x = SIZE * 0.235

    for idx, (color_hex, width_frac) in enumerate(bars):
        color = hex_to_rgb(color_hex)
        by = start_y + idx * (bar_h + gap)
        bw = (SIZE * 0.53) * width_frac / 0.62  # normaliza pela mais larga
        bx = left_x + bw / 2
        bhw, bhh = bw / 2, bar_h / 2
        rad = bhh  # pill: raio = metade da altura

        def sdf(px, py, bx=bx, by=by, bhw=bhw, bhh=bhh, rad=rad):
            return rounded_rect_sdf(px, py, bx, by, bhw, bhh, rad)

        def col_fn(px, py, color=color):
            return color

        pad = 3
        c.fill_shape(sdf, col_fn,
                     (bx - bhw - pad, by - bhh - pad, bx + bhw + pad, by + bhh + pad),
                     feather=1.3)

    return c


def downsample(png_bytes_src_canvas, target):
    """Reduz por media de blocos (box filter) a partir do Canvas em memoria —
    da resultado bem mais limpo que so redimensionar o PNG depois."""
    src = png_bytes_src_canvas
    size = src.size
    factor = size / target
    out = Canvas(target)
    for ty in range(target):
        y0 = int(ty * factor)
        y1 = max(y0 + 1, int((ty + 1) * factor))
        for tx in range(target):
            x0 = int(tx * factor)
            x1 = max(x0 + 1, int((tx + 1) * factor))
            rs = gs = bs = as_ = 0.0
            n = 0
            for yy in range(y0, min(y1, size)):
                base = yy * size
                for xx in range(x0, min(x1, size)):
                    i = base + xx
                    a = src.a[i]
                    rs += src.rgb[i][0] * a
                    gs += src.rgb[i][1] * a
                    bs += src.rgb[i][2] * a
                    as_ += a
                    n += 1
            if n == 0:
                continue
            avg_a = as_ / n
            if avg_a > 1e-6:
                out.rgb[ty * target + tx] = [rs / n / avg_a, gs / n / avg_a, bs / n / avg_a]
            out.a[ty * target + tx] = avg_a
    return out


def write_png(canvas, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(canvas.to_png_bytes())


def main():
    master = build_master()
    write_png(master, os.path.join(OUT_DIR, "logo-1024.png"))
    for size in (512, 256, 180, 128, 64, 48, 32, 16):
        small = downsample(master, size)
        write_png(small, os.path.join(OUT_DIR, f"logo-{size}.png"))
    print("ok:", OUT_DIR)


if __name__ == "__main__":
    main()
