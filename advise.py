#!/usr/bin/env python3
"""Ask a model what an analysis means, and what to do about it.

The measurements say what is true; this says what to do. It takes the JSON
`analyze.py` produces, strips it to the numbers that carry a decision, and asks
for an answer in terms of the commands this shop actually runs.

    advise.py --analysis analysis.json
    advise.py --analysis analysis.json --ask "why does this sound dull?"
    advise.py --analysis analysis.json --json      # for the player's panel

Two rules shape the prompt, both learned the hard way on this repo:

  * The numbers go in the prompt, and the model is told to quote them. A model
    asked to comment on audio it cannot hear will otherwise invent a reading.
  * It recommends commands; it never runs them. Mastering is destructive enough
    that the decision stays with a person.

Uses OpenRouter, like print-shop/viewer/feedback.py, and the stdlib only.
Needs OPENROUTER_API_KEY in the environment or in print-shop/.env.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("advise")

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("ADVISE_MODEL", "anthropic/claude-sonnet-4.5")
TIMEOUT = 90

SYSTEM = """\
You are the mastering engineer for a small imprint that publishes original music \
to YouTube. You are given measurements of one audio file. You cannot hear it — \
every claim you make must rest on a number in the data, and you should quote the \
number when you make it.

What matters here, in order:

1. True peak above the ceiling. Lossy encoders add overshoot, so anything over \
the stated ceiling will distort on YouTube even when the WAV sounds clean.
2. A codec cutoff. A brick wall in the spectrum means the file has already been \
through MP3/AAC. The lost top octave cannot be restored by EQ — the only fix is \
to go back to the original WAV. Say so plainly rather than suggesting a bright \
EQ, which would be wrong.
3. Loudness against the target. Louder than the target buys nothing: the platform \
turns it down and the dynamics are already spent. Quieter is usually fine.
4. Loudness range and crest factor. A low range on dense material suggests \
over-compression, but sparse arrangements legitimately read low — say which you \
think it is, and why, or say you cannot tell from numbers alone.

The tools available are a CLI called `music`:

  music master <track> --lufs <n> --tp <n> [--eq <preset>]
  music master <track> --eq <preset>        presets: flat, warm, air, clean-lows, narrow-bass
  music compare <track> --null diff.wav     hear exactly what processing changed
  music scope <track>                       re-measure

Two facts about the tooling you must respect:
  * `--eq` runs before the loudness stage, so it never breaks the true-peak ceiling.
  * loudnorm sometimes abandons linear mode and rides the level instead. If the \
source already peaks above the ceiling, no loudness target reaches it linearly, \
and the fix is upstream in the mix rather than a different flag.

Two things you must not do:

  * Do not read the band energy table as an absolute tonal judgement. Those \
figures are relative to this file's own spectrum, not to any reference, and \
every mix reads progressively lower toward the top. "Air is -68 dB" is not \
evidence that a track is dull. Use the table only to compare one file against \
another, and say so when you do.
  * Do not put the analysed filename into a command when your advice is to stop \
using that file. `music` takes a track directory, not a wav path. Write the \
command with a placeholder like <track> and say what it should point at.

