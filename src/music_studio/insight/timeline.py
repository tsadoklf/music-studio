#!/usr/bin/env python3
"""A sentence of commentary per finding, from a model.

    python -m music_studio.insight.timeline --analysis analysis.json
    python -m music_studio.insight.timeline --analysis analysis.json --comment

The findings themselves are `music_studio.audio.timeline`: arithmetic over the
analysis, always available, no key needed. This module is the layer on top that
asks a model to say what each one MEANS, which is the only part that can fail
for reasons outside the audio.

The split is the package boundary. `audio/` computes; `insight/` interprets;
`audio/` never imports `insight/`, so a missing API key costs you commentary
and nothing else.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from music_studio.audio.timeline import (MAX_FINDINGS, MERGE_WINDOW,
                                         ST_TOLERANCE, TimelineError,
                                         find_events)

log = logging.getLogger("timeline")

__all__ = ["add_comments", "build", "main", "find_events", "TimelineError",
           "ST_TOLERANCE", "MERGE_WINDOW", "MAX_FINDINGS"]


def add_comments(items: list[dict], context: dict) -> list[dict]:
    """Ask a model for one sentence per finding. Failure leaves items unchanged."""
    if not items:
        return items
    try:
        from music_studio.insight.advise import AdviseError, DEFAULT_MODEL, _load_env_key
        import json as _json
        import urllib.request

        key = _load_env_key()
        if not key:
            log.warning("no OPENROUTER_API_KEY; skipping commentary")
            return items

        payload = {
            "track": context.get("filename"),
            "target_lufs": context.get("target_lufs"),
            "findings": [
                {"time": i["time"], "time_s": i["time_s"],
                 "severity": i["severity"], "title": i["title"]}
                for i in items
            ],
        }
        body = _json.dumps({
            "model": DEFAULT_MODEL,
            "messages": [
                {"role": "system", "content": COMMENT_SYSTEM},
                {"role": "user", "content": _json.dumps(payload, indent=1)},
            ],
            "temperature": 0.2,
        }).encode("utf-8")

        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions", data=body,
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json",
                     "X-Title": "music studio timeline"},
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
        text = data["choices"][0]["message"]["content"].strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            text = text.split("\n", 1)[1] if text.startswith("json") else text
        comments = _json.loads(text)

        by_time = {round(float(c["time_s"]), 1): c.get("comment", "")
                   for c in comments if isinstance(c, dict)}
        for item in items:
            c = by_time.get(round(item["time_s"], 1))
            if c:
                item["comment"] = c
    except Exception as exc:                        # noqa: BLE001
        # Commentary is a bonus. Losing it must not lose the timeline.
        log.warning("no commentary: %s", exc)
    return items


def build(a: dict, comment: bool = False) -> list[dict]:
    items = find_events(a)
    if comment:
        meta = a.get("metadata", {}) or {}
        add_comments(items, {
            "filename": meta.get("filename"),
            "target_lufs": (a.get("targets", {}) or {}).get("integrated_lufs"),
        })
    return items


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Find dated events in an analysis.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--analysis", type=Path, required=True)
    p.add_argument("--comment", action="store_true", help="Add model commentary.")
    p.add_argument("--out", type=Path, help="Write JSON here instead of stdout.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )
    try:
        if not args.analysis.is_file():
            raise TimelineError(f"No analysis at {args.analysis}")
        a = json.loads(args.analysis.read_text(encoding="utf-8"))
        items = build(a, args.comment)
        text = json.dumps({"timeline": items}, indent=1)
        if args.out:
            args.out.write_text(text, encoding="utf-8")
            print(args.out)
        else:
            print(text)
    except TimelineError as exc:
        log.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
