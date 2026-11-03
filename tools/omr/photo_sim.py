#!/usr/bin/env python3
"""Realistic phone-photo / scan simulation for OMR training & evaluation.

simulate(page, gt, rng, profile) turns a clean rendered page (float32 grey,
255 = paper) plus its ground truth (page-pixel coordinates) into a colour
photo (uint8 BGR, JPEG-compressed) and the same ground truth mapped into
photo coordinates.  Every geometric effect is one analytic forward map
page(s, t) -> photo(u, v), so ground truth is exact; the image is rendered
through the numerically inverted map (Newton on a coarse grid).

Geometry : 3-D page surface (book curl at the spine, bow, low-frequency
           waves) seen by a pinhole camera with tilt / roll, placed in the
           frame with background around it or with its margins cropped.
Page look: paper tint + texture, ink colour / density, stroke weight,
           show-through of the reverse side, pencil marks.
Light    : shading from the surface normal (gutter shadow), gradients,
           vignetting, soft cast shadows (hand / phone), glare, white balance.
Optics   : defocus (optionally varying across the page), motion blur.
Sensor   : low resolution, noise, sharpening halos, JPEG (+ re-compression).

Profiles: 'scan' (flatbed / copier), 'flat' (sheet on a table),
'curl' (book or curled sheet), 'hard' (low-res, blurry, dark, messenger-
compressed).  sample_profile(rng, kind) draws the parameters.
"""
import math
import cv2
import numpy as np

PROFILES = ['scan', 'flat', 'curl', 'hard']
# FAST = True: cheaper noise / texture synthesis (float32, reduced-resolution
# textures).  Same distributions, different random streams — used for the
# training split; the fixed eval / dev splits were generated with FAST = False.
FAST = False


# ----------------------------------------------------------------------------
# parameter sampling
# ----------------------------------------------------------------------------
def sample_profile(rng, kind):
    U = rng.uniform
    p = {'kind': kind}
    if kind == 'scan':
        p.update(sp=U(10, 20), roll=U(-1.5, 1.5), tilt=0.0, tiltAxis=0.0, focal=3.0,
                 curl=None, bow=0.0, wave=U(0, 0.0008), fill=U(0.92, 1.04),
                 blur=U(0.01, 0.05), blurVar=0.0, motion=0.0, noise=U(0.5, 2.5),
                 jpeg=int(U(80, 96)) if rng.random() < 0.7 else None, sharpen=U(0, 0.3),
                 lowres=1.0, gradient=U(0, 0.06), vignette=U(0, 0.05), shadows=0,
                 glare=0.0, wb=0.02, binarized=rng.random() < 0.12)
    elif kind == 'flat':
        p.update(sp=U(9, 22), roll=U(-7, 7), tilt=U(0, 16), tiltAxis=U(0, 360), focal=U(0.9, 1.4),
                 curl=None, bow=U(0, 0.025) * rng.choice([-1, 1]) if rng.random() < 0.5 else 0.0,
                 wave=U(0, 0.004), fill=U(0.78, 1.06),
                 blur=U(0.02, 0.09), blurVar=U(0, 0.06), motion=U(0, 0.15) if rng.random() < 0.3 else 0.0,
                 noise=U(1, 5), jpeg=int(U(55, 93)), sharpen=U(0, 1.0), lowres=1.0,
                 gradient=U(0.05, 0.35), vignette=U(0.05, 0.35), shadows=rng.choice([0, 0, 1, 1, 2]),
                 glare=U(0.2, 0.6) if rng.random() < 0.15 else 0.0, wb=0.08, binarized=False)
    elif kind == 'curl':
        p.update(sp=U(9, 20), roll=U(-5, 5), tilt=U(0, 14), tiltAxis=U(0, 360), focal=U(0.9, 1.3),
                 curl={'side': rng.choice(['left', 'right']), 'height': U(0.03, 0.10), 'length': U(0.10, 0.28),
                       'outer': U(0, 0.03) if rng.random() < 0.4 else 0.0},
                 bow=U(0, 0.02) * rng.choice([-1, 1]) if rng.random() < 0.3 else 0.0,
                 wave=U(0.001, 0.006), fill=U(0.8, 1.05),
                 blur=U(0.02, 0.09), blurVar=U(0.02, 0.08), motion=U(0, 0.12) if rng.random() < 0.25 else 0.0,
                 noise=U(1, 5), jpeg=int(U(55, 92)), sharpen=U(0, 0.9), lowres=1.0,
                 gradient=U(0.05, 0.35), vignette=U(0.05, 0.35), shadows=rng.choice([0, 1, 1, 2]),
                 glare=U(0.2, 0.5) if rng.random() < 0.12 else 0.0, wb=0.08, binarized=False)
    elif kind == 'hard':
        p.update(sp=U(6.5, 10.5), roll=U(-9, 9), tilt=U(4, 22), tiltAxis=U(0, 360), focal=U(0.8, 1.2),
                 curl={'side': rng.choice(['left', 'right']), 'height': U(0.02, 0.08), 'length': U(0.10, 0.25), 'outer': 0.0}
                 if rng.random() < 0.4 else None,
                 bow=U(0, 0.025) * rng.choice([-1, 1]) if rng.random() < 0.4 else 0.0,
                 wave=U(0.001, 0.006), fill=U(0.75, 1.05),
                 blur=U(0.06, 0.15), blurVar=U(0, 0.08), motion=U(0.05, 0.25) if rng.random() < 0.5 else 0.0,
                 noise=U(3, 9), jpeg=int(U(30, 65)), sharpen=U(0, 1.2), lowres=U(0.55, 1.0) if rng.random() < 0.5 else 1.0,
                 gradient=U(0.1, 0.45), vignette=U(0.1, 0.45), shadows=rng.choice([0, 1, 2, 2]),
                 glare=U(0.2, 0.6) if rng.random() < 0.2 else 0.0, wb=0.12, binarized=False)
    else:
        raise ValueError(kind)
    # page appearance (shared)
    p.update(paper=paper_colour(rng), ink=ink_colour(rng), inkDensity=U(0.8, 1.0), inkMottle=U(0, 0.15),
             weight=U(-0.25, 0.45), showThrough=U(0.04, 0.14) if rng.random() < 0.3 else 0.0,
             pencil=rng.random() < 0.15, portrait=rng.random() < 0.85, background=background_spec(rng),
             secondJpeg=int(U(70, 88)) if (kind != 'scan' and rng.random() < 0.25) else None)
    return p


