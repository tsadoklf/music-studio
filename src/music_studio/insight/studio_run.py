#!/usr/bin/env python3
"""One step: analyse a file and write every artefact beside it.

    python -m music_studio.insight.studio_run --in track.wav
    python -m music_studio.insight.studio_run --in track.wav --out-dir out/ --no-advice

This is what the studio page's one button calls, what `music studio` runs, and
what the server exposes through its fixed command table — three callers, one
sequence, so the order cannot be got wrong in two places independently.

    run(...)    the work: importable, returns a dict, raises on failure
    main(argv)  the command line around it

That split is the point of this module. `run()` returns the same summary
`main()` prints, so a caller that wants the result does not have to parse
stdout and a test does not have to spawn a subprocess. Before it existed,
`music studio` reimplemented this sequence inline, and two copies of an
ordering are two chances to get it wrong.

Writes four files:

    analysis.json   the full measurement data, for the page and for tools
    timeline.json   dated findings, so the page can list moments to seek to
    REPORT.md       verdicts and next actions, for a person
    report.ai.md    the same facts plus the rules that bound them, for an agent

`main()` prints a JSON summary on stdout so a caller knows what was written and
what the verdict was without re-reading the files.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

log = logging.getLogger("studio")


def run(src: Path,
        out_dir: Path | None = None,
        advice: bool = True,
        timeline: bool = True) -> dict:
    """Analyse `src`, write the artefacts, and return the summary.

    Raises rather than returning an error dict. A caller that wants the failure
    formatted for a terminal is `main()`; a caller that wants to handle it is
    better served by an exception than by inspecting a boolean it might forget
    to check.

    `advice` and `timeline` are separate flags because they are the two steps
    that call a model. Either can be off without touching the measurement,
    which is what makes this usable with no network and no API key.
    """
    from music_studio.audio.analyze import AnalyzeError, analyze
    from music_studio.insight.report import headline, verdicts, write_reports
    from music_studio.insight.timeline import build as build_timeline

    if not src.is_file():
        raise AnalyzeError(f"No audio at {src}")

    log.info("Analysing %s", src.name)
    data = analyze(src)

    dest = out_dir or src.parent
    dest.mkdir(parents=True, exist_ok=True)
    analysis_path = dest / "analysis.json"
    analysis_path.write_text(json.dumps(data, separators=(",", ":")),
                             encoding="utf-8")

    note = None
    if advice:
        from music_studio.insight.advise import (DEFAULT_MODEL, AdviseError,
                                                 advise as _advise)
        try:
            log.info("Asking for advice")
            note = _advise(data, None, DEFAULT_MODEL)
        except AdviseError as exc:
            # Advice is a bonus. Losing it must not lose the analysis, which is
            # the part that cost real time to compute.
            log.warning("no advice: %s", exc)

    events: list[dict] = []
    timeline_path = dest / "timeline.json"
    if timeline:
        events = build_timeline(data, comment=advice)
        timeline_path.write_text(json.dumps({"timeline": events}, indent=1),
                                 encoding="utf-8")

    written = write_reports(data, dest, note)
    vs = verdicts(data)

    return {
        "ok": True,
        "headline": headline(vs),
        "verdicts": vs,
        "timeline": events,
        "advice": note,
        "files": {
            "analysis": str(analysis_path),
            "human": str(written["human"]),
            "ai": str(written["ai"]),
            "timeline": str(timeline_path),
        },
    }


def main(argv: list[str] | None = None) -> int:
    """The command line. One JSON object on stdout, success or failure alike.

    Stdout is a protocol channel here — the server parses it — so nothing else
    may be written there, and logging goes to stderr.
    """
    p = argparse.ArgumentParser(
        description="Analyse a file and write analysis.json, REPORT.md and report.ai.md.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--in", dest="src", type=Path, required=True, help="Audio file.")
    p.add_argument("--out-dir", type=Path, help="Where to write. Default: beside the audio.")
    p.add_argument("--no-advice", action="store_true", help="Skip the model call.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    try:
        result = run(args.src, args.out_dir, advice=not args.no_advice)
    except Exception as exc:                       # noqa: BLE001
        log.error("%s", exc)
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