Answer in at most 200 words unless asked for more. Lead with the single most \
important thing. When you recommend a command, give it exactly, on its own line, \
ready to paste. If the file is fine, say it is fine and stop — do not invent work.\
"""


class AdviseError(RuntimeError):
    """Anything that should stop the run with a readable message."""


def _load_env_key() -> str | None:
    """Read OPENROUTER_API_KEY from the environment, else print-shop/.env.

    The key lives in one place in this repo and nothing else should copy it.
    """
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key.strip()
    env = Path(__file__).resolve().parents[2] / "print-shop" / ".env"
    if not env.is_file():
        return None
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def digest(analysis: dict) -> dict:
    """Reduce a 2.5 MB analysis to the handful of numbers that carry a decision.

    The spectrogram and the envelopes are for eyes, not for a prompt: they are
    most of the file and none of the argument.
    """
    m = analysis.get("measures", {}) or {}
    codec = analysis.get("codec", {}) or {}
    clip = analysis.get("clipping", {}) or {}
    stereo = analysis.get("stereo", {}) or {}
    meta = analysis.get("metadata", {}) or {}
    loud = analysis.get("loudness", {}) or {}
    targets = analysis.get("targets", {}) or {}
    bands = (analysis.get("spectrum", {}) or {}).get("bands", {})

    return {
        "file": meta.get("filename"),
        "duration_s": meta.get("duration"),
        "sample_rate": meta.get("sample_rate"),
        "channels": meta.get("channels"),
        "bit_depth": meta.get("bit_depth"),
        "target_lufs": targets.get("integrated_lufs"),
        "target_true_peak_dbtp": targets.get("true_peak_dbtp"),
        "integrated_lufs": m.get("integrated_lufs"),
        "true_peak_dbtp": m.get("true_peak_dbtp"),
        "true_peak_is_estimate": m.get("true_peak_is_estimate"),
        "lra": m.get("lra"),
        "rms_db": m.get("rms"),
        "peak_db": m.get("peak"),
        "crest_factor_db": m.get("crest_factor"),
        "max_momentary_lufs": loud.get("max_momentary"),
        "max_short_term_lufs": loud.get("max_short_term"),
        "codec_cutoff_hz": codec.get("cutoff_hz"),
        "codec_confidence": codec.get("confidence"),
        "codec_verdict": codec.get("verdict"),
        "clipped_samples": clip.get("clipped_samples"),
        "clipped_runs": clip.get("runs"),
        "stereo_correlation": stereo.get("correlation"),
        "stereo_width": stereo.get("width"),
        "channel_balance_db": stereo.get("balance_db"),
        "band_energy_db": bands,
    }


def advise(analysis: dict, question: str | None = None,
           model: str = DEFAULT_MODEL, api_key: str | None = None) -> str:
    key = api_key or _load_env_key()
    if not key:
        raise AdviseError(
            "No OPENROUTER_API_KEY. Put it in the environment or in "
            "print-shop/.env, the same key viewer/feedback.py uses."
        )

    ask = question or (
        "Is this ready to upload to YouTube? If not, what is wrong and what "
        "should I run?"
    )

    # With nothing loaded this is a conversation, not a report reading. Sending
    # a block of nulls while instructing the model to quote numbers produces
    # either a refusal or an invention; saying plainly that there are no
    # measurements gets a useful answer to a general question instead.
    if not analysis or not (analysis.get("measures") or analysis.get("metadata")):
        user = (
            "No file is loaded, so there are no measurements to reason about.\n"
            "Answer from general knowledge of mastering and this shop's tools. "
            "Do not invent readings for a track you have not been given, and if "
            "the question needs measurements, say which and how to get them "
            "(`music studio <file>`).\n\n"
            f"Question: {ask}"
        )
    else:
        user = (
            "Measurements of one audio file, as JSON:\n\n"
            + json.dumps(digest(analysis), indent=1)
            + f"\n\nQuestion: {ask}"
        )

    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
    }).encode("utf-8")

    req = urllib.request.Request(
        OPENROUTER_CHAT_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "X-Title": "song-shop bench monitor",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise AdviseError(f"OpenRouter returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise AdviseError(f"Could not reach OpenRouter: {exc.reason}") from exc

    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError) as exc:
        raise AdviseError(f"Unexpected response shape: {payload}") from exc


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Ask a model what an analysis means and what to run next.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--analysis", type=Path,
                   help="analysis.json from analyze.py. Optional: without it the "
                        "model answers from general knowledge instead of measurements.")
    p.add_argument("--ask", help="A question. Defaults to 'is this ready to upload?'")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--json", action="store_true",
                   help="Emit {answer, facts} as JSON, for the player panel.")
    p.add_argument("--facts-only", action="store_true",
                   help="Print the digested numbers without calling a model.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    try:
        # No analysis is a legitimate state, not an error. The studio's chat
        # box is a conversation before it is a report reader: a question asked
        # with nothing loaded should be answered from general knowledge rather
        # than refused, and refusing it was exactly the "say Hi, get a usage
        # error" behaviour this is here to prevent.
        if args.analysis is None:
            analysis = {}
        elif not args.analysis.is_file():
            raise AdviseError(f"No analysis at {args.analysis}")
        else:
            analysis = json.loads(args.analysis.read_text(encoding="utf-8"))

        if args.facts_only:
            print(json.dumps(digest(analysis), indent=1))
            return 0

        answer = advise(analysis, args.ask, args.model)
        if args.json:
            print(json.dumps({"answer": answer, "facts": digest(analysis)}))
        else:
            print(answer)
    except AdviseError as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.error("Interrupted.")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
