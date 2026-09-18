#!/usr/bin/env python3
"""Turn an analysis into two reports: one for a person, one for an agent.

    report.py --analysis analysis.json --out-dir .
    report.py --analysis analysis.json --kind human
    report.py --analysis analysis.json --kind ai --advice "..."

The same measurements, written twice, because the two readers need opposite
things.

A person needs a verdict and a next action: what is wrong, how much it matters,
what to run. Numbers are evidence for the verdict, not the point of the page.

An agent needs the opposite — every number, stated flatly, with the reasoning
rules that make the numbers mean something, and no prose it has to parse a
judgement out of. It also needs to know what it may NOT conclude: that a codec
cutoff cannot be EQ'd back, that the band table is relative and not a tonal
verdict. Those two mistakes are the ones a model actually makes on this data,
so they are written down rather than left to inference.

Both files are plain Markdown, land beside the track, and are regenerated
rather than edited.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

log = logging.getLogger("report")


class ReportError(RuntimeError):
    """Anything that should stop the run with a readable message."""


# --------------------------------------------------------------------------
# verdicts — the shared judgement both reports are built from
# --------------------------------------------------------------------------

def verdicts(a: dict) -> list[dict]:
    """Judge one analysis. Severity is `bad`, `warn` or `ok`.

    Ordered by what blocks a release, not by what is easiest to measure: a
    codec generation cannot be undone, a peak over the ceiling can, and loudness
    is a setting.
    """
    m = a.get("measures", {}) or {}
    codec = a.get("codec", {}) or {}
    clip = a.get("clipping", {}) or {}
    stereo = a.get("stereo", {}) or {}
    targets = a.get("targets", {}) or {}

    target_lufs = targets.get("integrated_lufs", -14.0)
    ceiling = targets.get("true_peak_dbtp", -1.0)

    out: list[dict] = []

    # --- codec ---------------------------------------------------------
    cutoff = codec.get("cutoff_hz")
    if codec.get("lossy_suspected"):
        khz = (cutoff or 0) / 1000.0
        bitrate = ("about 128 kbps" if khz < 17
                   else "a high bitrate" if khz < 19 else "a high bitrate")
        out.append({
            "id": "codec",
            "severity": "bad" if khz < 18 else "warn",
            "title": f"Lossy source — energy stops at {khz:.1f} kHz",
            "detail": (
                f"The spectrum falls off a cliff at {khz:.1f} kHz, which is what "
                f"{bitrate} MP3 or AAC leaves behind. The top octave is gone and "
                "no EQ restores it — boosting there raises noise, not music."),
            "action": "Master from the original WAV. Do not publish this file.",
        })
    elif cutoff:
        out.append({
            "id": "codec",
            "severity": "ok",
            "title": f"Full band to {cutoff / 1000.0:.1f} kHz",
            "detail": "No codec brick wall. This looks like an untouched source.",
            "action": None,
        })

    # --- true peak -----------------------------------------------------
    tp = m.get("true_peak_dbtp")
    if tp is not None:
        if tp > ceiling:
            over = tp - ceiling
            out.append({
                "id": "true_peak",
                "severity": "bad" if tp > 0 else "warn",
                "title": f"True peak {tp:+.2f} dBTP, {over:.2f} dB over the ceiling",
                "detail": (
                    f"The ceiling is {ceiling:+.1f} dBTP. Lossy encoders add their own "
                    "overshoot, so this will clip audibly on YouTube even though the "
                    "WAV itself sounds clean."),
                "action": f"Re-master with --tp {ceiling:.1f}.",
            })
        else:
            out.append({
                "id": "true_peak",
                "severity": "ok",
                "title": f"True peak {tp:+.2f} dBTP, inside the ceiling",
                "detail": "There is headroom for the platform's encoder.",
                "action": None,
            })

    # --- loudness ------------------------------------------------------
    lufs = m.get("integrated_lufs")
    if lufs is not None:
        delta = lufs - target_lufs
        if delta > 1.0:
            out.append({
                "id": "loudness",
                "severity": "warn",
                "title": f"{lufs:.1f} LUFS, {delta:+.1f} LU above target",
                "detail": (
                    "Streaming platforms normalise to the target, so the extra level "
                    "is turned back down on playback. It buys nothing and costs "
                    "dynamic range."),
                "action": f"Re-master with --lufs {target_lufs:.0f}.",
            })
        elif delta < -2.0:
            out.append({
                "id": "loudness",
                "severity": "warn",
                "title": f"{lufs:.1f} LUFS, {delta:+.1f} LU below target",
                "detail": "This will sit noticeably quieter than neighbouring tracks.",
                "action": f"Re-master with --lufs {target_lufs:.0f}.",
            })
        else:
            out.append({
                "id": "loudness",
                "severity": "ok",
                "title": f"{lufs:.1f} LUFS, on target",
                "detail": f"Within a decibel of {target_lufs:.0f} LUFS.",
                "action": None,
            })

    # --- clipping ------------------------------------------------------
    clipped = clip.get("clipped_samples") or 0
    if clip.get("clipping_suspected") and clipped:
        out.append({
            "id": "clipping",
            "severity": "warn",
            "title": f"{clipped} clipped samples in {clip.get('runs', 0)} runs",
            "detail": "Samples sit at or above full scale. Short runs may be inaudible; "
                      "long ones are not.",
            "action": "Check the loudest moments before publishing.",
        })

    # --- dynamics ------------------------------------------------------
    lra = m.get("lra")
    crest = m.get("crest_factor")
    if lra is not None:
        if lra < 4.0:
            out.append({
                "id": "dynamics",
                "severity": "warn",
                "title": f"Loudness range {lra:.1f} LU — narrow",
                "detail": (
                    f"Crest factor {crest:.1f} dB. A dense mix reading this low is "
                    "usually over-compressed, but a sparse arrangement can read low "
                    "honestly. Numbers alone cannot tell you which."
                    if crest is not None else "Numbers alone cannot say whether this "
                    "is over-compression or a sparse arrangement."),
                "action": "Listen before changing anything.",
            })
        else:
            out.append({
                "id": "dynamics",
                "severity": "ok",
                "title": f"Loudness range {lra:.1f} LU",
                "detail": (f"Crest factor {crest:.1f} dB. Healthy dynamics."
                           if crest is not None else "Healthy dynamics."),
                "action": None,
            })

    # --- stereo --------------------------------------------------------
    corr = stereo.get("correlation")
    if corr is not None:
        if corr < 0:
            out.append({
                "id": "stereo",
                "severity": "bad",
                "title": f"Correlation {corr:+.2f} — out of phase",
                "detail": "The channels partly cancel. A mono fold-down will lose "
                          "level, and many listeners hear mono.",
                "action": "Check for an inverted channel in the mix.",
            })
        elif corr < 0.3:
            out.append({
                "id": "stereo",
                "severity": "warn",
                "title": f"Correlation {corr:+.2f} — very wide",
                "detail": "Wide enough that a mono fold-down will change the balance.",
                "action": "Check it in mono.",
            })
        else:
            out.append({
                "id": "stereo",
                "severity": "ok",
                "title": f"Correlation {corr:+.2f}",
                "detail": "The stereo image survives a mono fold-down.",
                "action": None,
            })

    order = {"bad": 0, "warn": 1, "ok": 2}
    out.sort(key=lambda v: order.get(v["severity"], 3))
    return out


def headline(vs: list[dict]) -> str:
    bad = [v for v in vs if v["severity"] == "bad"]
    warn = [v for v in vs if v["severity"] == "warn"]
    if bad:
        # The first clause of the worst finding, kept verbatim: lowercasing it
        # turns "dBTP" into "dbtp".
        return "Not ready — " + bad[0]["title"].split(" — ")[0].split(",")[0]
    if warn:
        return f"Usable, with {len(warn)} thing{'s' if len(warn) > 1 else ''} to check"
    return "Ready to upload"


# --------------------------------------------------------------------------
# the human report
# --------------------------------------------------------------------------

MARK = {"bad": "✗", "warn": "!", "ok": "✓"}


def human_report(a: dict, advice: str | None = None) -> str:
    meta = a.get("metadata", {}) or {}
    m = a.get("measures", {}) or {}
    targets = a.get("targets", {}) or {}
    vs = verdicts(a)

    lines = [
        f"# {meta.get('filename', 'Untitled')}",
        "",
        f"**{headline(vs)}**",
        "",
        f"{_dur(meta.get('duration'))} · {(meta.get('sample_rate') or 0) / 1000:.1f} kHz · "
        f"{meta.get('channels', '?')} ch · {meta.get('bit_depth', '?')}-bit",
        "",
        "## What to do",
        "",
    ]

    actions = [v for v in vs if v["action"]]
    if actions:
        for v in actions:
            lines.append(f"- **{v['title']}** — {v['action']}")
    else:
        lines.append("- Nothing. The file meets the delivery targets.")

    lines += [
        "",
        "## Findings",
        "",
    ]
    for v in vs:
        lines += [f"### {MARK[v['severity']]} {v['title']}", "", v["detail"], ""]

    lines += [
        "## Measurements",
        "",
        "| | value | target |",
        "|---|---|---|",
        f"| Integrated loudness | {_n(m.get('integrated_lufs'))} LUFS | "
        f"{_n(targets.get('integrated_lufs'))} LUFS |",
        f"| True peak | {_n(m.get('true_peak_dbtp'), 2)} dBTP | "
        f"{_n(targets.get('true_peak_dbtp'))} dBTP |",
        f"| Loudness range | {_n(m.get('lra'), signed=False)} LU | — |",
        f"| Crest factor | {_n(m.get('crest_factor'), signed=False)} dB | — |",
        f"| Sample peak | {_n(m.get('peak'), 2)} dBFS | — |",
        "",
    ]

    if advice:
        lines += ["## Advice", "", advice.strip(), ""]

    lines += [
        "---",
        "",
        "Generated by `music studio`. Regenerate rather than editing this file.",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# the agent report
# --------------------------------------------------------------------------

def ai_report(a: dict, advice: str | None = None) -> str:
    """Written to be read by a model: facts, then the rules that bound them.

    The constraints matter as much as the numbers. Without them a model
    reliably suggests a bright EQ for a codec-limited file and calls a normal
    spectrum "dull" from the band table, because both look reasonable if you
    only have the figures.
    """
    meta = a.get("metadata", {}) or {}
    m = a.get("measures", {}) or {}
    codec = a.get("codec", {}) or {}
    clip = a.get("clipping", {}) or {}
    stereo = a.get("stereo", {}) or {}
    targets = a.get("targets", {}) or {}
    bands = (a.get("spectrum", {}) or {}).get("bands", {})
    vs = verdicts(a)

    facts = {
        "file": meta.get("filename"),
        "duration_s": meta.get("duration"),
        "sample_rate_hz": meta.get("sample_rate"),
        "channels": meta.get("channels"),
        "bit_depth": meta.get("bit_depth"),
        "target_lufs": targets.get("integrated_lufs"),
        "target_true_peak_dbtp": targets.get("true_peak_dbtp"),
        "integrated_lufs": m.get("integrated_lufs"),
        "true_peak_dbtp": m.get("true_peak_dbtp"),
        "true_peak_is_estimate": m.get("true_peak_is_estimate"),
        "lra_lu": m.get("lra"),
        "crest_factor_db": m.get("crest_factor"),
        "sample_peak_dbfs": m.get("peak"),
        "codec_cutoff_hz": codec.get("cutoff_hz"),
        "codec_confidence": codec.get("confidence"),
        "codec_lossy_suspected": codec.get("lossy_suspected"),
        "clipped_samples": clip.get("clipped_samples"),
        "clipped_runs": clip.get("runs"),
        "stereo_correlation": stereo.get("correlation"),
        "stereo_width": stereo.get("width"),
        "channel_balance_db": stereo.get("balance_db"),
        "band_energy_db_relative": bands,
    }

    lines = [
        "# Audio analysis — machine-readable summary",
        "",
        f"State: **{headline(vs)}**",
        "",
        "## Facts",
        "",
        "```json",
        json.dumps(facts, indent=1),
        "```",
        "",
        "## Findings",
        "",
        "| severity | id | finding | action |",
        "|---|---|---|---|",
    ]
    for v in vs:
        lines.append(
            f"| {v['severity']} | {v['id']} | {v['title']} | {v['action'] or '—'} |")

    lines += [
        "",
        "## How to read these numbers",
        "",
        "1. **A codec cutoff is not fixable.** A brick wall in the spectrum means the "
        "file already went through MP3/AAC. The content above it is gone. Do not "
        "recommend EQ, exciters or 'restoration' — recommend going back to the "
        "original WAV. A cutoff above 19 kHz is real but inaudible and is not a fault.",
        "2. **`band_energy_db_relative` is relative to this file only.** It is not a "
        "tonal verdict and carries no reference. Every mix reads progressively lower "
        "toward the top. Do not call a track dull, bright, thin or muddy from this "
        "table; use it only to compare two files.",
        "3. **Louder than target is a loss, not a gain.** Platforms normalise to "
        "`target_lufs`. Level above it is turned down on playback, and the dynamic "
        "range spent to get there does not come back.",
        "4. **True peak above the ceiling will distort after encoding**, even when the "
        "WAV sounds clean, because the encoder adds its own overshoot.",
        "5. **LRA alone cannot diagnose over-compression.** A dense mix reading under "
        "4 LU usually is; a sparse arrangement reading low may be correct. Say which "
        "you think it is and why, or say the numbers cannot settle it.",
        "6. **`true_peak_is_estimate: true` means the figure is a sample-peak "
        "substitute**, not a real dBTP measurement. Treat it as a lower bound.",
        "",
        "## Tools",
        "",
        "```",
        "music master <track> --lufs <n> --tp <n> [--eq flat|warm|air|clean-lows|narrow-bass]",
        "music compare <track> --null diff.wav     # hear exactly what changed",
        "music studio <file>                       # re-measure and re-report",
        "```",
        "",
        "`--eq` runs before the loudness stage, so it cannot break the true-peak "
        "ceiling. If loudnorm reports falling back to dynamic mode, the source peaks "
        "above the ceiling and no target reaches it linearly — that is a mix problem, "
        "not a flag problem.",
        "",
    ]

    if advice:
        lines += ["## Advice already given", "", advice.strip(), ""]

    return "\n".join(lines)


# --------------------------------------------------------------------------

def _n(v, places: int = 1, signed: bool = True) -> str:
    """Format a measurement.

    Levels carry a sign because the sign is the information — -12.2 LUFS and
    +0.54 dBTP mean opposite things about whether you are over a limit. Spans
    like loudness range and crest factor are magnitudes and never negative, so
    a leading plus on them is noise.
    """
    if v is None:
        return "—"
    if not isinstance(v, (int, float)):
        return str(v)
    return f"{v:+.{places}f}" if signed else f"{v:.{places}f}"


def _dur(seconds) -> str:
    if not seconds:
        return "—"
    s = int(round(float(seconds)))
    return f"{s // 60}:{s % 60:02d}"


def write_reports(analysis: dict, out_dir: Path, advice: str | None = None,
                  stem: str = "") -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"{stem}." if stem else ""
    human = out_dir / f"{prefix}REPORT.md"
    ai = out_dir / f"{prefix}report.ai.md"
    human.write_text(human_report(analysis, advice), encoding="utf-8")
    ai.write_text(ai_report(analysis, advice), encoding="utf-8")
    return {"human": human, "ai": ai}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Write a human report and an agent report from an analysis.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--analysis", type=Path, required=True, help="analysis.json.")
    p.add_argument("--out-dir", type=Path, help="Where to write. Default: beside the analysis.")
    p.add_argument("--kind", choices=["human", "ai", "both"], default="both")
    p.add_argument("--advice", help="Model advice to fold in.")
    p.add_argument("--stem", default="", help="Prefix for the output names.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )
    try:
        if not args.analysis.is_file():
            raise ReportError(f"No analysis at {args.analysis}")
        a = json.loads(args.analysis.read_text(encoding="utf-8"))

        if args.kind == "human":
            print(human_report(a, args.advice))
            return 0
        if args.kind == "ai":
            print(ai_report(a, args.advice))
            return 0

        out = args.out_dir or args.analysis.parent
        written = write_reports(a, out, args.advice, args.stem)
        for label, path in written.items():
            print(f"{label:6} {path}")
    except ReportError as exc:
        log.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
