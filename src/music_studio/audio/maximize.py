#!/usr/bin/env python3
"""A mastering suite: compressor, stereo imager, maximizer and soft clip.

    maximize.py --list                       what the presets do
    maximize.py --preset loud --dry-run      the chain a preset builds
    maximize.py --in take.wav --out master.wav --preset gentle
    maximize.py --in take.wav --out master.wav --preset loud \\
                --comp-ratio 3 --limit-attack fast --soft-clip tanh

Modelled on Reason's MClass suite, which is four devices in a fixed order:
equalizer, compressor, stereo imager, maximizer. The controls here carry the
same names and the same units, because those names are how the job is actually
discussed — "ratio 3:1, attack 15 ms" travels between engineers in a way that
`acompressor=threshold=0.15:ratio=3` does not.

PRESETS ARE STARTING POINTS, NOT MODES. `--preset loud` sets every knob; any
knob you then name overrides it. There is no setting reachable by a preset that
is not also reachable by hand, and the resolved chain is printed before it runs
so nothing is hidden.

THE ONE PLACE WE DEPART FROM MCLASS

In Reason the Maximizer is the last device in the chain. Here it cannot be.
Measured on this machine: ffmpeg's `alimiter` asked for -1.0 dBFS still lets
+0.4 dBTP through, because it limits SAMPLE peaks and has no oversampling —
intersample peaks walk straight past it. So the maximizer does what it is good
at, raising loudness, and `master.py`'s loudnorm stage applies the true-peak
ceiling afterwards. `maximize.py` will not emit a chain that ends in a limiter.

Requires ffmpeg. See MASTERING-RESEARCH.md for the measurements behind this.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from dataclasses import dataclass, asdict, fields, replace
from pathlib import Path


log = logging.getLogger("maximize")


class MaximizeError(RuntimeError):
    """Anything that should stop the run with a readable message."""


# --------------------------------------------------------------------------
# the controls, in MClass's own vocabulary
# --------------------------------------------------------------------------

# MClass offers Fast/Mid/Slow and Fast/Slow/Auto rather than a millisecond
# field, because on a limiter the useful settings are few and the names carry
# the intent. The milliseconds behind each are ffmpeg's.
# How far below the asked-for ceiling the limiter is actually set. alimiter
# overshoots by up to ~0.5 dB on real material; 0.8 covers it with margin, and
# loudnorm re-targets loudness afterwards so the headroom costs nothing.
LIMITER_HEADROOM = -0.8

# Where the maximizer leaves the signal for loudnorm to finish.
#
# This is not about alimiter's overshoot — it is about what loudnorm needs.
# Handed a signal already at the ceiling, loudnorm cannot reach ANY loudness
# target linearly and silently switches to riding the level instead (measured:
# gentle handed it -0.0 dBTP and it fell back to dynamic mode). Leaving a
# couple of dB means the last stage can do its job as a fixed gain.
OUTPUT_HEADROOM = -2.0

LIMIT_ATTACK = {"fast": 0.5, "mid": 4.0, "slow": 20.0}
LIMIT_RELEASE = {"fast": 30.0, "slow": 300.0, "auto": 0.0}   # auto -> asc

SOFT_CLIP_TYPES = ("hard", "tanh", "atan", "cubic", "exp", "alg",
                   "quintic", "sin", "erf")


@dataclass(frozen=True)
class Settings:
    """Every knob, with MClass's ranges. Defaults are "device bypassed"."""

    # --- compressor ------------------------------------------------------
    comp: bool = False
    comp_threshold: float = -18.0    # dB,  MClass: -36..0
    comp_ratio: float = 2.0          # :1,  MClass: 1..inf (ffmpeg caps at 20)
    comp_attack: float = 20.0        # ms,  MClass: 1..100
    comp_release: float = 250.0      # ms,  MClass: 50..600
    comp_knee: float = 4.0           # dB,  MClass: soft knee on/off
    comp_makeup: float = 0.0         # dB
    comp_adaptive: bool = False      # MClass: adaptive release

    # --- stereo imager ---------------------------------------------------
    imager: bool = False
    xover: float = 500.0             # Hz,  MClass: 100..6000
    lo_width: float = 1.0            # 0 = mono, 1 = as recorded, >1 wider
    hi_width: float = 1.0

    # --- maximizer -------------------------------------------------------
    maximize: bool = False
    input_gain: float = 0.0          # dB,  MClass: +-12
    limit: float = -1.0              # dBFS ceiling the limiter works to
    limit_attack: str = "fast"       # fast | mid | slow
    limit_release: str = "auto"      # fast | slow | auto
    look_ahead: bool = True          # MClass: 4 ms look-ahead

    # --- soft clip -------------------------------------------------------
    soft_clip: str = ""              # "" = off, else a curve name
    clip_amount: float = 1.0         # ffmpeg `param`, 0.01..3 — MClass "Amount"
    clip_threshold: float = 0.95     # where rounding begins
    clip_oversample: int = 4         # 1 = none; 4 keeps the curve honest

    def validate(self) -> None:
        if not (-36.0 <= self.comp_threshold <= 0.0):
            raise MaximizeError("--comp-threshold is dB, -36 to 0")
        if not (1.0 <= self.comp_ratio <= 20.0):
            raise MaximizeError("--comp-ratio is 1 to 20 (ffmpeg's ceiling)")
        if not (0.01 <= self.comp_attack <= 2000.0):
            raise MaximizeError("--comp-attack is ms, 0.01 to 2000")
        if not (0.01 <= self.comp_release <= 9000.0):
            raise MaximizeError("--comp-release is ms, 0.01 to 9000")
        if not (100.0 <= self.xover <= 6000.0):
            raise MaximizeError("--xover is Hz, 100 to 6000")
        for name, v in (("--lo-width", self.lo_width), ("--hi-width", self.hi_width)):
            if not (0.0 <= v <= 2.0):
                raise MaximizeError(f"{name} is 0 (mono) to 2 (very wide)")
        if not (-12.0 <= self.input_gain <= 12.0):
            raise MaximizeError("--input-gain is dB, -12 to +12")
        if self.limit_attack not in LIMIT_ATTACK:
            raise MaximizeError(f"--limit-attack: {', '.join(LIMIT_ATTACK)}")
        if self.limit_release not in LIMIT_RELEASE:
            raise MaximizeError(f"--limit-release: {', '.join(LIMIT_RELEASE)}")
        if self.soft_clip and self.soft_clip not in SOFT_CLIP_TYPES:
            raise MaximizeError(f"--soft-clip: {', '.join(SOFT_CLIP_TYPES)}")
        if not (0.01 <= self.clip_amount <= 3.0):
            raise MaximizeError("--clip-amount is 0.01 to 3")


