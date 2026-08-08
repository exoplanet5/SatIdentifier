#!/usr/bin/env python3
"""Verification for server.py's catalogue fetching (round 21).

Runs with NO network: http_get is stubbed with fixtures, and the disk cache is
pointed at a temp directory. Covers the /api/celestrak/full ladder —
catalog.csv (OMM CSV) first, legacy catalog.txt fallback with its
post-2026-07 caveat note, stale-cache serving, and the hard-failure message —
plus the Alpha-5 round trip that keeps 6-digit NORAD ids honest.

Run: python3 tools/test_server.py
"""

import importlib.util
import pathlib
import sys
import tempfile
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("server", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

failures = 0


def ok(name, cond, detail=""):
    global failures
    if cond:
        print(f"ok - {name}")
    else:
        failures += 1
        print(f"FAIL - {name}" + (f"  [{detail}]" if detail else ""))


# ---------------------------------------------------------------- network stub
# URL -> bytes, or an Exception instance to raise. Anything not listed raises
# HTTP 403 (CelesTrak's block behaviour, the case that prompted this harness).
FIXTURES = {}


def fake_http_get(url, opener=None):
    v = FIXTURES.get(url)
    if v is None:
        raise urllib.error.HTTPError(url, 403, "Forbidden", None, None)
    if isinstance(v, Exception):
        raise v
    return v


server.http_get = fake_http_get
TMP = tempfile.TemporaryDirectory()
server.CACHE_DIR = pathlib.Path(TMP.name)

CSV_URL, TXT_URL = server.CELESTRAK_FULL_URLS

OMM_CSV = (
    "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,"
    "RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,"
    "CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,"
    "MEAN_MOTION_DOT,MEAN_MOTION_DDOT\n"
    "ISS (ZARYA),1998-067A,2026-08-07T12:00:00.000000,15.50103472,0.0003456,"
    "51.6416,247.4627,130.5360,325.0288,0,U,25544,999,50000,0.000034,"
    "0.0000123,0\n"
    "OBJECT AA,2026-190A,2026-08-07T06:30:00.500000,14.2,0.001,97.5,10.0,"
    "20.0,30.0,0,U,100057,999,100,0.0001,0.00001,0\n"
)

TLE_TXT = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   26219.51782528  .00016717  00000+0  10270-3 0  9992\n"
    "2 25544  51.6392 339.0967 0004272  82.5714 277.5709 15.50136786 12345\n"
)

SATCAT_CSV = (
    "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,"
    "LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,"
    "RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE\n"
    "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.9,51.6,"
    "420,410,399.1,,EA,ORB\n"
)

print("[1] parse_omm_csv — the modern-format full catalogue")
tles = server.parse_omm_csv(OMM_CSV)
ok("two rows parsed", len(tles) == 2, repr(tles)[:120])
ok("integer NORAD ids, 6-digit intact",
   [t["norad"] for t in tles] == [25544, 100057])
l1 = tles[1]["l1"]
ok("6-digit object synthesizes an Alpha-5 line 1", l1.startswith("1 A0057U"), l1)
ok("Alpha-5 field decodes back to the true id",
   server.catnum(l1[2:7]) == 100057)
ok("checksums are recomputed",
   all(t[k][-1] == server._tle_checksum(t[k][:-1]) for t in tles
       for k in ("l1", "l2")))
ok("HTML error page yields [], not junk objects",
   server.parse_omm_csv("<!DOCTYPE html><html>403</html>") == [])
ok("a TLE file yields [] (falls through to parse_tles)",
   server.parse_omm_csv(TLE_TXT) == [])

print("\n[2] /api/celestrak/full — catalog.csv preferred")
FIXTURES.clear()
FIXTURES[CSV_URL] = OMM_CSV.encode()
FIXTURES[server.SATCAT_BULK_URL] = SATCAT_CSV.encode()
# QSMAG_URL absent -> 403 -> load_qsmag's "unavailable" path, never fatal
p = server.celestrak_full_payload(refresh=True)
ok("payload names the csv source", p["source"] == "celestrak:catalog.csv",
   p["source"])
ok("count and cacheKey", p["count"] == 2 and p["cacheKey"] == "celestrak_full")
ok("enriched: ISS gets its SATCAT rcs/type",
   p["tles"][0]["rcs"] == 399.1 and p["tles"][0]["type"] == "PAY",
   repr({k: p["tles"][0][k] for k in ("rcs", "type")}))
ok("enrichment misses still set the keys",
   all(k in p["tles"][1] for k in ("intl", "rcs", "type", "stdMag")))
ok("coverage counters present",
   p["withType"] == 1 and p["withRcs"] == 1 and p["withStdMag"] == 0)
ok("qsmag failure is a note, not an error",
   any("qsmag unavailable" in n for n in p.get("notes", [])),
   repr(p.get("notes")))
ok("no legacy-file caveat on the csv path",
   not any("legacy TLE file" in n for n in p.get("notes", [])))
ok("payload cached on disk", server.cache_read("celestrak_full") is not None)

print("\n[3] /api/celestrak/full — legacy catalog.txt fallback")
FIXTURES.clear()
FIXTURES[TXT_URL] = TLE_TXT.encode()
FIXTURES[server.SATCAT_BULK_URL] = SATCAT_CSV.encode()
p = server.celestrak_full_payload(refresh=True)
ok("payload names the txt source", p["source"] == "celestrak:catalog.txt",
   p["source"])
ok("caveat note: post-2026-07 objects absent",
   any("legacy TLE file" in n and "100000" in n for n in p.get("notes", [])),
   repr(p.get("notes")))
ok("TLE parse produced the object",
   p["count"] == 1 and p["tles"][0]["norad"] == 25544)

print("\n[4] /api/celestrak/full — failure paths")
FIXTURES.clear()
FIXTURES[server.SATCAT_BULK_URL] = SATCAT_CSV.encode()
p = server.celestrak_full_payload(refresh=True)   # both sources 403, cache warm
ok("network failure serves the stale cache",
   p.get("stale") is True and p["source"] == "celestrak:catalog.txt",
   repr({k: p.get(k) for k in ("stale", "source")}))
server.cache_path("celestrak_full").unlink()
try:
    server.celestrak_full_payload(refresh=True)
    ok("no cache + failure raises ApiError", False)
except server.ApiError as e:
    ok("no cache + failure raises ApiError", e.code == 502, str(e))
    ok("the 403 message names CelesTrak's cooldown",
       "rate-block" in e.msg and "2 h" in e.msg, e.msg)

print("\n[5] parse_tles — Alpha-5 and malformed input (server side)")
t5 = server.parse_tles("OBJECT AA\n"
                       "1 A0057U 26190A   26219.50000000  .00001000  00000+0"
                       "  10000-3 0  9995\n"
                       "2 A0057  97.5000  10.0000 0010000  20.0000  30.0000"
                       " 14.20000000  1005\n")
ok("Alpha-5 TLE decodes to the integer id",
   len(t5) == 1 and t5[0]["norad"] == 100057, repr(t5)[:100])
ok("catnum5 round trip at both edges",
   server.catnum5(100000) == "A0000" and server.catnum("A0000") == 100000 and
   server.catnum5(339999) == "Z9999" and server.catnum("Z9999") == 339999)

TMP.cleanup()
print()
if failures:
    print(f"{failures} CHECK(S) FAILED")
    sys.exit(1)
print("all checks passed")
