#!/usr/bin/env python3
"""Find the moments in a track worth looking at, and say when they happen.

A whole-file verdict tells you a track is too loud. It does not tell you that
the problem is one chorus at 2:47 while the rest sits on target. This walks the
time series an analysis already contains and returns dated findings:

    {"time_s": 167.2, "severity": "warn", "title": "...", "detail": "..."}

The events are chosen to be the ones a person would actually seek to: where it
clips, where it is loudest and quietest, where short-term loudness breaks the
target, and where the track opens and ends.

WHY THIS LIVES IN audio/ AND NOT insight/

Everything here is arithmetic over a dict that analyze.py already produced: no
network, no API key, no model. `analyze.py` embeds these findings in the
analysis it returns, and `audio/` may not import `insight/` — measurement must
not depend on interpretation, or a missing key takes the meters down with it.

The one function that DOES ask a model — a sentence of commentary per finding —
is `insight/timeline.py`, which imports this. The dependency runs one way.
"""

from __future__ import annotations

import logging

log = logging.getLogger("timeline")

# How far short-term loudness may stray from target before it is worth a row.
# ±2 LU is roughly where a listener starts to notice a section sitting wrong
# against the rest of a record.
ST_TOLERANCE = 2.0

# Two findings closer than this describe the same moment; keep the worse one.
MERGE_WINDOW = 8.0

MAX_FINDINGS = 14          # a list longer than this stops being a list


class TimelineError(RuntimeError):
    """Anything that should stop the run with a readable message."""


def _fmt(t: float) -> str:
    s = int(round(t))
    return f"{s // 60}:{s % 60:02d}"


def _series(block: dict) -> tuple[list, list]:
    times = (block or {}).get("times") or []
    values = (block or {}).get("lufs") or []
    n = min(len(times), len(values))
    return times[:n], values[:n]