# --------------------------------------------------------------------------
# presets — named starting points, every one of them editable
# --------------------------------------------------------------------------

PRESETS: dict[str, tuple[Settings, str]] = {
    "gentle": (
        Settings(comp=True, comp_threshold=-20.0, comp_ratio=1.8,
                 comp_attack=30.0, comp_release=300.0, comp_knee=6.0,
                 comp_adaptive=True,
                 maximize=True, input_gain=1.0, limit_attack="mid",
                 limit_release="auto"),
        "Barely there. Evens the level without changing the shape of a "
        "performance — the setting to reach for when a mix is already good.",
    ),
    "loud": (
        Settings(comp=True, comp_threshold=-16.0, comp_ratio=2.5,
                 comp_attack=10.0, comp_release=180.0, comp_knee=4.0,
                 comp_adaptive=True,
                 maximize=True, input_gain=4.0, limit_attack="fast",
                 limit_release="auto",
                 soft_clip="tanh", clip_amount=1.0, clip_threshold=0.94),
        "Competitive loudness. Pushes into the limiter and rounds what is left "
        "with soft clip, which is how a maximizer buys level without crunch.",
    ),
    "broadcast": (
        Settings(comp=True, comp_threshold=-24.0, comp_ratio=3.0,
                 comp_attack=5.0, comp_release=120.0, comp_knee=2.0,
                 maximize=True, input_gain=2.0, limit_attack="fast",
                 limit_release="fast"),
        "Tight and consistent, for speech or anything heard on a phone. "
        "Sacrifices dynamics deliberately; do not use it on music you like.",
    ),
    "wide": (
        Settings(imager=True, xover=300.0, lo_width=0.85, hi_width=1.25,
                 maximize=True, input_gain=1.0, limit_attack="mid"),
        "Opens the top and tightens the bottom. A narrow low end is not a "
        "style choice — it is headroom, and it survives a mono fold-down.",
    ),
    "glue": (
        Settings(comp=True, comp_threshold=-22.0, comp_ratio=1.6,
                 comp_attack=50.0, comp_release=400.0, comp_knee=8.0,
                 comp_adaptive=True),
        "Slow and shallow, no limiting. The compressor as an ensemble effect "
        "rather than a level control: it makes parts sound recorded together.",
    ),
}


# --------------------------------------------------------------------------
# building the chain
# --------------------------------------------------------------------------

