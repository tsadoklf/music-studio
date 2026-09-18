#!/usr/bin/env python3
"""Master a track: loudness-target mode, or match a reference recording.

Two modes.

  loudnorm (default) — two-pass EBU R128 normalisation via ffmpeg. Measures the
  track, then applies gain and true-peak limiting to hit a target. Transparent;
  it changes level, not tone.

      master.py --in takes/take-01.wav --out masters/master.wav
      master.py --in take-01.wav --out master.wav --lufs -16 --tp -1.5

  match — analyses a reference recording and matches your track's loudness and
  frequency balance to it. This is what "reference mastering" means: instead of
  guessing at a preset, you point at a record whose sound you want.

      master.py --in take-01.wav --out master.wav --reference some-record.wav

  Also measures without writing anything:

      master.py --in master.wav --measure

Requires ffmpeg. --reference mode additionally needs: pip install matchering
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("master")

DEFAULT_LUFS = -14.0   # streaming normalisation target
DEFAULT_TP = -1.0      # true peak ceiling, dBTP
DEFAULT_LRA = 11.0     # loudness range

# Tone presets. Each is a starting point with a stated reason, not a magic
# button — the chain is printed before it runs so it can be copied, edited or
# argued with.
#
# Two rules govern everything here:
#
#   1. Tone runs BEFORE the loudnorm stage, never after. Every one of these
#      chains changes peak level: measured on real material, the `warm` tilt
#      alone took a -0.46 dBTP source to +0.04 dBTP. Only loudnorm's TP stage
#      is true-peak accurate, so it has to have the last word.
#   2. Amounts are small. +-0.5 to +-1.5 dB is a mastering decision; +-3 dB
#      means the mix is wrong and should be fixed upstream instead.
EQ_PRESETS: dict[str, tuple[str, str]] = {
    "flat": (
        "",
        "No tone change. Loudness and true peak only — trust the mix.",
    ),
    "warm": (
        "firequalizer=gain_entry='entry(0,1.5);entry(200,1.0);entry(800,0);"
        "entry(4000,-0.6);entry(16000,-0.9)'",
        "Gentle tilt toward the lows, pivoting near 800 Hz. For thin or "
        "brittle digital sources.",
    ),
    "air": (
        "treble=g=1.0:f=10000:width_type=q:w=0.7",
        "+1 dB shelf above 10 kHz. Only helps when real top end is present — "
        "it cannot restore what a codec removed.",
    ),
    "clean-lows": (
        "highpass=f=28:poles=2",
        "High-pass at 28 Hz. Removes rumble and DC that eat headroom without "
        "being audible.",
    ),
    "narrow-bass": (
        "stereotools=mlev=1:sbal=0,lowpass=f=120",
        "Bass below 120 Hz to mono. For wide synth bass that wastes headroom "
        "and collapses badly on small speakers.",
    ),
}


class MasterError(RuntimeError):
    """Anything that should stop the run with a readable message."""


@dataclass(frozen=True)
class Loudness:
    integrated: float
    true_peak: float
    lra: float
    threshold: float

    def describe(self) -> str:
        return (f"{self.integrated:+.1f} LUFS integrated, "
                f"{self.true_peak:+.1f} dBTP peak, "
                f"LRA {self.lra:.1f}")


def _require(*tools: str) -> None:
    missing = [t for t in tools if shutil.which(t) is None]
    if missing:
        raise MasterError(
            f"{', '.join(missing)} not found on PATH. "
            "Install ffmpeg (macOS: brew install ffmpeg)."
        )


def _run(cmd: list[str], label: str) -> str:
    log.debug("%s: %s", label, " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-12:])
        raise MasterError(f"ffmpeg failed during {label}:\n{tail}")
    return proc.stderr


def measure(path: Path) -> Loudness:
    """Read integrated loudness, true peak and range with ffmpeg's loudnorm."""
    if not path.is_file():
        raise MasterError(f"File not found: {path}")
    stderr = _run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path),
         "-af", f"loudnorm=I={DEFAULT_LUFS}:TP={DEFAULT_TP}:LRA={DEFAULT_LRA}:print_format=json",
         "-f", "null", "-"],
        f"measuring {path.name}",
    )
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    if not m:
        raise MasterError(f"Could not read loudness from {path.name}.")
    d = json.loads(m.group(0))
    return Loudness(
        integrated=float(d["input_i"]),
        true_peak=float(d["input_tp"]),
        lra=float(d["input_lra"]),
        threshold=float(d["input_thresh"]),
    )


def _probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels,bits_per_raw_sample",
         "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    s = data["streams"][0]
    return {
        "sample_rate": int(s.get("sample_rate", 48000)),
        "channels": int(s.get("channels", 2)),
        "duration": float(data.get("format", {}).get("duration", 0)),
    }


