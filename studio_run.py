#!/usr/bin/env python3
"""One step: analyse a file and write every artefact beside it.

    studio_run.py --in track.wav
    studio_run.py --in track.wav --out-dir reports/ --no-advice

This is what the studio page's one button calls, and what `music studio` runs.
It exists as its own script so the server can expose it through the same fixed
command table as everything else, rather than the page learning to orchestrate
three calls and getting the order wrong.

Writes three files:

    analysis.json   the full measurement data, for the page and for tools
    REPORT.md       verdicts and next actions, for a person
    report.ai.md    the same facts plus the rules that bound them, for an agent

Prints a JSON summary on stdout so a caller knows what was written and what the
verdict was, without re-reading the files.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

log = logging.getLogger("studio")


def main(argv: list[str] | None = None) -> int:
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

    from analyze import AnalyzeError, analyze
    from report import headline, verdicts, write_reports
    from timeline import build as build_timeline

    try:
        if not args.src.is_file():
            raise AnalyzeError(f"No audio at {args.src}")

        log.info("Analysing %s", args.src.name)
        data = analyze(args.src)

        dest = args.out_dir or args.src.parent
        dest.mkdir(parents=True, exist_ok=True)
        analysis_path = dest / "analysis.json"
        analysis_path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

        advice = None
        if not args.no_advice:
            from advise import DEFAULT_MODEL, AdviseError, advise
            try:
                log.info("Asking for advice")
                advice = advise(data, None, DEFAULT_MODEL)
            except AdviseError as exc:
                # Advice is a bonus. Losing it must not lose the analysis.
                log.warning("no advice: %s", exc)

        # Dated findings, so the page can list moments you can seek to.
        events = build_timeline(data, comment=not args.no_advice)
        (dest / "timeline.json").write_text(
            json.dumps({"timeline": events}, indent=1), encoding="utf-8")

        written = write_reports(data, dest, advice)
        vs = verdicts(data)

        print(json.dumps({
            "ok": True,
            "headline": headline(vs),
            "verdicts": vs,
            "timeline": events,
            "advice": advice,
            "files": {
                "analysis": str(analysis_path),
                "human": str(written["human"]),
                "ai": str(written["ai"]),
                "timeline": str(dest / "timeline.json"),
            },
        }))
    except Exception as exc:                       # noqa: BLE001
        log.error("%s", exc)
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