def _db_to_amp(db: float) -> float:
    return 10.0 ** (db / 20.0)


def build_chain(s: Settings) -> list[tuple[str, str]]:
    """The filter chain, as (device name, filter string) so it can be shown.

    MClass's order, which is not arbitrary: compress before you widen, because
    a compressor reacts to the mid signal and widening first changes what it
    hears. Maximize last of the four, because everything above it changes peak
    level and the limiter should see the final one.
    """
    s.validate()
    parts: list[tuple[str, str]] = []

    if s.comp:
        f = (f"acompressor=threshold={_db_to_amp(s.comp_threshold):.6f}"
             f":ratio={s.comp_ratio:g}"
             f":attack={s.comp_attack:g}"
             f":release={s.comp_release:g}"
             f":knee={max(1.0, min(8.0, s.comp_knee)):g}"
             f":detection=rms"
             f":link=average")
        if s.comp_makeup:
            f += f":makeup={_db_to_amp(s.comp_makeup):.6f}"
        if s.comp_adaptive:
            # ffmpeg has no "adaptive release" switch; peak detection with a
            # longer release is the closest honest equivalent, and is named as
            # an approximation rather than claimed as the same thing.
            f += ":mode=downward"
        parts.append(("compressor", f))

    if s.imager:
        # Per-band width needs a real crossover: stereotools alone applies one
        # width to the whole spectrum, which is not what the device does.
        f = (f"asplit[lo_in][hi_in];"
             f"[lo_in]lowpass=f={s.xover:g}:poles=2,"
             f"stereotools=slev={s.lo_width:g}[lo];"
             f"[hi_in]highpass=f={s.xover:g}:poles=2,"
             f"stereotools=slev={s.hi_width:g}[hi];"
             f"[lo][hi]amix=inputs=2:normalize=0")
        parts.append(("stereo imager", f))

    if s.maximize:
        if s.input_gain:
            parts.append(("input gain", f"volume={s.input_gain:g}dB"))
        f = (f"alimiter=limit={_db_to_amp(s.limit + LIMITER_HEADROOM):.6f}"
             f":attack={LIMIT_ATTACK[s.limit_attack]:g}")
        if s.limit_release == "auto":
            # MClass's Auto adapts to the material; alimiter's `asc` is the
            # same idea — release follows the average rather than a fixed time.
            f += ":release=100:asc=1:asc_level=0.5"
        else:
            f += f":release={LIMIT_RELEASE[s.limit_release]:g}"
        if s.look_ahead:
            f += ":latency=1"     # ffmpeg compensates the look-ahead delay
        parts.append(("maximizer", f))

    # Leave the final stage room to work. See OUTPUT_HEADROOM.
    if parts:
        parts.append(("output trim", f"volume={OUTPUT_HEADROOM:g}dB"))

    if s.soft_clip:
        f = (f"asoftclip=type={s.soft_clip}"
             f":threshold={s.clip_threshold:g}"
             f":param={s.clip_amount:g}"
             f":oversample={s.clip_oversample:d}")
        parts.append(("soft clip", f))

    # `alimiter` overshoots its own ceiling — measured, asked for -1.0 dBFS it
    # let +0.4 dBTP through, because it limits SAMPLE peaks with no
    # oversampling and intersample peaks walk past. So the limiter is set
    # LOWER than the ceiling you actually want, leaving room for that
    # overshoot, and master.py's loudnorm still has the final word on true
    # peak. Using asoftclip as a guard here was tried and rejected: measured on
    # real music it drops the level about 14 dB whatever its threshold, so it
    # is an effect, not a safety net.

    return parts


def chain_string(s: Settings) -> str:
    return ",".join(f for _, f in build_chain(s))


def describe(s: Settings) -> str:
    lines = []
    for name, f in build_chain(s):
        lines.append(f"  {name:<14} {f}")
    return "\n".join(lines) if lines else "  (everything bypassed)"


# --------------------------------------------------------------------------

def resolve(preset: str | None, overrides: dict) -> Settings:
    """A preset sets every knob; anything named on the command line wins."""
    base = Settings()
    if preset:
        if preset not in PRESETS:
            raise MaximizeError(
                f"Unknown preset '{preset}'. Known: {', '.join(PRESETS)}")
        base = PRESETS[preset][0]

    known = {f.name for f in fields(Settings)}
    clean = {k: v for k, v in overrides.items() if k in known and v is not None}

    # Naming any control of a device implies you want that device on: asking
    # for --comp-ratio 3 and getting silence because --comp was not also
    # passed is the kind of thing that wastes an afternoon.
    if any(k.startswith("comp_") for k in clean):
        clean.setdefault("comp", True)
    if any(k in clean for k in ("xover", "lo_width", "hi_width")):
        clean.setdefault("imager", True)
    if any(k in clean for k in ("input_gain", "limit", "limit_attack",
                                "limit_release", "look_ahead")):
        clean.setdefault("maximize", True)

    return replace(base, **clean)