def paper_colour(rng):
    base = rng.uniform(222, 252)
    tint = rng.choice([(1.0, 1.0, 1.0), (1.0, 0.985, 0.94), (1.0, 0.97, 0.90), (0.98, 0.99, 1.0), (0.99, 0.99, 0.97)])
    return [base * t for t in tint]


def ink_colour(rng):
    v = rng.uniform(8, 70)
    return [v * rng.uniform(0.9, 1.1), v * rng.uniform(0.9, 1.1), v * rng.uniform(0.9, 1.15)]


def background_spec(rng):
    kind = rng.choice(['wood', 'dark', 'light', 'fabric', 'grey'])
    col = {'wood': (rng.uniform(90, 150), rng.uniform(60, 100), rng.uniform(30, 60)),
           'dark': (rng.uniform(20, 60),) * 3, 'light': (rng.uniform(170, 220),) * 3,
           'fabric': (rng.uniform(40, 140), rng.uniform(40, 140), rng.uniform(40, 140)),
           'grey': (rng.uniform(90, 160),) * 3}[kind]
    return {'kind': kind, 'rgb': list(col)}


# ----------------------------------------------------------------------------
# geometry: page surface + camera
# ----------------------------------------------------------------------------
class Geometry:
    """Forward map page (s, t) [page px] -> photo (u, v) [photo px]."""

    def __init__(self, Wp, Hp, prof, rng):
        self.Wp, self.Hp, self.p = Wp, Hp, prof
        diag = math.hypot(Wp, Hp)
        # --- curl profile along s (arc length) -> (X, Z) -------------------------
        n = 2049
        Xg = np.linspace(-0.6 * Wp, 1.6 * Wp, n)
        Zg = np.zeros(n)
        c = prof.get('curl')
        if c:
            d = Xg if c['side'] == 'left' else Wp - Xg       # distance from the spine edge
            L = c['length'] * Wp
            Zg += c['height'] * Wp * (1 - np.exp(-np.maximum(d, 0) / L)) + c['height'] * Wp * np.minimum(d, 0) / L
            if c.get('outer'):
                e = (Wp - Xg) if c['side'] == 'left' else Xg  # distance from the outer edge
                Zg += c['outer'] * Wp * np.exp(-np.maximum(e, 0) / (0.12 * Wp))
        if prof.get('bow'):
            Zg += prof['bow'] * Wp * (1 - ((Xg - Wp / 2) / (Wp / 2)) ** 2)
        dZ = np.gradient(Zg, Xg)
        S = np.concatenate([[0], np.cumsum(np.sqrt(1 + dZ[1:] ** 2) * np.diff(Xg))])
        # arc length s is the flat-page coordinate; s == X at the page centre
        S = S - np.interp(Wp / 2, Xg, S) + Wp / 2
        self._S, self._X, self._Z = S, Xg, Zg
        self._dZdX = dZ
        # --- low-frequency waves --------------------------------------------------
        self.waves = []
        if prof.get('wave'):
            for _ in range(3):
                self.waves.append((prof['wave'] * Wp * rng.uniform(0.3, 1.0), rng.uniform(0.6, 2.5) / Wp, rng.uniform(0.3, 2.0) / Hp,
                                   rng.uniform(0, 2 * math.pi), rng.uniform(0, 2 * math.pi)))
        # --- camera ---------------------------------------------------------------------
        self.D = prof.get('focal', 1.0) * diag * 1.15            # camera distance (page px)
        tilt = math.radians(prof.get('tilt', 0.0))
        ax = math.radians(prof.get('tiltAxis', 0.0))
        roll = math.radians(prof.get('roll', 0.0))
        k = np.array([math.cos(ax), math.sin(ax), 0.0])         # tilt axis in the page plane
        K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
        Rt = np.eye(3) + math.sin(tilt) * K + (1 - math.cos(tilt)) * K @ K
        Rr = np.array([[math.cos(roll), -math.sin(roll), 0], [math.sin(roll), math.cos(roll), 0], [0, 0, 1]])
        self.R = Rr @ Rt
        self.f = self.D                                          # unit magnification at the page centre
        self.a, self.bu, self.bv = 1.0, 0.0, 0.0                 # final affine (set by place())

    def surface(self, s, t):
        X = np.interp(s, self._S, self._X)
        Z = np.interp(s, self._S, self._Z)
        for A, fx, fy, px, py in self.waves:
            Z = Z + A * np.sin(2 * math.pi * fx * s + px) * np.cos(2 * math.pi * fy * t + py)
        return X, t, Z

    def project(self, s, t):
        X, Y, Z = self.surface(np.asarray(s, np.float64), np.asarray(t, np.float64))
        P = np.stack([X - self.Wp / 2, Y - self.Hp / 2, Z], axis=-1) @ self.R.T
        depth = self.D - P[..., 2]
        u = self.f * P[..., 0] / depth
        v = self.f * P[..., 1] / depth
        return u, v

    def forward(self, s, t):
        u, v = self.project(s, t)
        return self.a * u + self.bu, self.a * v + self.bv

    def forward_pts(self, pts):
        pts = np.asarray(pts, np.float64).reshape(-1, 2)
        u, v = self.forward(pts[:, 0], pts[:, 1])
        return np.stack([u, v], axis=1)

    def shading(self, s_grid, light):
        """Lambertian factor along s (curl only), normalised to 1 for a flat page."""
        dz = np.interp(s_grid, self._S, self._dZdX)
        n = np.stack([-dz, np.zeros_like(dz), np.ones_like(dz)], -1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        L = np.asarray(light, np.float64); L /= np.linalg.norm(L)
        amb = 0.35
        val = amb + (1 - amb) * np.clip(n @ L, 0, 1)
        return val / (amb + (1 - amb) * L[2])

    def inverse(self, U, V, iters=6):
        """Photo (u, v) -> page (s, t) by Newton iterations from a homography guess."""
        sh = U.shape
        U = U.ravel().astype(np.float64); V = V.ravel().astype(np.float64)
        gs, gt = np.meshgrid(np.linspace(0, self.Wp, 9), np.linspace(0, self.Hp, 9))
        fu, fv = self.forward(gs.ravel(), gt.ravel())
        Hm, _ = cv2.findHomography(np.stack([fu, fv], 1).astype(np.float32), np.stack([gs.ravel(), gt.ravel()], 1).astype(np.float32))
        p = cv2.perspectiveTransform(np.stack([U, V], 1).reshape(-1, 1, 2), Hm).reshape(-1, 2)
        s, t = p[:, 0].copy(), p[:, 1].copy()
        lo_s, hi_s, lo_t, hi_t = -0.5 * self.Wp, 1.5 * self.Wp, -0.5 * self.Hp, 1.5 * self.Hp
        for _ in range(iters):
            s = np.clip(s, lo_s, hi_s); t = np.clip(t, lo_t, hi_t)
            u0, v0 = self.forward(s, t)
            us, vs = self.forward(s + 1.0, t)
            ut, vt = self.forward(s, t + 1.0)
            a, b, c, d = us - u0, ut - u0, vs - v0, vt - v0
            det = a * d - b * c
            det = np.where(np.abs(det) < 1e-9, 1e-9, det)
            ru, rv = U - u0, V - v0
            s = s + (d * ru - b * rv) / det
            t = t + (-c * ru + a * rv) / det
        u0, v0 = self.forward(s, t)
        err = np.hypot(U - u0, V - v0)
        return s.reshape(sh), t.reshape(sh), err.reshape(sh)


def local_staff_spacing(geo, gt):
    """Median staff space (photo px) over all GT staves, sampled along the staff."""
    vals = []
    for sysd in gt['systems']:
        for st in sysd['staves']:
            l0, l4 = np.asarray(st['lines'][0], float), np.asarray(st['lines'][4], float)
            xs = np.linspace(max(l0[0, 0], l4[0, 0]), min(l0[-1, 0], l4[-1, 0]), 9)
            y0 = np.interp(xs, l0[:, 0], l0[:, 1]); y4 = np.interp(xs, l4[:, 0], l4[:, 1])
            a = geo.forward_pts(np.stack([xs, y0], 1)); b = geo.forward_pts(np.stack([xs, y4], 1))
            vals += list(np.hypot(*(b - a).T) / 4)
    return float(np.median(vals)) if vals else 1.0


def content_points(gt, sp):
    """Points that must stay visible: staff line ends and every symbol box."""
    pts = []
    for sysd in gt['systems']:
        for st in sysd['staves']:
            for line in (st['lines'][0], st['lines'][4]):
                for x, y in line:
                    pts += [(x, y - 3 * sp * (line is st['lines'][0])), (x, y + 3 * sp * (line is st['lines'][4]))]
    for m in gt['measures']:
        for evs in m['staves']:
            for ev in evs:
                b = ev.get('bbox')
                if b:
                    pts += [(b[0], b[1]), (b[0] + b[2], b[1] + b[3])]
    return np.asarray(pts, np.float64)


def place(geo, gt, prof, rng, sp_page):
    """Choose the photo scale (target staff space) and frame; returns (Wf, Hf)."""
    geo.a, geo.bu, geo.bv = 1.0, 0.0, 0.0
    sp0 = local_staff_spacing(geo, gt)
    geo.a = prof['sp'] / sp0
    # page outline in photo coords (unshifted)
    ss = np.concatenate([np.linspace(0, geo.Wp, 40), np.full(40, geo.Wp), np.linspace(geo.Wp, 0, 40), np.zeros(40)])
    tt = np.concatenate([np.zeros(40), np.linspace(0, geo.Hp, 40), np.full(40, geo.Hp), np.linspace(geo.Hp, 0, 40)])
    pu, pv = geo.forward(ss, tt)
    cpts = geo.forward_pts(content_points(gt, sp_page))
    pw, ph = pu.max() - pu.min(), pv.max() - pv.min()
    fill = prof['fill']
    if prof.get('portrait', True):
        Hf = ph / fill; Wf = Hf * 0.75
        if Wf < pw / fill:
            Wf = pw / fill; Hf = Wf / 0.75
    else:
        Wf = pw / fill; Hf = Wf * 0.75
        if Hf < ph / fill:
            Hf = ph / fill; Wf = Hf / 0.75
    # the frame must contain all content (+ a small margin)
    cw, ch = cpts[:, 0].max() - cpts[:, 0].min(), cpts[:, 1].max() - cpts[:, 1].min()
    mgn = 2.0 * prof['sp']
    Wf, Hf = max(Wf, cw + 2 * mgn), max(Hf, ch + 2 * mgn)
    # position: random but content inside
    cu0, cu1 = cpts[:, 0].min() - mgn, cpts[:, 0].max() + mgn
    cv0, cv1 = cpts[:, 1].min() - mgn, cpts[:, 1].max() + mgn
    pc_u, pc_v = (pu.min() + pu.max()) / 2, (pv.min() + pv.max()) / 2
    lo_u, hi_u = cu1 - Wf, cu0                 # frame left edge range keeping content inside
    lo_v, hi_v = cv1 - Hf, cv0
    left = np.clip(pc_u - Wf / 2 + rng.uniform(-0.04, 0.04) * Wf, lo_u, hi_u)
    top = np.clip(pc_v - Hf / 2 + rng.uniform(-0.04, 0.04) * Hf, lo_v, hi_v)
    geo.bu, geo.bv = -left, -top
    # cap the frame size (app downscales to 3200 px max side anyway)
    return int(math.ceil(Wf)), int(math.ceil(Hf))


# ----------------------------------------------------------------------------
# page appearance
# ----------------------------------------------------------------------------
def lowfreq_noise(rng, h, w, scale, octaves=3):
    if FAST:
        # synthesise at 1/4 resolution, upsample once
        hs, ws = max(2, h // 4), max(2, w // 4)
        small = np.zeros((hs, ws), np.float32)
        amp, sc = 1.0, scale / 4
        for o in range(octaves):
            gh, gw = max(2, int(hs / sc) + 2), max(2, int(ws / sc) + 2)
            g = rng_np(rng).standard_normal((gh, gw), dtype=np.float32)
            small += amp * cv2.resize(g, (ws, hs), interpolation=cv2.INTER_CUBIC)
            sc /= 2.0; amp *= 0.5
        out = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
        return out / (np.abs(out).max() + 1e-6)
    out = np.zeros((h, w), np.float32)
    amp = 1.0
    for o in range(octaves):
        gh, gw = max(2, int(h / scale) + 2), max(2, int(w / scale) + 2)
        g = rng_np(rng).standard_normal((gh, gw)).astype(np.float32)
        out += amp * cv2.resize(g, (w, h), interpolation=cv2.INTER_CUBIC)
        scale /= 2.0; amp *= 0.5
    return out / (np.abs(out).max() + 1e-6)


def rng_np(rng):
    return np.random.default_rng(rng.randrange(1 << 31))


def page_appearance(page, prof, rng, back=None, geo=None, s_scale=1.0):
    """Clean grey page -> RGB float page (0..255) with paper, ink, show-through."""
    H, W = page.shape
    a = (255.0 - page) / 255.0                                   # ink coverage
    if prof['weight']:
        # bolder (k > 0) / thinner (k < 0) print: blur, then stretch or cut the edges
        k = prof['weight']
        ab = cv2.GaussianBlur(a, (0, 0), 0.7)
        if k > 0:
            a = np.clip(ab * (1 + 2 * k), 0, 1)
        else:
            c = -k * 0.5
            a = np.clip((ab - c) / (1 - c), 0, 1)
        a = a.astype(np.float32)
    dens = prof['inkDensity'] * (1 - prof['inkMottle'] * (0.5 + 0.5 * lowfreq_noise(rng, H, W, 120)))
    a = a * dens.astype(np.float32)
    if prof.get('pencil'):
        a = np.maximum(a, pencil_marks(rng, H, W))
    paper = np.array(prof['paper'], np.float32)[::-1]            # BGR
    ink = np.array(prof['ink'], np.float32)[::-1]
    grain = rng_np(rng).standard_normal((H, W), dtype=np.float32) if FAST else rng_np(rng).standard_normal((H, W)).astype(np.float32)
    tex = 1 + 0.025 * lowfreq_noise(rng, H, W, 200) + 0.01 * grain
    img = (paper[None, None, :] * tex[..., None]) * (1 - a[..., None]) + ink[None, None, :] * a[..., None]
    if prof['showThrough'] and back is not None:
        b = cv2.resize(back, (W, H))[:, ::-1]
        b = cv2.GaussianBlur((255.0 - b) / 255.0, (0, 0), 2.5)
        img *= (1 - prof['showThrough'] * b)[..., None]
    if geo is not None and (geo.p.get('curl') or geo.p.get('bow')):
        light = [rng.uniform(-0.6, 0.6), rng.uniform(-0.4, 0.4), 1.0]
        shade = geo.shading(np.arange(W, dtype=np.float64) / s_scale, light).astype(np.float32)
        img *= shade[None, :, None]
    return img


def pencil_marks(rng, H, W):
    m = np.zeros((H, W), np.uint8)
    for _ in range(rng.randint(1, 5)):
        x, y = rng.uniform(0.1, 0.9) * W, rng.uniform(0.1, 0.9) * H
        r = rng.uniform(0.01, 0.03) * W
        if rng.random() < 0.5:
            cv2.ellipse(m, (int(x), int(y)), (int(r), int(r * rng.uniform(0.5, 1))), rng.uniform(0, 180), 0, 330, 255, max(1, int(W / 900)))
        else:
            pts = np.cumsum(np.array([[x, y]] + [[rng.uniform(-1, 1) * r, rng.uniform(-1, 1) * r] for _ in range(4)]), 0).astype(np.int32)
            cv2.polylines(m, [pts], False, 255, max(1, int(W / 900)))
    return cv2.GaussianBlur(m.astype(np.float32) / 255.0 * rng.uniform(0.25, 0.5), (0, 0), 1.0)


def background(rng, Hf, Wf, spec):
    if FAST:
        small = _background(rng, max(2, Hf // 4), max(2, Wf // 4), spec)
        return cv2.resize(small, (Wf, Hf), interpolation=cv2.INTER_LINEAR)
    return _background(rng, Hf, Wf, spec)


def _background(rng, Hf, Wf, spec):
    col = np.array(spec['rgb'], np.float32)[::-1]
    n = lowfreq_noise(rng, Hf, Wf, max(Hf, Wf) / 6)
    img = col[None, None, :] * (1 + 0.12 * n[..., None])
    if spec['kind'] == 'wood':
        ys = np.arange(Hf, dtype=np.float32)[:, None]
        stripes = np.sin(ys / rng.uniform(8, 25) + 3 * lowfreq_noise(rng, Hf, Wf, Wf / 3)) * 0.08
        img *= (1 + stripes[..., None])
    img += rng_np(rng).normal(0, 3, img.shape).astype(np.float32)
    return img


# ----------------------------------------------------------------------------
# main entry
# ----------------------------------------------------------------------------
def simulate(page, gt, rng, prof, back=None, max_side=3200):
    """Returns (photo uint8 BGR, gt_photo dict, jpeg_quality or None)."""
    Hp, Wp = page.shape
    sp_page = gt['staffSpace']
    geo = Geometry(Wp, Hp, prof, rng)
    Wf, Hf = place(geo, gt, prof, rng, sp_page)
    if max(Wf, Hf) > max_side:                  # keep within the app's limit
        k = max_side / max(Wf, Hf)
        geo.a *= k; geo.bu *= k; geo.bv *= k
        Wf, Hf = int(Wf * k), int(Hf * k)
        prof = dict(prof, sp=prof['sp'] * k)
    sp_photo = prof['sp']
    # --- appearance on the page, pre-scaled close to the photo resolution ---------
    scale0 = min(1.0, geo.a * 1.15)
    if FAST and scale0 < 0.98:
        # appearance at the pre-scaled resolution (cheaper; textures are resolution independent enough)
        small = cv2.resize(page, (max(1, int(Wp * scale0)), max(1, int(Hp * scale0))), interpolation=cv2.INTER_AREA)
        rgb = page_appearance(small, prof, rng, back, geo, s_scale=small.shape[1] / Wp)
    else:
        rgb = page_appearance(page, prof, rng, back, geo)
        if scale0 < 0.98:
            rgb = cv2.resize(rgb, (max(1, int(Wp * scale0)), max(1, int(Hp * scale0))), interpolation=cv2.INTER_AREA)
    sx0, sy0 = rgb.shape[1] / Wp, rgb.shape[0] / Hp
    # --- inverse map on a coarse grid -------------------------------------------------
    step = 8
    gu, gv = np.meshgrid(np.arange(0, Wf + step, step, dtype=np.float64), np.arange(0, Hf + step, step, dtype=np.float64))
    s, t, err = geo.inverse(gu, gv)
    # coarse sample (i, j) sits at photo pixel (j*step, i*step): bilinear upsampling
    mapx = cv2.remap((s * sx0).astype(np.float32), *_grid_coords(Wf, Hf, step), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    mapy = cv2.remap((t * sy0).astype(np.float32), *_grid_coords(Wf, Hf, step), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    photo = cv2.remap(rgb, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    mask = cv2.remap(np.ones((rgb.shape[0], rgb.shape[1]), np.float32), mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    bg = background(rng, Hf, Wf, prof['background'])
    # contact shadow of the page on the background
    sh = 1 - 0.35 * np.clip(cv2.GaussianBlur(mask, (0, 0), max(2, 0.01 * Wf)) - mask, 0, 1)
    photo = photo * mask[..., None] + bg * (1 - mask[..., None]) * sh[..., None]
    del rgb, bg, sh
    # --- lighting -------------------------------------------------------------------------
    photo = lighting(photo, prof, rng)
    # --- optics ---------------------------------------------------------------------------
    photo = optics(photo, prof, rng, sp_photo)
    # --- sensor ---------------------------------------------------------------------------
    photo, quality = sensor(photo, prof, rng)
    gt_out = map_gt(gt, geo, Wf, Hf, sp_page, sp_photo)
    return photo, gt_out, quality, geo


def _grid_coords(Wf, Hf, step):
    xs = (np.arange(Wf, dtype=np.float32)) / step
    ys = (np.arange(Hf, dtype=np.float32)) / step
    gx, gy = np.meshgrid(xs, ys)
    return gx, gy


def lighting(img, prof, rng):
    H, W = img.shape[:2]
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    xs /= W; ys /= H
    g = prof['gradient']
    ang = rng.uniform(0, 2 * math.pi)
    illum = 1 + g * ((xs - 0.5) * math.cos(ang) + (ys - 0.5) * math.sin(ang)) * 2
    cx, cy = rng.uniform(0.3, 0.7), rng.uniform(0.3, 0.7)
    r2 = (xs - cx) ** 2 + (ys - cy) ** 2
    illum *= 1 - prof['vignette'] * r2 / r2.max()
    for _ in range(prof['shadows']):
        illum *= cast_shadow(rng, H, W)
    if prof['glare']:
        gx, gy, gs = rng.uniform(0.2, 0.8), rng.uniform(0.2, 0.8), rng.uniform(0.06, 0.2)
        glare = prof['glare'] * np.exp(-((xs - gx) ** 2 + ((ys - gy) * H / W) ** 2) / (2 * gs * gs))
    else:
        glare = None
    illum *= rng.uniform(0.75, 1.05)
    img = img * illum[..., None]
    if glare is not None:
        img = img + glare[..., None] * (255 - img) * 0.85
    wb = np.array([1 + rng.uniform(-prof['wb'], prof['wb']) for _ in range(3)], np.float32)
    return img * wb[None, None, :]


def cast_shadow(rng, H, W):
    """Soft shadow: a polygon entering from one side (hand / phone)."""
    m = np.zeros((H // 4 + 1, W // 4 + 1), np.uint8)
    h, w = m.shape
    side = rng.randrange(4)
    depth = rng.uniform(0.15, 0.6)
    pts = []
    if side == 0:      # from the left
        pts = [(0, rng.uniform(0, h)), (depth * w * rng.uniform(0.6, 1.4), rng.uniform(0, h)), (depth * w, rng.uniform(0, h)), (0, h if rng.random() < 0.5 else 0)]
    elif side == 1:
        pts = [(w, rng.uniform(0, h)), (w - depth * w, rng.uniform(0, h)), (w - depth * w * rng.uniform(0.6, 1.4), rng.uniform(0, h)), (w, h if rng.random() < 0.5 else 0)]
    elif side == 2:
        pts = [(rng.uniform(0, w), 0), (rng.uniform(0, w), depth * h), (rng.uniform(0, w), depth * h * rng.uniform(0.6, 1.4)), (w if rng.random() < 0.5 else 0, 0)]
    else:
        pts = [(rng.uniform(0, w), h), (rng.uniform(0, w), h - depth * h), (rng.uniform(0, w), h - depth * h * rng.uniform(0.6, 1.4)), (w if rng.random() < 0.5 else 0, h)]
    cv2.fillPoly(m, [np.array(pts, np.int32)], 255)
    soft = cv2.GaussianBlur(m.astype(np.float32) / 255.0, (0, 0), rng.uniform(2, 30))
    soft = cv2.resize(soft, (W, H), interpolation=cv2.INTER_LINEAR)
    return 1 - rng.uniform(0.15, 0.55) * soft


def optics(img, prof, rng, sp):
    sigma = prof['blur'] * sp
    if sigma > 0.3:
        blurred = cv2.GaussianBlur(img, (0, 0), sigma)
        if prof['blurVar'] > 0:
            # depth-of-field: blur grows towards one side of the frame
            H, W = img.shape[:2]
            sigma2 = sigma + prof['blurVar'] * sp
            more = cv2.GaussianBlur(img, (0, 0), sigma2)
            ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
            ang = rng.uniform(0, 2 * math.pi)
            ramp = np.clip(0.5 + ((xs / W - 0.5) * math.cos(ang) + (ys / H - 0.5) * math.sin(ang)) * 1.4, 0, 1)[..., None]
            img = blurred * (1 - ramp) + more * ramp
        else:
            img = blurred
    if prof['motion'] > 0:
        L = max(2, int(round(prof['motion'] * sp)))
        k = np.zeros((2 * L + 1, 2 * L + 1), np.float32)
        ang = rng.uniform(0, math.pi)
        for i in range(-L, L + 1):
            k[int(round(L + i * math.sin(ang) * 0.5)), int(round(L + i * math.cos(ang) * 0.5))] = 1
        k /= k.sum()
        img = cv2.filter2D(img, -1, k)
    return img


def sensor(img, prof, rng):
    H, W = img.shape[:2]
    if prof['lowres'] < 0.99:
        small = cv2.resize(img, (max(1, int(W * prof['lowres'])), max(1, int(H * prof['lowres']))), interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR)
    g = rng_np(rng)
    n = prof['noise']
    lum = np.clip(img, 0, 255) / 255.0
    if FAST:
        noise = g.standard_normal(img.shape, dtype=np.float32) * n * (0.5 + 0.5 * np.sqrt(lum))
        cs = g.standard_normal((max(2, H // 2), max(2, W // 2), 3), dtype=np.float32)
        chroma = cv2.resize(cv2.GaussianBlur(cs, (0, 0), 0.75), (W, H), interpolation=cv2.INTER_LINEAR) * n * 0.6
    else:
        noise = g.standard_normal(img.shape).astype(np.float32) * n * (0.5 + 0.5 * np.sqrt(lum))
        chroma = cv2.GaussianBlur(g.standard_normal(img.shape).astype(np.float32), (0, 0), 1.5) * n * 0.6
    img = img + noise + chroma
    if prof['sharpen'] > 0:
        bl = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.8, 2.0))
        img = img + prof['sharpen'] * (img - bl)
    img = np.clip(img, 0, 255).astype(np.uint8)
    if prof.get('binarized'):
        g1 = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, b = cv2.threshold(g1, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        img = cv2.cvtColor(b, cv2.COLOR_GRAY2BGR)
    q = prof['jpeg']
    if q:
        ok, enc = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, int(q)])
        img = cv2.imdecode(enc, cv2.IMREAD_COLOR)
        if prof.get('secondJpeg'):
            ok, enc = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, int(prof['secondJpeg'])])
            img = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    return img, q


# ----------------------------------------------------------------------------
# ground truth mapping
# ----------------------------------------------------------------------------
def _map_bbox(geo, b):
    x, y, w, h = b
    xs = [x, x + w / 2, x + w]
    ys = [y, y + h / 2, y + h]
    pts = np.array([(a, c) for a in xs for c in ys], np.float64)
    p = geo.forward_pts(pts)
    x0, y0 = p.min(0); x1, y1 = p.max(0)
    return [float(x0), float(y0), float(x1 - x0), float(y1 - y0)]


def map_gt(gt, geo, Wf, Hf, sp_page, sp_photo):
    import copy
    g = copy.deepcopy(gt)
    g['width'], g['height'] = int(Wf), int(Hf)
    g['staffSpace'] = float(sp_photo)
    g['lineThickness'] = float(gt.get('lineThickness', 0.1 * sp_page) * sp_photo / sp_page)
    for sysd in g['systems']:
        for st in sysd['staves']:
            new_lines = []
            for line in st['lines']:
                line = np.asarray(line, np.float64)
                xs = np.linspace(line[0, 0], line[-1, 0], max(9, int((line[-1, 0] - line[0, 0]) / (2 * sp_page)) + 1))
                ys = np.interp(xs, line[:, 0], line[:, 1])
                p = geo.forward_pts(np.stack([xs, ys], 1))
                new_lines.append([[round(float(a), 2), round(float(b), 2)] for a, b in p])
            st['lines'] = new_lines
            st['bbox'] = _map_bbox(geo, st['bbox'])
    for m in g['measures']:
        m['bbox'] = _map_bbox(geo, m['bbox'])
        for evs in m['staves']:
            for ev in evs:
                if ev.get('bbox'):
                    ev['bbox'] = _map_bbox(geo, ev['bbox'])
                if 'x' in ev and ev.get('bbox'):
                    ev['x'] = ev['bbox'][0] + ev['bbox'][2] / 2
                if ev.get('heads'):
                    ev['heads'] = [[round(float(a), 2), round(float(b), 2)] for a, b in geo.forward_pts(ev['heads'])]
    if g.get('symbols'):
        for s in g['symbols']:
            s['bbox'] = _map_bbox(geo, s['bbox'])
            if s.get('c'):
                c = geo.forward_pts([s['c']])[0]
                s['c'] = [round(float(c[0]), 2), round(float(c[1]), 2)]
    if g.get('barlines'):
        for b in g['barlines']:
            p = geo.forward_pts([[b['x'], b['y0']], [b['x'], b['y1']]])
            b['p0'] = [float(p[0, 0]), float(p[0, 1])]; b['p1'] = [float(p[1, 0]), float(p[1, 1])]
    return g
