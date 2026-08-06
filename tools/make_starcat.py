#!/usr/bin/env python3
"""Build app/assets/stars_m9.bin — the deep star catalogue for the sky chart.

Fetches Tycho-2 (Hog+ 2000, VizieR I/259) down to V = 9.0, converts Tycho VT/BT
to Johnson V, sorts by declination and writes a compact binary the frontend can
mmap into typed arrays. Dev-time only: the generated asset is committed, so
users never run this. Python standard library only.

The chart needs ~mag 9 because at a 1-degree field the bright-star catalogue
bundled with SatObserver (V <= 4.6, ~1000 stars) shows literally nothing.

Binary layout, little-endian, structure-of-arrays so the frontend can build
Float32Array/Int16Array views directly over the buffer with no per-star parsing
(a 10-byte interleaved record would be misaligned and force a slow DataView):

    offset 0            magic  "STR1"                     4 bytes
    offset 4            count  uint32                     4 bytes
    offset 8            magLimit  float32 (V)             4 bytes
    offset 12           ra     float32[count]  degrees, [0, 360)
    offset 12 + 4*count dec    float32[count]  degrees, ASCENDING (binary search)
    offset 12 + 8*count mag    int16[count]    V * 100

float32 holds RA to ~2e-5 deg (0.08"), far finer than the ~0.5" of proper motion
we ignore by keeping J2000 mean places (26 years x ~20 mas/yr for a typical star).
Both are negligible against the arcminute-scale TLE error this tool lives with.
"""

import argparse
import bisect
import json
import math
import pathlib
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VIZIER_URL = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv"
# Tycho-2 main catalogue, plus supplement 1 (Hipparcos/Tycho-1 stars absent from the
# main catalogue). The supplement is NOT optional: Tycho-2's own reduction saturates
# on the brightest stars, so the main catalogue is missing Sirius, Vega, Arcturus,
# Betelgeuse and Acrux among others. A star chart without Vega is not a star chart.
CATALOGS = ["I/259/tyc2", "I/259/suppl_1"]
BRIGHT_JS = "app/js/vendor/starcat.js"   # BSC5/HYG bright stars, relative to repo root
BRIGHT_TAKEOVER_MAG = 4.6       # at/below this V, prefer BSC5 photometry over Tycho
# starcat.js positions are rounded to 0.01 deg, which is 20-36" depending on
# declination, so the cross-match radius must be several times that or the bright
# stars silently fail to match and both copies survive. Bright stars are sparse
# (~1000 over the whole sky), so a generous radius is safe here.
MATCH_ARCSEC = 90.0
USER_AGENT = "SatIdentifier/0.1 (star catalogue builder)"
FETCH_TIMEOUT = 600             # seconds; the full query returns ~160k rows

MAG_LIMIT = 9.0                 # Johnson V cut written to the file
VT_FETCH_LIMIT = 9.4            # VT cut requested from VizieR, see vt_to_v()
MAX_BYTES = 64 * 1024 * 1024    # refuse a runaway download

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_OUT = SCRIPT_DIR.parent / "app" / "assets" / "stars_m9.bin"


def vt_to_v(bt, vt):
    """Johnson V from Tycho-2 VT/BT (Hog+ 2000, Table 2): V = VT - 0.090*(BT-VT).

    Returns None when VT is missing. When only BT is missing (faint red stars,
    and stars where BT was not measured) we fall back to V = VT - 0.016, the
    mean offset for BT-VT = 0.18 — good to a few hundredths, which is well
    inside what a magnitude-limited star chart needs.
    """
    if vt is None:
        return None
    if bt is None:
        return vt - 0.016
    return vt - 0.090 * (bt - vt)