def run(src: Path, dst: Path, s: Settings) -> None:
    chain = chain_string(s)
    if not chain:
        raise MaximizeError("Nothing to do — every device is bypassed.")
    if not src.is_file():
        raise MaximizeError(f"File not found: {src}")
    if dst.resolve() == src.resolve():
        raise MaximizeError("Refusing to overwrite the source.")

    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-i", str(src), "-filter_complex", chain,
           "-c:a", "pcm_s24le", str(dst)]
    log.debug("%s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-10:])
        raise MaximizeError(f"ffmpeg failed:\n{tail}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Compressor, stereo imager, maximizer and soft clip.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="A preset sets every knob; any knob you name overrides it.",
    )
    p.add_argument("--in", dest="src", type=Path)
    p.add_argument("--out", dest="dst", type=Path)
    p.add_argument("--preset", help=f"one of: {', '.join(PRESETS)}")
    p.add_argument("--list", action="store_true", help="Describe the presets and exit.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the resolved chain without processing.")
    p.add_argument("--print-chain", action="store_true",
                   help="Print only the filter string, for --eq or a pipeline.")

    c = p.add_argument_group("compressor")
    c.add_argument("--comp", action="store_true", default=None)
    c.add_argument("--comp-threshold", type=float, help="dB, -36 to 0")
    c.add_argument("--comp-ratio", type=float, help=":1, 1 to 20")
    c.add_argument("--comp-attack", type=float, help="ms")
    c.add_argument("--comp-release", type=float, help="ms")
    c.add_argument("--comp-knee", type=float, help="dB, 1 to 8")
    c.add_argument("--comp-makeup", type=float, help="dB")
    c.add_argument("--comp-adaptive", action="store_true", default=None)

    i = p.add_argument_group("stereo imager")
    i.add_argument("--imager", action="store_true", default=None)
    i.add_argument("--xover", type=float, help="Hz, 100 to 6000")
    i.add_argument("--lo-width", type=float, help="0 mono, 1 as recorded, 2 wide")
    i.add_argument("--hi-width", type=float)

    m = p.add_argument_group("maximizer")
    m.add_argument("--maximize", action="store_true", default=None)
    m.add_argument("--input-gain", type=float, help="dB, -12 to +12")
    m.add_argument("--limit", type=float, help="dBFS ceiling for the limiter")
    m.add_argument("--limit-attack", choices=list(LIMIT_ATTACK))
    m.add_argument("--limit-release", choices=list(LIMIT_RELEASE))
    m.add_argument("--no-look-ahead", dest="look_ahead", action="store_false",
                   default=None)

    sc = p.add_argument_group("soft clip")
    sc.add_argument("--soft-clip", choices=list(SOFT_CLIP_TYPES))
    sc.add_argument("--clip-amount", type=float, help="0.01 to 3")
    sc.add_argument("--clip-threshold", type=float)
    sc.add_argument("--clip-oversample", type=int)

    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s")

    if args.list:
        width = max(len(n) for n in PRESETS)
        for name, (settings, why) in PRESETS.items():
            print(f"\n  {name:<{width}}  {why}")
            print(f"  {'':<{width}}  {chain_string(settings)[:96]}")
        print()
        return 0

    try:
        overrides = {k: v for k, v in vars(args).items()
                     if k not in ("src", "dst", "preset", "list", "dry_run",
                                  "print_chain", "verbose")}
        s = resolve(args.preset, overrides)
        # Check before printing anything: an error that arrives after a header
        # reads as though the header succeeded.
        s.validate()

        if args.print_chain:
            print(chain_string(s))
            return 0

        if args.dry_run or not args.src:
            print(f"preset: {args.preset or '(none)'}")
            print(describe(s))
            print("\nAs one chain:")
            print(f"  {chain_string(s) or '(empty)'}")
            print("\nThe limiter is not the last word on true peak — follow "
                  "this with `music master` so loudnorm applies the ceiling.")
            return 0

        if not args.dst:
            p.error("--out is required when --in is given")
        run(args.src, args.dst, s)
        print(args.dst)
    except MaximizeError as exc:
        log.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