def find_events(a: dict) -> list[dict]:
    """Walk the time series and return dated findings, worst first."""
    out: list[dict] = []

    targets = a.get("targets", {}) or {}
    target = targets.get("integrated_lufs", -14.0)
    ceiling = targets.get("true_peak_dbtp", -1.0)
    duration = (a.get("metadata", {}) or {}).get("duration") or 0.0

    st_times, st_vals = _series((a.get("loudness", {}) or {}).get("short_term"))

    # --- clipping -------------------------------------------------------
    clip = a.get("clipping", {}) or {}
    for ev in (clip.get("worst") or [])[:4]:
        t = ev.get("time_s") if isinstance(ev, dict) else None
        if t is None:
            continue
        run = ev.get("samples") or ev.get("length") or 0
        out.append({
            "time_s": float(t),
            "severity": "bad",
            "title": f"Clipping — {run} consecutive samples",
            "detail": (
                "Samples sit at or above full scale here. A run this long is "
                "audible as a click or a crunch, and lossy encoding makes it "
                "worse rather than hiding it."
                if run > 3 else
                "A short run at full scale. It may be inaudible, but it means "
                "there is no headroom left at this moment."),
        })

    # --- loudest and quietest -------------------------------------------
    if st_vals:
        hi = max(range(len(st_vals)), key=lambda i: st_vals[i])
        lo = min(range(len(st_vals)), key=lambda i: st_vals[i])

        out.append({
            "time_s": float(st_times[hi]),
            "severity": "warn" if st_vals[hi] - target > 4 else "ok",
            "title": f"Loudest passage — {st_vals[hi]:.1f} LUFS short-term",
            "detail": (
                f"The densest moment in the track, {st_vals[hi] - target:+.1f} LU "
                f"against the {target:.0f} LUFS target. This is where a limiter "
                "works hardest and where clipping shows up first."),
        })
        out.append({
            "time_s": float(st_times[lo]),
            "severity": "ok",
            "title": f"Quietest passage — {st_vals[lo]:.1f} LUFS short-term",
            "detail": (
                f"The most exposed moment, {st_vals[lo] - st_vals[hi]:.1f} LU below "
                "the loudest. A wide gap is dynamics; a narrow one means the track "
                "sits at one level throughout."),
        })

        # --- sustained breaches of the target ---------------------------
        out += _breaches(st_times, st_vals, target)

    # --- the opening ----------------------------------------------------
    if st_vals:
        head = st_vals[: max(1, len(st_vals) // 60)]
        avg = sum(head) / len(head)
        out.append({
            "time_s": 0.0,
            "severity": "ok",
            "title": f"Opens at {avg:.1f} LUFS",
            "detail": "How the track introduces itself. A quiet open is a choice; "
                      "an abrupt one at full level is usually an edit.",
        })

    # --- the ending -----------------------------------------------------
    if st_vals and duration:
        tail = st_vals[-max(1, len(st_vals) // 60):]
        avg = sum(tail) / len(tail)
        fades = avg < (sum(st_vals) / len(st_vals)) - 6
        out.append({
            "time_s": float(max(0.0, duration - 1.0)),
            "severity": "ok",
            "title": ("Fades out" if fades else "Ends at full level")
                     + f" — {avg:.1f} LUFS",
            "detail": ("The last seconds drop well below the body of the track, "
                       "which reads as a fade." if fades else
                       "The track ends without a fade. Check there is no abrupt "
                       "cut on the final note."),
        })

    # --- true peak, located ---------------------------------------------
    tp = (a.get("measures", {}) or {}).get("true_peak_dbtp")
    if tp is not None and tp > ceiling:
        t = _loudest_sample_time(a)
        if t is not None:
            out.append({
                "time_s": t,
                "severity": "bad" if tp > 0 else "warn",
                "title": f"Peak reaches {tp:+.2f} dBTP",
                "detail": (
                    f"Above the {ceiling:+.1f} dBTP ceiling. Encoders add their own "
                    "overshoot on top of this, so it will distort after upload even "
                    "though the WAV plays clean."),
            })

    return _tidy(out, target)


def _breaches(times, values, target: float) -> list[dict]:
    """Stretches where short-term loudness sits well off target.

    Reported as spans rather than per-sample, because a chorus that runs 3 LU
    hot for twenty seconds is one fact, not two hundred.
    """
    found: list[dict] = []
    run_start = None
    run_sign = 0

    def close(end_index: int) -> None:
        """Emit the run that ends just before end_index, if it is long enough."""
        if run_sign == 0 or run_start is None:
            return
        span = times[end_index - 1] - times[run_start]
        if span < 5.0:
            return
        seg = values[run_start:end_index]
        peak = max(seg) if run_sign > 0 else min(seg)
        found.append({
            "time_s": float(times[run_start]),
            "severity": "warn",
            "title": (f"{_fmt(span)} {'above' if run_sign > 0 else 'below'} "
                      f"target — peaks {peak:.1f} LUFS"),
            "detail": (
                f"Short-term loudness holds {peak - target:+.1f} LU off the "
                f"{target:.0f} LUFS target for {span:.0f} seconds. "
                + ("Platforms normalise the whole track, so a hot section "
                   "does not play louder — it just has less headroom."
                   if run_sign > 0 else
                   "A section this far down will feel like a drop in level "
                   "rather than a dynamic.")),
        })

    for i, v in enumerate(values):
        delta = v - target
        sign = 1 if delta > ST_TOLERANCE else -1 if delta < -ST_TOLERANCE * 3 else 0
        if sign != run_sign:
            close(i)
            run_start, run_sign = i, sign

    # A run still open at the last sample is a real section — a track that ends
    # hot would otherwise never be reported, because nothing closes the run.
    close(len(values))
    return found


def _loudest_sample_time(a: dict) -> float | None:
    """When the highest sample peak happens, from the envelope."""
    env = a.get("envelopes", {}) or {}
    chans = env.get("channels") or []
    per_sec = env.get("points_per_second") or 0
    if not chans or not per_sec:
        return None
    best_i, best_v = None, -1e9
    for ch in chans:
        peaks = ch.get("peak") or []
        for i, v in enumerate(peaks):
            if v > best_v:
                best_i, best_v = i, v
    return None if best_i is None else best_i / float(per_sec)


MAX_PER_KIND = 2           # how many rows one repeating finding may occupy


def _kind(item: dict) -> str:
    """What sort of finding this is, for merging. Two findings of different
    kinds at the same second are two facts, not a duplicate."""
    title = item["title"].lower()
    for key in ("clipping", "loudest", "quietest", "opens at",
                "above target", "below target", "peak reaches",
                "fades out", "ends at"):
        if key in title:
            return key
    return "other"


def _thin_repeats(items: list[dict], target: float = -14.0) -> list[dict]:
    """Collapse a repeated finding into its worst few plus a tally."""
    breaches = [i for i in items if "above target" in i["title"]
                or "below target" in i["title"]]
    if len(breaches) <= MAX_PER_KIND:
        return items

    # Worst first by how far the section sat FROM TARGET. Ranking on the bare
    # LUFS magnitude gets this backwards: on a track running hot, -8.8 LUFS is
    # further off a -14 target than -11.1 is, but has the smaller absolute value.
    def offness(item: dict) -> float:
        try:
            peak = float(item["title"].split("peaks")[1].split("LUFS")[0])
        except (IndexError, ValueError):
            return 0.0
        return abs(peak - target)

    worst = sorted(breaches, key=offness, reverse=True)[:MAX_PER_KIND]
    dropped = [b for b in breaches if b not in worst]

    kept = [i for i in items if i not in dropped]
    if dropped:
        total = sum(_span_seconds(d) for d in breaches)
        summary = {
            "time_s": dropped[0]["time_s"],
            "severity": "warn",
            "title": f"{len(breaches)} sections run off target",
            "detail": (
                f"Short-term loudness leaves the target band {len(breaches)} times, "
                f"for about {total:.0f} seconds in total. The two furthest off are "
                "listed separately. This is a pattern across the track rather than "
                "one bad moment, so it is a mastering decision, not an edit."),
        }
        kept.append(summary)
        kept.sort(key=lambda v: v["time_s"])
    return kept


def _span_seconds(item: dict) -> float:
    """Recover the span a breach row describes from its own title."""
    try:
        head = item["title"].split(" ")[0]
        m, s = head.split(":")
        return int(m) * 60 + int(s)
    except (ValueError, IndexError):
        return 0.0


def _tidy(items: list[dict], target: float = -14.0) -> list[dict]:
    """Merge near-duplicates, sort by time, cap the length."""
    rank = {"bad": 0, "warn": 1, "ok": 2}
    items.sort(key=lambda v: (v["time_s"], rank.get(v["severity"], 3)))

    merged: list[dict] = []
    for item in items:
        prev = merged[-1] if merged else None
        # Only merge findings that are the same *kind*. The opening and the
        # quietest passage both sit at 0:00 on a track that fades in, and they
        # are two different facts — dropping one because it shares a timestamp
        # loses information rather than tidying it.
        same_kind = prev is not None and _kind(item) == _kind(prev)
        if (prev and same_kind
                and abs(item["time_s"] - prev["time_s"]) < MERGE_WINDOW
                and rank[item["severity"]] >= rank[prev["severity"]]):
            continue        # same moment, same kind, and no worse
        merged.append(item)

    # A track that runs hot in eight choruses produces eight near-identical
    # rows, which pushes everything else off the list and tells you one thing
    # eight times. Keep the worst few of any repeated kind and summarise the
    # rest into a single row.
    merged = _thin_repeats(merged, target)

    if len(merged) > MAX_FINDINGS:
        # Keep every problem, then fill with the most interesting neutral rows.
        bad = [m for m in merged if m["severity"] != "ok"]
        ok = [m for m in merged if m["severity"] == "ok"]
        keep = bad[:MAX_FINDINGS] + ok[: max(0, MAX_FINDINGS - len(bad))]
        merged = sorted(keep, key=lambda v: v["time_s"])

    for m in merged:
        m["time"] = _fmt(m["time_s"])
    return merged


# --------------------------------------------------------------------------
# optional commentary
# --------------------------------------------------------------------------

COMMENT_SYSTEM = """\
You are a mastering engineer annotating a timeline of one track. You are given \
dated findings, each already measured. Write one short sentence per finding \
saying what it means for the record — what a listener would notice, or what to \
do about it.

Rules:
  * Never contradict a number you are given, and never invent one.
  * You cannot hear the audio. Do not describe instruments, arrangement or mood.
  * A codec cutoff cannot be undone with EQ. Never suggest it.
  * Be specific and brief. One sentence. No preamble, no restating the title.

Return JSON: a list of objects {"time_s": <the same value>, "comment": "..."} \
in the same order, and nothing else.\
"""