def load_bright(path):
    """Extract [(raDeg, decDeg, vMag), ...] from vendor/starcat.js.

    That file is `SAT.stardata = {...};` with stars as [RAdeg(-180..180), DEdeg, mag],
    derived from BSC5/HYG via d3-celestial. Its photometry is real Johnson V, which
    matters: Tycho VT/BT saturate on the brightest stars, and BT is often blank there,
    so converting Tycho would put Sirius at V=-1.10 instead of -1.46.
    """
    text = pathlib.Path(path).read_text(encoding="utf-8")
    start = text.index("{")
    end = text.rindex("}") + 1
    data = json.loads(text[start:end])
    out = []
    for s in data.get("stars", []):
        out.append((s[0] % 360.0, s[1], s[2]))
    return out


def sep_arcsec(ra1, dec1, ra2, dec2):
    """Angular separation, small-angle, with the cos(dec) factor that matters near
    the pole (without it Polaris looks 30" off when it is 0.4" off)."""
    dra = ((ra1 - ra2 + 180.0) % 360.0) - 180.0
    dra *= math.cos(math.radians(0.5 * (dec1 + dec2)))
    ddec = dec1 - dec2
    return math.hypot(dra, ddec) * 3600.0


def merge_bright(tycho, bright):
    """Overwrite Tycho photometry with BSC5 V at the bright end, keeping Tycho's
    positions. Returns (merged, n_rephotometered, n_added).

    Deliberately NOT a replace-the-whole-record merge: Tycho astrometry is
    milliarcsecond-class while starcat.js is rounded to 0.01 deg, so adopting BSC5
    positions would throw away two orders of magnitude of accuracy to fix a
    magnitude. We take only the magnitude, which is the part Tycho gets wrong
    (VT/BT saturate on bright stars, and BT is frequently blank there).

    Within the match radius the *brightest* Tycho star is chosen rather than the
    nearest: at 90" in a crowded field the nearest may be a faint neighbour, but the
    naked-eye star we are looking for is by construction the bright one.

    A candidate additionally has to be within PLAUSIBLE_DMAG of the BSC5 magnitude
    to count as the same star. Without this guard the Gaia build corrupted itself:
    Gaia DR3 genuinely lacks its very brightest stars (Vega, Acrux — total
    saturation), so the "brightest within 90 arcsec" was some V~9 field star, which
    then got painted with V=0.03 while Vega itself stayed missing. A star the
    catalogue does not plausibly contain must be ADDED, not matched.

    Tycho is dec-sorted first so each bright star only scans a narrow dec band.
    """
    PLAUSIBLE_DMAG = 3.0
    tycho.sort(key=lambda s: s[1])
    decs = [s[1] for s in tycho]
    band = MATCH_ARCSEC / 3600.0 * 1.5
    added = 0
    rephot = 0
    extra = []
    for bra, bdec, bmag in bright:
        lo = bisect.bisect_left(decs, bdec - band)
        hi = bisect.bisect_right(decs, bdec + band)
        best = None
        for k in range(lo, hi):
            if sep_arcsec(bra, bdec, tycho[k][0], tycho[k][1]) <= MATCH_ARCSEC \
                    and tycho[k][2] <= bmag + PLAUSIBLE_DMAG:
                if best is None or tycho[k][2] < tycho[best][2]:
                    best = k
        if best is None:
            extra.append((bra, bdec, bmag))
            added += 1
        else:
            tycho[best] = (tycho[best][0], tycho[best][1], bmag)
            rephot += 1
    return tycho + extra, rephot, added


def dedupe(stars, radius_arcsec=2.0):
    """Drop entries lying within radius_arcsec of a brighter entry.

    The main catalogue and supplement 1 are meant to be disjoint but are not
    entirely: Arcturus, for one, appears twice 0.2" apart with wildly different
    photometry (the saturated main-catalogue value and the supplement value). Two
    entries a fraction of an arcsecond apart always render as a single dot, so the
    faint ghost buys nothing and makes any brightness lookup a coin toss.
    """
    stars.sort(key=lambda s: s[1])
    decs = [s[1] for s in stars]
    band = radius_arcsec / 3600.0 * 1.5
    drop = set()
    for i, (ra, dec, mag) in enumerate(stars):
        if i in drop:
            continue
        hi = bisect.bisect_right(decs, dec + band)
        for k in range(i + 1, hi):
            if k in drop:
                continue
            if sep_arcsec(ra, dec, stars[k][0], stars[k][1]) <= radius_arcsec:
                drop.add(k if stars[k][2] >= mag else i)
                if stars[k][2] < mag:
                    break
    return [s for k, s in enumerate(stars) if k not in drop], len(drop)