def _eq_chain(name: str) -> tuple[str, str]:
    """Look up a tone preset, or accept a raw ffmpeg filter chain.

    Anything that is not a known preset name is passed through verbatim, so an
    experiment does not require editing this file. It still runs ahead of
    loudnorm and still gets printed before it runs.
    """
    if name in EQ_PRESETS:
        return EQ_PRESETS[name]
    if "=" in name or "," in name:          # looks like a filter chain
        return name, "custom chain"
    raise MasterError(
        f"Unknown tone preset '{name}'. Known: {', '.join(EQ_PRESETS)}. "
        "Or pass a raw ffmpeg filter chain."
    )


def _measure_through(path: Path, chain: str) -> Loudness:
    """Measure loudness as it will be after `chain`, without writing a file."""
    if not chain:
        return measure(path)
    af = (f"{chain},loudnorm=I={DEFAULT_LUFS}:TP={DEFAULT_TP}:LRA={DEFAULT_LRA}"
          ":print_format=json")
    stderr = _run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path),
         "-af", af, "-f", "null", "-"],
        f"measuring {path.name} through the tone chain",
    )
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    if not m:
        raise MasterError(f"Could not read loudness of {path.name} through the tone chain.")
    d = json.loads(m.group(0))
    return Loudness(
        integrated=float(d["input_i"]),
        true_peak=float(d["input_tp"]),
        lra=float(d["input_lra"]),
        threshold=float(d["input_thresh"]),
    )


def _warn_if_not_linear(stderr: str, lufs: float, tp: float,
                        before: "Loudness | None" = None) -> None:
    """Report when loudnorm quietly abandoned linear mode.

    Asking for linear=true is a request, not a guarantee. When the gain needed to
    reach the loudness target would push true peak past the ceiling, loudnorm
    switches to dynamic normalisation instead — riding the level through the track
    rather than applying one fixed gain. That is a musical change: a quiet opening
    no longer sits where the mix put it relative to the climax.

    It happens silently, so the only way to know is to read the second pass's own
    report back. Measured on a real track (2026-09-15): asking for -14 LUFS at
    -1 dBTP on a source already peaking at +0.2 dBTP returned
    "normalization_type": "dynamic" and landed 0.4 dB short of the target.
    """
    m = re.search(r"\{[^{}]*\"normalization_type\"[^{}]*\}", stderr, re.S)
    if not m:
        return
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return
    if d.get("normalization_type", "").lower() == "linear":
        return

    log.warning(
        "loudnorm fell back to DYNAMIC normalisation — it rode the level through "
        "the track instead of applying a fixed gain."
    )
    log.warning(
        "  Cause: %+.1f LUFS is not reachable without exceeding %+.1f dBTP.",
        lufs, tp,
    )
    # When the source is already over the ceiling, lowering the target does not
    # help — loudnorm has to pull the peaks down whatever loudness you ask for.
    # Saying "try --lufs -18" there would send you round a loop that cannot close.
    if before is not None and before.true_peak > tp:
        log.warning(
            "  The source itself peaks at %+.1f dBTP, above the %+.1f ceiling, so no "
            "loudness target reaches it linearly.", before.true_peak, tp,
        )
        log.warning(
            "  Fix: reduce peaks in the mix, or accept dynamic mode here and check "
            "what it cost with `music compare`."
        )
    else:
        log.warning(
            "  Fix: lower the target (--lufs %.0f) or raise the ceiling (--tp %.1f), "
            "then re-run. Check the result with `music compare`.",
            lufs - 2, tp + 0.5,
        )


