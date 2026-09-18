#!/usr/bin/env python3
"""Compare two versions of a track — numerically, and audibly.

The interesting part is the null test. Gain-match and time-align the two files,
invert one, sum them: everything identical cancels to silence, and what is left
is exactly what the processing changed. You can listen to that residue. It is
the only way to actually hear a subtle master rather than guess at it.

Usage:
    compare.py --a takes/take-01.wav --b masters/master.wav
    compare.py --a take-01.wav --b master.wav --null diff.wav
    compare.py --a take-01.wav --b master.wav --null diff.wav --amplify 20

Requires: pip install soundfile numpy scipy
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("compare")

BANDS = [
    ("sub", 20, 60),
    ("bass", 60, 250),
    ("low-mid", 250, 800),
    ("mid", 800, 2500),
    ("high-mid", 2500, 6000),
    ("treble", 6000, 12000),
    ("air", 12000, 20000),
]


class CompareError(RuntimeError):
    """Anything that should stop the run with a readable message."""


@dataclass(frozen=True)
class Stats:
    integrated: float
    true_peak: float
    lra: float
    rms: float
    peak: float
    crest: float


def _require(*tools: str) -> None:
    missing = [t for t in tools if shutil.which(t) is None]
    if missing:
        raise CompareError(f"{', '.join(missing)} not found on PATH. Install ffmpeg.")


def _loudness(path: Path) -> tuple[float, float, float]:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path),
         "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", proc.stderr, re.S)
    if not m:
        raise CompareError(f"Could not measure loudness of {path.name}.")
    d = json.loads(m.group(0))
    return float(d["input_i"]), float(d["input_tp"]), float(d["input_lra"])


def _load(path: Path):
    import numpy as np
    import soundfile as sf

    if not path.is_file():
        raise CompareError(f"File not found: {path}")
    data, rate = sf.read(str(path), always_2d=True, dtype="float64")
    return data, rate


def _stats(path: Path, data) -> Stats:
    import numpy as np

    integrated, tp, lra = _loudness(path)
    mono = data.mean(axis=1)
    rms = float(np.sqrt(np.mean(mono ** 2)))
    peak = float(np.max(np.abs(mono))) or 1e-12
    rms_db = 20 * np.log10(max(rms, 1e-12))
    peak_db = 20 * np.log10(peak)
    return Stats(integrated, tp, lra, rms_db, peak_db, peak_db - rms_db)


def _align(a, b):
    """Trim to equal length and remove any sample offset via cross-correlation."""
    import numpy as np
    from scipy import signal

    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    ma, mb = a.mean(axis=1), b.mean(axis=1)

    # correlate a short window; full-length correlation is slow and unnecessary
    win = min(len(ma), 48000 * 20)
    corr = signal.correlate(ma[:win] - ma[:win].mean(),
                            mb[:win] - mb[:win].mean(), mode="same")
    lag = int(np.argmax(np.abs(corr)) - win // 2)

    if lag > 0:
        a, b = a[lag:], b[:len(b) - lag]
    elif lag < 0:
        a, b = a[:len(a) + lag], b[-lag:]
    return a, b, lag


def _band_energy(data, rate) -> dict[str, float]:
    import numpy as np

    mono = data.mean(axis=1)
    spec = np.abs(np.fft.rfft(mono * np.hanning(len(mono))))
    freqs = np.fft.rfftfreq(len(mono), 1 / rate)
    out = {}
    for name, lo, hi in BANDS:
        sel = (freqs >= lo) & (freqs < hi)
        energy = float(np.sqrt(np.mean(spec[sel] ** 2))) if sel.any() else 0.0
        out[name] = 20 * np.log10(max(energy, 1e-12))
    return out


def compare(a_path: Path, b_path: Path, null: Path | None, amplify: float) -> None:
    import numpy as np
    import soundfile as sf

    a, rate_a = _load(a_path)
    b, rate_b = _load(b_path)
    if rate_a != rate_b:
        raise CompareError(
            f"Sample rates differ ({rate_a} vs {rate_b}). Resample one first — "
            "a null test needs matching rates."
        )
    if a.shape[1] != b.shape[1]:
        raise CompareError(f"Channel counts differ ({a.shape[1]} vs {b.shape[1]}).")

    sa, sb = _stats(a_path, a), _stats(b_path, b)

    print(f"\n{'':14} {a_path.name[:24]:>26}  {b_path.name[:24]:>26}   diff")
    print("-" * 78)
    rows = [
        ("Integrated", sa.integrated, sb.integrated, "LUFS"),
        ("True peak", sa.true_peak, sb.true_peak, "dBTP"),
        ("Loudness range", sa.lra, sb.lra, "LU"),
        ("RMS", sa.rms, sb.rms, "dB"),
        ("Peak", sa.peak, sb.peak, "dB"),
        ("Crest factor", sa.crest, sb.crest, "dB"),
    ]
    for name, va, vb, unit in rows:
        print(f"{name:14} {va:>21.1f} {unit:<4} {vb:>21.1f} {unit:<4} {vb - va:>+6.1f}")

    # tonal balance, gain-matched so only shape differences show
    ea, eb = _band_energy(a, rate_a), _band_energy(b, rate_b)
    offset = sb.integrated - sa.integrated
    print(f"\nTonal balance (gain-matched, {offset:+.1f} dB removed)")
    print("-" * 78)
    for name, _, _ in BANDS:
        d = (eb[name] - ea[name]) - offset
        bar = "#" * min(int(abs(d) * 4), 30)
        arrow = "+" if d > 0 else "-"
        print(f"  {name:9} {d:>+6.2f} dB  {arrow if bar else ' '}{bar}")

    # null test
    a_al, b_al, lag = _align(a, b)
    if lag:
        log.info("Aligned with a %d-sample offset.", lag)
    gain = 10 ** (-offset / 20)
    residue = a_al - (b_al * gain)

    res_rms = float(np.sqrt(np.mean(residue.mean(axis=1) ** 2)))
    src_rms = float(np.sqrt(np.mean(a_al.mean(axis=1) ** 2)))
    ratio = 20 * np.log10(max(res_rms, 1e-12) / max(src_rms, 1e-12))

    print(f"\nNull test: residue is {ratio:+.1f} dB relative to the source")
    if ratio < -60:
        print("  Essentially identical — the process changed almost nothing but level.")
    elif ratio < -30:
        print("  Small change. Real, but subtle enough that A/B listening will struggle.")
    elif ratio < -15:
        print("  Clear processing. You should be able to hear this in a careful A/B.")
    else:
        print("  Large change. Either heavy processing, or the files are different takes.")

    if null:
        peak = float(np.max(np.abs(residue))) or 1e-12
        boosted = residue * (10 ** (amplify / 20))
        clipped = float(np.max(np.abs(boosted)))
        if clipped > 1.0:
            boosted = boosted / clipped * 0.98
            log.info("Normalised the residue to avoid clipping.")
        null.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(null), boosted, rate_a, subtype="PCM_24")
        print(f"\nWrote {null} (+{amplify:.0f} dB). Listen to it — that is exactly")
        print("what the processing added or removed, and nothing else.")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Compare two versions of a track numerically and audibly.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--a", type=Path, required=True, help="First file (usually the raw take).")
    p.add_argument("--b", type=Path, required=True, help="Second file (usually the master).")
    p.add_argument("--null", type=Path, help="Write the difference signal here, as WAV.")
    p.add_argument("--amplify", type=float, default=20.0,
                   help="Boost the residue by this many dB so it is audible.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    try:
        _require("ffmpeg")
        compare(args.a, args.b, args.null, args.amplify)
    except CompareError as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.error("Interrupted.")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
