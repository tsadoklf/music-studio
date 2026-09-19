#!/usr/bin/env python3
"""Compare a track against records you already trust.

    python -m music_studio.insight.benchmark --list
    python -m music_studio.insight.benchmark --analysis analysis.json --against aja
    python -m music_studio.insight.benchmark --add aja --analysis reference.json \\
        --note "Steely Dan, 1977. The dynamics reference."

A delivery target says a track should sit near -14 LUFS. It does not say
whether 7.5 LU of range is generous or mean, because that question has no
answer in the abstract — it only has answers relative to records that already
work. This is the other half of the verdict: not "are you legal" but "how do
you sit against something good".

WHY MEASUREMENTS AND NOT AUDIO

A benchmark here is an `audio-analysis/v1` JSON, a few kilobytes. The audio it
was taken from is not stored, referenced or needed: commercial recordings
cannot be committed to a repository, and even one's own masters are binaries
that have no business in git. Numbers travel; the record stays on your disk.

WHAT MAY AND MAY NOT BE COMPARED

The band energy table is RELATIVE TO ONE FILE — it carries no reference level,
and every mix reads progressively lower toward the top. Comparing raw band dB
between two records would therefore be meaningless, and confidently so, which
is worse. What IS comparable is the TILT: the distance between bands within one
file. A record whose air sits 40 dB under its bass is darker than one where the
gap is 30 dB, whatever their absolute levels. So bands are normalised to a
reference band before anything is said about them.

Loudness, range, crest factor, true peak and correlation are absolute
measurements and compare directly.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from music_studio import paths

log = logging.getLogger("benchmark")

# The band every other band is measured against. Mid is the one present in
# essentially all music and the least affected by a genre's low-end fashion,
# which makes it the least arbitrary zero.
TILT_REFERENCE = "mid"

# How far apart two numbers must be before the difference is worth a sentence.
# Below these, the two records are saying the same thing in different words.
NOTABLE = {
    "integrated_lufs": 1.0,     # LU — smaller than this is inaudible in context
    "lra": 1.5,                 # LU — range varies this much between takes
    "crest_factor": 1.5,        # dB
    "true_peak_dbtp": 1.0,      # dB
    "correlation": 0.15,        # unitless
    "band": 3.0,                # dB of tilt — below this is not a tonal choice
}

BAND_ORDER = ["sub", "bass", "low-mid", "mid", "high-mid", "treble", "air"]


class BenchmarkError(RuntimeError):
    """Anything that should stop the run with a readable message."""


# --------------------------------------------------------------------------
# the library
# --------------------------------------------------------------------------

def library_dir() -> Path:
    """Where benchmarks live. Beside the templates, for the same reason:
    a directory, so adding one is writing a file."""
    return paths.project_root() / "benchmarks"


def available() -> dict[str, Path]:
    d = library_dir()
    if not d.is_dir():
        return {}
    return {p.stem: p for p in sorted(d.glob("*.json"))}


def load(name: str) -> dict:
    found = available().get(name)
    if found is None:
        known = ", ".join(available()) or "none installed"
        raise BenchmarkError(f"No benchmark called {name!r}. Available: {known}.")
    try:
        return json.loads(found.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BenchmarkError(f"{found} is not readable JSON: {exc}") from exc


def digest(analysis: dict, note: str = "", title: str = "") -> dict:
    """Reduce a full analysis to what a benchmark needs.

    A whole analysis is megabytes, most of it spectrogram and envelopes for
    drawing. None of that compares between records, and committing it would
    make a library of ten benchmarks larger than the code.
    """
    m = analysis.get("measures", {}) or {}
    spectrum = analysis.get("spectrum", {}) or {}
    stereo = analysis.get("stereo", {}) or {}
    meta = analysis.get("metadata", {}) or {}
    return {
        "schema": "audio-benchmark/v1",
        "title": title or meta.get("filename") or "untitled",
        "note": note,
        "source": {
            "duration_s": meta.get("duration"),
            "sample_rate": meta.get("sample_rate"),
            "channels": meta.get("channels"),
        },
        "measures": {k: m.get(k) for k in
                     ("integrated_lufs", "true_peak_dbtp", "lra",
                      "crest_factor", "rms", "peak")},
        "bands": spectrum.get("bands", {}),
        "stereo": {k: stereo.get(k) for k in
                   ("correlation", "width", "side_to_mid_db")},
    }


def save(name: str, analysis: dict, note: str = "", title: str = "") -> Path:
    if not name or "/" in name or name != name.strip():
        raise BenchmarkError(f"{name!r} is not a usable benchmark name.")
    d = library_dir()
    d.mkdir(parents=True, exist_ok=True)
    dst = d / f"{name}.json"
    dst.write_text(json.dumps(digest(analysis, note, title), indent=1) + "\n",
                   encoding="utf-8")
    return dst


# --------------------------------------------------------------------------
# comparing
# --------------------------------------------------------------------------

def _tilt(bands: dict) -> dict:
    """Bands relative to the reference band, which is what compares.

    See the module docstring: absolute band levels carry no reference and
    comparing them between records would be confidently wrong.
    """
    ref = bands.get(TILT_REFERENCE)
    if ref is None:
        return {}
    out = {}
    for name, value in bands.items():
        if isinstance(value, (int, float)):
            out[name] = round(value - ref, 2)
    return out


def _num(x):
    return x if isinstance(x, (int, float)) else None


def compare(analysis: dict, benchmark: dict) -> dict:
    """What differs, and by how much. Differences only — a list of things that
    match tells you nothing you can act on."""
    mine = analysis.get("measures", {}) or {}
    theirs = benchmark.get("measures", {}) or {}
    rows = []

    for key, label, unit, higher in (
        ("integrated_lufs", "Loudness", "LUFS", None),
        ("lra", "Loudness range", "LU", "more dynamic"),
        ("crest_factor", "Crest factor", "dB", "more transient"),
        ("true_peak_dbtp", "True peak", "dBTP", None),
    ):
        a, b = _num(mine.get(key)), _num(theirs.get(key))
        if a is None or b is None:
            continue
        delta = round(a - b, 2)
        if abs(delta) < NOTABLE.get(key, 1.0):
            continue
        rows.append({"field": key, "label": label, "unit": unit,
                     "mine": a, "theirs": b, "delta": delta,
                     "meaning": _meaning(key, delta, higher)})

    a_corr = _num((analysis.get("stereo") or {}).get("correlation"))
    b_corr = _num((benchmark.get("stereo") or {}).get("correlation"))
    if a_corr is not None and b_corr is not None:
        delta = round(a_corr - b_corr, 2)
        if abs(delta) >= NOTABLE["correlation"]:
            rows.append({
                "field": "correlation", "label": "Stereo correlation",
                "unit": "", "mine": a_corr, "theirs": b_corr, "delta": delta,
                "meaning": ("narrower than" if delta > 0 else "wider than")
                           + " the benchmark",
            })

    return {
        "benchmark": benchmark.get("title", "untitled"),
        "note": benchmark.get("note", ""),
        "measures": rows,
        "bands": _band_rows(analysis, benchmark),
    }


def _band_rows(analysis: dict, benchmark: dict) -> list[dict]:
    mine = _tilt((analysis.get("spectrum") or {}).get("bands", {}) or {})
    theirs = _tilt(benchmark.get("bands", {}) or {})
    rows = []
    for name in BAND_ORDER:
        a, b = mine.get(name), theirs.get(name)
        if a is None or b is None or name == TILT_REFERENCE:
            continue
        delta = round(a - b, 2)
        if abs(delta) < NOTABLE["band"]:
            continue
        rows.append({"band": name, "mine": a, "theirs": b, "delta": delta,
                     "meaning": f"{'more' if delta > 0 else 'less'} {name} "
                                f"relative to {TILT_REFERENCE}"})
    return rows


def _meaning(key: str, delta: float, higher: str | None) -> str:
    if key == "integrated_lufs":
        return ("louder than the benchmark" if delta > 0
                else "quieter than the benchmark")
    if key == "true_peak_dbtp":
        return "closer to the ceiling" if delta > 0 else "more headroom"
    if higher:
        return (f"{higher}" if delta > 0
                else f"less {higher.split(' ', 1)[1]}" if " " in higher
                else f"less {higher}")
    return ""


def render(result: dict) -> str:
    """The comparison as text. Silence means agreement, which is a result."""
    out = [f"Against {result['benchmark']}"]
    if result.get("note"):
        out.append(f"  {result['note']}")
    out.append("")

    rows = result["measures"]
    if rows:
        for r in rows:
            sign = "+" if r["delta"] > 0 else ""
            out.append(f"  {r['label']:<18} {r['mine']:>7} vs {r['theirs']:>7} "
                       f"{r['unit']:<5} {sign}{r['delta']:<7} {r['meaning']}")
    else:
        out.append("  Nothing notable differs in loudness, range or peak.")

    bands = result["bands"]
    if bands:
        out.append("")
        out.append(f"  Tonal tilt, relative to {TILT_REFERENCE}:")
        for r in bands:
            sign = "+" if r["delta"] > 0 else ""
            out.append(f"    {r['band']:<10} {sign}{r['delta']:>6} dB   {r['meaning']}")
    return "\n".join(out)


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Compare a track's measurements against a reference record.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--analysis", type=Path, help="An analysis.json from `music scope`.")
    p.add_argument("--against", help="Benchmark name. See --list.")
    p.add_argument("--add", help="Save the given analysis as a benchmark under this name.")
    p.add_argument("--note", default="", help="One line on what the benchmark is for.")
    p.add_argument("--title", default="", help="Display name. Defaults to the filename.")
    p.add_argument("--list", action="store_true", help="Show the installed benchmarks.")
    p.add_argument("--json", action="store_true", help="Emit the comparison as JSON.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(stream=sys.stderr,
                        level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s: %(message)s")

    try:
        if args.list:
            found = available()
            if not found:
                print(f"No benchmarks in {library_dir()}.")
                print("Add one:  --add <name> --analysis <a reference's analysis.json>")
                return 0
            print("Benchmarks:")
            for name, path in found.items():
                data = json.loads(path.read_text(encoding="utf-8"))
                m = data.get("measures", {})
                lufs, lra = m.get("integrated_lufs"), m.get("lra")
                bits = []
                if lufs is not None:
                    bits.append(f"{lufs:+.1f} LUFS")
                if lra is not None:
                    bits.append(f"LRA {lra:.1f}")
                print(f"  {name:<16} {', '.join(bits):<22} {data.get('note', '')[:44]}")
            return 0

        if args.analysis is None:
            raise BenchmarkError("--analysis is required. Run `music scope` first.")
        if not args.analysis.is_file():
            raise BenchmarkError(f"No analysis at {args.analysis}")
        analysis = json.loads(args.analysis.read_text(encoding="utf-8"))

        if args.add:
            dst = save(args.add, analysis, args.note, args.title)
            print(f"Saved {dst}")
            return 0

        if not args.against:
            raise BenchmarkError("--against <name> is required. See --list.")
        result = compare(analysis, load(args.against))
        print(json.dumps(result, indent=1) if args.json else render(result))
    except BenchmarkError as exc:
        log.error("%s", exc)
        return 1
    except json.JSONDecodeError as exc:
        log.error("not readable JSON: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