def master_loudnorm(
    src: Path,
    dst: Path,
    *,
    lufs: float = DEFAULT_LUFS,
    tp: float = DEFAULT_TP,
    lra: float = DEFAULT_LRA,
    sample_rate: int | None = None,
    bit_depth: int = 24,
    eq: str = "flat",
) -> None:
    """Two-pass EBU R128 normalisation, optionally after a tone preset.

    The second pass is given the first pass's measurements, which is what makes
    loudnorm linear rather than dynamic — it applies a fixed gain and limits
    peaks, instead of riding the level through the track. That matters for music
    with a wide dynamic range: a quiet opening stays quiet relative to the climax.

    loudnorm may refuse that request; see `_warn_if_not_linear`.

    When a tone preset is given it runs *ahead* of loudnorm, and the first-pass
    measurement is taken through it. Measuring the dry source and then normalising
    an EQ'd one would hand loudnorm numbers describing a signal it never sees,
    and the target would be missed by however much the EQ moved the level.
    """
    chain, why = _eq_chain(eq)
    if chain:
        log.info("Tone: %s — %s", eq, why)
        log.info("  %s", chain)

    before = _measure_through(src, chain)
    log.info("Before: %s%s", before.describe(), " (after tone)" if chain else "")

    info = _probe(src)
    rate = sample_rate or info["sample_rate"]
    codec = {16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_s32le"}.get(bit_depth)
    if codec is None:
        raise MasterError(f"Unsupported bit depth: {bit_depth}. Use 16, 24 or 32.")

    norm = (
        f"loudnorm=I={lufs}:TP={tp}:LRA={lra}"
        f":measured_I={before.integrated}"
        f":measured_TP={before.true_peak}"
        f":measured_LRA={before.lra}"
        f":measured_thresh={before.threshold}"
        f":linear=true:print_format=json"
    )
    # Tone first, loudnorm last. Every tone chain changes peak level, and
    # loudnorm's TP stage is the only true-peak-accurate ceiling available.
    filt = f"{chain},{norm}" if chain else norm

    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=dst.suffix, dir=dst.parent)
    import os
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        stderr = _run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "info", "-nostdin",
             "-i", str(src), "-af", filt,
             "-ar", str(rate), "-c:a", codec, str(tmp)],
            f"writing {dst.name}",
        )
        _warn_if_not_linear(stderr, lufs, tp, before)
        tmp.replace(dst)
    finally:
        tmp.unlink(missing_ok=True)

    after = measure(dst)
    log.info("After:  %s", after.describe())
    moved = after.integrated - before.integrated
    log.info("Level change: %+.1f dB", moved)
    if abs(moved) < 0.5:
        log.warning(
            "Barely moved — the source was already near the target. "
            "Mastering had little to do."
        )


def master_reference(src: Path, dst: Path, reference: Path) -> None:
    """Match loudness and frequency balance to a reference recording."""
    try:
        import matchering as mg
    except ImportError as exc:
        raise MasterError(
            "Reference mode needs matchering:\n  pip install matchering"
        ) from exc

    if not reference.is_file():
        raise MasterError(f"Reference file not found: {reference}")

    log.info("Before: %s", measure(src).describe())
    log.info("Matching to %s", reference.name)

    mg.log(warning_handler=lambda m: log.warning("%s", m))
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        mg.process(
            target=str(src),
            reference=str(reference),
            results=[mg.pcm24(str(dst))],
        )
    except Exception as exc:
        raise MasterError(f"Matchering failed: {exc}") from exc

    log.info("After:  %s", measure(dst).describe())


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Master a track to a loudness target, or match a reference recording.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--in", dest="src", type=Path, help="Source audio.")
    p.add_argument("--out", dest="dst", type=Path, help="Output path.")
    p.add_argument("--reference", type=Path,
                   help="Reference recording to match. Switches to match mode.")
    p.add_argument("--measure", action="store_true",
                   help="Report loudness and exit without writing.")
    p.add_argument("--lufs", type=float, default=DEFAULT_LUFS,
                   help="Integrated loudness target.")
    p.add_argument("--tp", type=float, default=DEFAULT_TP, help="True peak ceiling, dBTP.")
    p.add_argument("--lra", type=float, default=DEFAULT_LRA, help="Loudness range.")
    p.add_argument("--sample-rate", type=int, help="Resample. Default: keep the source rate.")
    p.add_argument("--bit-depth", type=int, default=24, choices=[16, 24, 32])
    p.add_argument("--eq", default="flat",
                   help="Tone preset, or a raw ffmpeg filter chain. Runs before loudnorm.")
    p.add_argument("--list-eq", action="store_true",
                   help="Describe the tone presets and exit.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    if args.list_eq:
        width = max(len(n) for n in EQ_PRESETS)
        for name, (chain, why) in EQ_PRESETS.items():
            print(f"  {name:<{width}}  {why}")
            if chain:
                print(f"  {'':<{width}}  {chain}")
        return 0

    if args.src is None:
        p.error("--in is required")

    try:
        _require("ffmpeg", "ffprobe")

        if args.measure:
            print(measure(args.src).describe())
            return 0

        if not args.dst:
            p.error("--out is required unless --measure is given")
        if args.dst.resolve() == args.src.resolve():
            raise MasterError("Refusing to overwrite the source. Pick a different --out.")

        if args.reference:
            master_reference(args.src, args.dst, args.reference)
        else:
            master_loudnorm(
                args.src, args.dst,
                lufs=args.lufs, tp=args.tp, lra=args.lra,
                sample_rate=args.sample_rate, bit_depth=args.bit_depth,
                eq=args.eq,
            )
        print(args.dst)

    except MasterError as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.error("Interrupted.")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