GAIA_SOURCE = "I/355/gaiadr3"
GAIA_EPOCH = 2016.0             # Gaia DR3 reference epoch
TARGET_EPOCH = 2026.5           # propagate proper motions to "now"


def fetch_gaia(g_limit):
    """Download Gaia DR3 rows with Gmag < g_limit as TSV text.

    Positions are epoch 2016.0 with proper motions, which fixes the one measured
    astrometric defect of the Tycho-2 build: its J2000 mean places are 26 years
    stale, and 2026-epoch positions of high-proper-motion stars are off by up to
    ~4 arcminutes (61 Cyg class) — visibly wrong against a satellite trail.
    """
    query = {
        "-source": GAIA_SOURCE,
        "-out": "RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag,BP-RP",
        "Gmag": "<%.2f" % g_limit,
        "-out.max": "unlimited",
    }
    url = VIZIER_URL + "?" + urllib.parse.urlencode(query)
    print("fetching %s" % url, flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        raw = resp.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise RuntimeError("response exceeded %d bytes" % MAX_BYTES)
    print("  %.1f MB in %.1f s" % (len(raw) / 1e6, time.time() - t0), flush=True)
    return raw.decode("utf-8", "replace")


def gaia_g_to_v(g, bprp):
    """Johnson V from Gaia G and BP-RP (Riello+ 2021 photometric relations):
    G - V = -0.02704 + 0.01424(BP-RP) - 0.2156(BP-RP)^2 + 0.01426(BP-RP)^3.
    Missing colour (blank BP-RP) leaves V = G, good to ~0.3 mag for most stars —
    fine for a dot-size on a chart."""
    if bprp is None:
        return g
    x = max(-1.0, min(5.0, bprp))
    return g - (-0.02704 + 0.01424 * x - 0.2156 * x * x + 0.01426 * x * x * x)


def parse_gaia_rows(text, v_limit):
    """Parse Gaia TSV into [(raDeg, decDeg, vMag), ...] at TARGET_EPOCH.

    pmRA is Gaia's mu_alpha* (already times cos dec), so the RA step divides the
    cos back out. Blank proper motions (common at the bright end, where Gaia's
    astrometry is poor or absent — exactly what the BSC5 merge covers) are 0.
    """
    dt = TARGET_EPOCH - GAIA_EPOCH
    stars = []
    skipped = 0
    seen_sep = False
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if line.startswith("---"):
            seen_sep = True
            continue
        if not seen_sep:
            continue
        p = line.split("\t")
        if len(p) < 6:
            skipped += 1
            continue
        try:
            ra = float(p[0])
            dec = float(p[1])
            g = float(p[4])
        except ValueError:
            skipped += 1
            continue

        def opt(v):
            try:
                return float(v)
            except ValueError:
                return None
        pm_ra, pm_de, bprp = opt(p[2]), opt(p[3]), opt(p[5])
        if pm_ra is not None and pm_de is not None:
            cosd = math.cos(math.radians(dec))
            if abs(cosd) > 1e-6:
                ra += pm_ra * dt / 3.6e6 / cosd
            dec += pm_de * dt / 3.6e6
        v = gaia_g_to_v(g, bprp)
        if v > v_limit:
            skipped += 1
            continue
        stars.append((ra % 360.0, dec, v))
    return stars, skipped


# ---------------------------------------------------------------------------
# Deep tile set (round 15): data/stars17/ — Gaia DR3 to V = 17, tiled
#
# ~35-45M stars over the sky (measured ~900-1200/deg^2 at V<=17 in round-14
# cones), several hundred MB — buildable locally, far past committable. The
# frontend loads tiles on demand for < 3 deg views; see CONTRACT "Deep tile
# set" for the binding scheme: 4 deg dec bands 0..44, single polar tiles at
# |dec| >= 86, twelve 30 deg RA columns elsewhere, names t<band>_<col>.bin,
# each tile the same STR1 binary as the bundled asset.
# ---------------------------------------------------------------------------

DEEP_MAG_LIMIT = 17.0
DEEP_BAND_DEG = 4
DEEP_COL_DEG = 30
DEEP_FETCH_PAUSE = 0.3          # courtesy pause between the ~520 VizieR requests


def deep_tiles():
    """Yield (name, ra0, ra1, de0, de1) for every tile in the scheme."""
    for band in range(45):
        de0 = -90 + band * DEEP_BAND_DEG
        de1 = de0 + DEEP_BAND_DEG
        if band in (0, 44):                     # polar caps: one tile, all RA
            yield ("t%d_0.bin" % band, 0.0, 360.0, de0, de1)
            continue
        for col in range(12):
            yield ("t%d_%d.bin" % (band, col),
                   col * DEEP_COL_DEG, (col + 1) * DEEP_COL_DEG, de0, de1)


def fetch_gaia_box(ra0, ra1, de0, de1, g_limit, depth=0):
    """Gaia DR3 rows in an RA/Dec box as TSV text, splitting in RA when the
    response trips the size guard (the Baade-window class of tile).

    One transient-network retry per request; a second failure raises so the
    resumable outer loop can be re-run.
    """
    query = {
        "-source": GAIA_SOURCE,
        "-out": "RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag,BP-RP",
        "RA_ICRS": "%.4f..%.4f" % (ra0, ra1),
        "DE_ICRS": "%.4f..%.4f" % (de0, de1),
        "Gmag": "<%.2f" % g_limit,
        "-out.max": "unlimited",
    }
    url = VIZIER_URL + "?" + urllib.parse.urlencode(query)
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                raw = resp.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise OverflowError()
            print("    %7.1f kB in %5.1f s  RA %.1f..%.1f" %
                  (len(raw) / 1e3, time.time() - t0, ra0, ra1), flush=True)
            return raw.decode("utf-8", "replace")
        except OverflowError:
            if depth >= 4:
                raise RuntimeError("box still over %d MB after 4 RA splits" %
                                   (MAX_BYTES >> 20))
            mid = 0.5 * (ra0 + ra1)
            print("    over size guard — splitting RA at %.2f" % mid, flush=True)
            return (fetch_gaia_box(ra0, mid, de0, de1, g_limit, depth + 1) +
                    fetch_gaia_box(mid, ra1, de0, de1, g_limit, depth + 1))
        except (urllib.error.URLError, OSError) as e:
            if attempt == 2:
                raise
            print("    retrying after %s" % e, flush=True)
            time.sleep(5)


def build_deep17(out_dir, bright_path, vmax):
    """Build the deep tile set. Resumable: existing tiles are skipped, and the
    index (the frontend's presence signal) is written only when every tile is
    done, so a half-finished build never reads as present."""
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    epoch_yr = 2000.0 + (time.time() - 946728000.0) / 31557600.0

    # Whole bright catalogue, not just <= 4.6: Gaia lacks its saturated
    # brightest stars entirely (Vega, Sirius class), and the deep tiles REPLACE
    # the bundled catalogue on screen, so every bright star must be present in
    # the tile that contains it.
    bright = load_bright(bright_path) if pathlib.Path(bright_path).exists() else []

    global TARGET_EPOCH
    TARGET_EPOCH = epoch_yr          # parse_gaia_rows propagates PM to this
    total = 0
    names = []
    todo = list(deep_tiles())
    for i, (name, ra0, ra1, de0, de1) in enumerate(todo):
        names.append(name)
        tile_path = out / name
        if tile_path.exists():
            total += (tile_path.stat().st_size - 12) // 10
            continue
        print("[%3d/%d] %s  RA %g..%g Dec %g..%g" %
              (i + 1, len(todo), name, ra0, ra1, de0, de1), flush=True)
        text = fetch_gaia_box(ra0, ra1, de0, de1, vmax + 0.5)
        stars, skipped = parse_gaia_rows(text, vmax)
        # clip the bright merge to the tile (with margin for the match radius)
        m = MATCH_ARCSEC / 3600.0 * 2
        sub = [s for s in bright
               if de0 - m <= s[1] <= de1 + m
               and (ra1 - ra0 >= 360 or (ra0 - m <= s[0] <= ra1 + m))]
        if sub:
            stars, rephot, added = merge_bright(stars, sub)
        n, nbytes = write_tile(stars, tile_path, vmax)
        total += n
        print("    %d stars (%d skipped), %.1f kB" % (n, skipped, nbytes / 1e3),
              flush=True)
        time.sleep(DEEP_FETCH_PAUSE)

    index = {
        "magLimit": vmax, "count": total, "tiles": len(names),
        "builtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "epochYr": round(epoch_yr, 3),
    }
    tmp = out / "index.json.tmp"
    tmp.write_text(json.dumps(index), encoding="utf-8")
    tmp.replace(out / "index.json")
    print("deep tile set complete: %d stars in %d tiles, index written"
          % (total, len(names)), flush=True)
    return 0


def write_tile(stars, path, mag_limit):
    """STR1 tile: same layout as write_binary but with the tile's own V cut in
    the header and no global-state coupling."""
    stars.sort(key=lambda s: s[1])
    n = len(stars)
    buf = bytearray()
    buf += b"STR1"
    buf += struct.pack("<I", n)
    buf += struct.pack("<f", mag_limit)
    buf += struct.pack("<%df" % n, *[s[0] for s in stars])
    buf += struct.pack("<%df" % n, *[s[1] for s in stars])
    buf += struct.pack("<%dh" % n, *[max(-32768, min(32767, round(s[2] * 100)))
                                     for s in stars])
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(bytes(buf))
    tmp.replace(path)
    return n, len(buf)


def fetch_tycho2(source, vt_limit):
    """Download rows of `source` with VTmag < vt_limit as TSV text.

    Uses VizieR's computed _RAJ2000/_DEJ2000 columns rather than the catalogue's
    own RAmdeg/DEmdeg: the latter are blank for several hundred stars (Tycho-2
    derives no mean position where the proper motion is unreliable, which
    includes many of the brightest stars), and a chart that silently drops
    Vega would be worse than useless.
    """
    query = {
        "-source": source,
        "-out": "_RAJ2000,_DEJ2000,BTmag,VTmag",
        "VTmag": "<%.2f" % vt_limit,
        "-out.max": "unlimited",
    }
    url = VIZIER_URL + "?" + urllib.parse.urlencode(query)
    print("fetching %s" % url, flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        raw = resp.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise RuntimeError("response exceeded %d bytes" % MAX_BYTES)
    print("  %.1f MB in %.1f s" % (len(raw) / 1e6, time.time() - t0), flush=True)
    return raw.decode("utf-8", "replace")


def parse_rows(text):
    """Parse VizieR asu-tsv output into [(raDeg, decDeg, vMag), ...].

    The format is comment lines starting with '#', then a header line, a units
    line, a dashed separator, then data. Rows with a blank position or a blank
    VT are skipped rather than guessed at.
    """
    stars = []
    skipped = 0
    seen_sep = False
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if line.startswith("---"):
            seen_sep = True
            continue
        if not seen_sep:
            continue            # header / units line
        parts = line.split("\t")
        if len(parts) < 4:
            skipped += 1
            continue
        try:
            ra = float(parts[0])
            dec = float(parts[1])
        except ValueError:
            skipped += 1
            continue
        bt = None
        vt = None
        try:
            bt = float(parts[2])
        except ValueError:
            pass
        try:
            vt = float(parts[3])
        except ValueError:
            pass
        v = vt_to_v(bt, vt)
        if v is None or v > MAG_LIMIT:
            skipped += 1
            continue
        stars.append((ra % 360.0, dec, v))
    return stars, skipped


def write_binary(stars, path):
    """Write the structure-of-arrays binary described in the module docstring."""
    stars.sort(key=lambda s: s[1])          # by declination, for cone queries
    n = len(stars)
    buf = bytearray()
    buf += b"STR1"
    buf += struct.pack("<I", n)
    buf += struct.pack("<f", MAG_LIMIT)
    buf += struct.pack("<%df" % n, *[s[0] for s in stars])
    buf += struct.pack("<%df" % n, *[s[1] for s in stars])
    buf += struct.pack("<%dh" % n, *[max(-32768, min(32767, round(s[2] * 100))) for s in stars])

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(bytes(buf))
    tmp.replace(path)
    return n, len(buf)


def sanity_check(stars):
    """Verify a handful of bright stars survived the fetch and the V conversion.

    Tycho-2 is incomplete at the very bright end and VizieR blanks some fields,
    so this is the check that would have caught a silently truncated download.
    Positions are J2000; tolerance is generous because we only care that the
    star is present and roughly right, not that it is astrometrically perfect.
    """
    probes = [
        ("Sirius",      101.287, -16.716, -1.46),
        ("Vega",        279.234,  38.784,  0.03),
        ("Arcturus",    213.915,  19.182, -0.05),
        ("Polaris",      37.955,  89.264,  1.98),
        ("Betelgeuse",   88.793,   7.407,  0.50),
        ("Acrux",       186.650, -63.099,  0.77),
    ]
    ok = True
    for name, ra, dec, vknown in probes:
        # brightest within the radius, not nearest — same rule the merge uses, so the
        # check actually verifies what the merge did rather than sampling a neighbour
        best = None
        for s in stars:
            if abs(s[1] - dec) > 0.05:
                continue
            d = sep_arcsec(ra, dec, s[0], s[1])
            if d <= 60.0 and (best is None or s[2] < best[1][2]):
                best = (d, s)
        if best is None:
            print("  MISSING  %-11s (expected V=%.2f)" % (name, vknown), flush=True)
            ok = False
        else:
            dv = best[1][2] - vknown
            flag = "" if abs(dv) < 0.15 else "   <-- V off by %+.2f" % dv
            print("  found    %-11s V=%6.2f (true %5.2f, %5.1f\" off)%s"
                  % (name, best[1][2], vknown, best[0], flag), flush=True)
            if abs(dv) >= 0.15:
                ok = False
    return ok


def main():
    ap = argparse.ArgumentParser(description="Build the deep star catalogue asset.")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output .bin path")
    ap.add_argument("--cache-dir", help="read/write per-catalogue TSV here (for re-runs)")
    ap.add_argument("--bright", default=str(SCRIPT_DIR.parent / BRIGHT_JS),
                    help="path to starcat.js for accurate bright-star photometry")
    ap.add_argument("--source", choices=["tycho2", "gaia"], default="tycho2",
                    help="tycho2: V<=9 at J2000 mean places; gaia: DR3, deeper, "
                         "proper motions applied to epoch %.1f" % TARGET_EPOCH)
    ap.add_argument("--vmax", type=float, default=None,
                    help="V limit written to the file (default 9.0 tycho2 / 10.5 gaia)")
    ap.add_argument("--deep17", action="store_true",
                    help="build the deep tile set (default out: data/stars17/, "
                         "gitignored; V <= 17; resumable — rerun to continue)")
    args = ap.parse_args()

    if args.deep17:
        vmax = args.vmax if args.vmax else DEEP_MAG_LIMIT
        out_dir = args.out if args.out != str(DEFAULT_OUT) \
            else str(SCRIPT_DIR.parent / "data" / "stars17")
        return build_deep17(out_dir, args.bright, vmax)

    global MAG_LIMIT
    if args.source == "gaia":
        MAG_LIMIT = args.vmax if args.vmax else 10.5
        cached = pathlib.Path(args.cache_dir) / "gaia_g105.tsv" if args.cache_dir else None
        if cached and cached.exists():
            text = cached.read_text(encoding="utf-8", errors="replace")
            print("read cached %s (%.1f MB)" % (cached, len(text) / 1e6), flush=True)
        else:
            # fetch a little past the V cut: G-V can reach ~ -0.5 for blue stars
            text = fetch_gaia(MAG_LIMIT + 0.5)
            if cached:
                cached.parent.mkdir(parents=True, exist_ok=True)
                cached.write_text(text, encoding="utf-8")
        stars, skipped = parse_gaia_rows(text, MAG_LIMIT)
        print("  gaia dr3: %d stars to V=%.1f at epoch %.1f (%d rows skipped)"
              % (len(stars), MAG_LIMIT, TARGET_EPOCH, skipped), flush=True)
        return finish(stars, args)
    if args.vmax:
        MAG_LIMIT = args.vmax

    stars = []
    for source in CATALOGS:
        cached = None
        if args.cache_dir:
            cached = pathlib.Path(args.cache_dir) / (source.replace("/", "_") + ".tsv")
        if cached and cached.exists():
            text = cached.read_text(encoding="utf-8", errors="replace")
            print("read cached %s (%.1f MB)" % (cached, len(text) / 1e6), flush=True)
        else:
            try:
                text = fetch_tycho2(source, VT_FETCH_LIMIT)
            except (urllib.error.URLError, OSError) as e:
                print("fetch of %s failed: %s" % (source, e), file=sys.stderr)
                return 1
            if cached:
                cached.parent.mkdir(parents=True, exist_ok=True)
                cached.write_text(text, encoding="utf-8")
        rows, skipped = parse_rows(text)
        print("  %s: %d stars to V=%.1f (%d rows skipped)"
              % (source, len(rows), MAG_LIMIT, skipped), flush=True)
        stars.extend(rows)

    if not stars:
        print("no stars parsed — VizieR output format may have changed", file=sys.stderr)
        return 1
    print("Tycho total: %d" % len(stars), flush=True)
    return finish(stars, args)


def finish(stars, args):
    """The source-independent tail: dedupe, bright-star merge, sanity, write."""
    if not stars:
        print("no stars parsed — VizieR output format may have changed", file=sys.stderr)
        return 1
    stars, ndup = dedupe(stars)
    print("deduped %d near-coincident entries -> %d" % (ndup, len(stars)), flush=True)

    bright_path = pathlib.Path(args.bright)
    if bright_path.exists():
        bright = [s for s in load_bright(bright_path) if s[2] <= BRIGHT_TAKEOVER_MAG]
        stars, rephot, added = merge_bright(stars, bright)
        print("merged %d BSC5 bright stars: %d re-photometered in place, %d added whole"
              % (len(bright), rephot, added), flush=True)
    else:
        print("WARNING: %s not found — bright-star magnitudes will be Tycho-derived"
              % bright_path, file=sys.stderr)

    print("sanity check:", flush=True)
    ok = sanity_check(stars)

    out = pathlib.Path(args.out)
    n, nbytes = write_binary(stars, out)
    print("wrote %s: %d stars, %.2f MB" % (out, n, nbytes / 1e6), flush=True)
    if not ok:
        print("WARNING: bright-star probes failed (see above) — check coverage/photometry",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
