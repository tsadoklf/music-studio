#!/usr/bin/env python3
"""Turn a plain-language tone request into equaliser moves.

    eqchat.py --ask "add some high mid and clean the hum"
    eqchat.py --ask "it sounds boxy" --bands current.json
    eqchat.py --ask "brighten it" --analysis analysis.json

"Add more high mid" is a sentence; an equaliser needs a frequency, a gain and a
Q. This does that translation and returns a structured edit the studio can apply
to the live filter chain, so the chat can operate the EQ rather than only
describe what you should do to it.

Two things make this safe enough to apply without confirming:

  * EQ here is an audition. Nothing is written to a file until `music master`
    runs, so a wrong move costs a click of Undo, not a master.
  * The model returns DATA, never a command. Every reply is a band list that is
    validated against hard limits before it reaches the audio graph — a filter
    type that is not a real BiquadFilterNode type, a gain beyond +-12 dB or a
    frequency outside 20 Hz-20 kHz is rejected here rather than passed on.

The band vocabulary deliberately matches the studio panel and WebAudio: the same
`{type, freq, gain, q}` shape the EQ already publishes, so nothing is translated
between what the model says, what you hear, and what the ffmpeg chain does.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import urllib.error
import urllib.request
from pathlib import Path


log = logging.getLogger("eqchat")

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
TIMEOUT = 60

VALID_TYPES = {"peaking", "lowshelf", "highshelf", "lowpass", "highpass",
               "notch", "bandpass", "allpass"}

GAIN_LIMIT = 12.0          # dB, matches the panel's own knob range
FREQ_MIN, FREQ_MAX = 20.0, 20000.0
Q_MIN, Q_MAX = 0.1, 18.0
MAX_BANDS = 10             # the panel's cap


SYSTEM = """\
You are the equaliser on a mastering bench. You translate a plain-language tone \
request into concrete filter bands, and you return DATA ONLY — a JSON object, no \
prose outside it.

Return exactly this shape:

{
  "bands":  [{"type": "...", "freq": 2800, "gain": 2.5, "q": 1.0, "why": "..."}],
  "summary": "one short sentence describing the move in musical terms",
  "replace": false
}

`bands` are the bands to ADD or CHANGE. Set "replace": true only when the user \
asks to start over, clear the EQ, or explicitly replace what is there.

Filter types are WebAudio names: peaking, lowshelf, highshelf, lowpass, \
highpass, notch. Nothing else is valid.

What the words mean, in frequency:

  sub / weight            25-60 Hz
  bass / body / warmth    60-200 Hz
  boxy / muddy            250-500 Hz      (usually a CUT)
  honky / nasal           800-1200 Hz     (usually a CUT)
  low mid                 200-800 Hz
  mid                     800 Hz-2 kHz
  high mid / presence     2-5 kHz
  harsh / brittle         3-6 kHz         (usually a CUT)
  bite / attack           4-8 kHz
  sibilance / ess         5-9 kHz         (usually a CUT, narrow)
  treble / brightness     6-12 kHz
  air / sheen             10-16 kHz       (a high shelf, not a peak)
  hiss                    above 8-10 kHz  (a lowpass or a high shelf cut)
  rumble                  below 30-40 Hz  (a highpass)
  hum                     50 or 60 Hz     (a NOTCH, high Q, plus its harmonics)

How to shape a move:

  * Broad tonal words (warm, bright, full, airy) want a SHELF with a low Q \
(0.5-0.8) and a gentle gain, 1-3 dB.
  * A named problem (hum, sibilance, a ring) wants a NARROW cut: Q 4-10, and \
only as deep as it needs, typically -3 to -8 dB.
  * Presence and body want a peaking band at Q 0.8-1.5 and 1.5-3 dB.
  * Hum is a notch at 50 Hz or 60 Hz. Say which you chose and why; if you \
cannot tell, choose 50 Hz and say the other is one word away.
  * Rumble is a highpass at 25-35 Hz, not a low shelf cut.

Hard rules:

  * Keep gains between -12 and +12 dB, and prefer small. A 2 dB move is a \
mastering decision; 8 dB is a repair.
  * CUT before you boost where the request names a problem. Removing 300 Hz \
makes a mix clearer than adding 3 kHz does, and costs no headroom.
  * Never claim to fix with EQ something EQ cannot reach. If the request is \
about a lossy codec cutoff, distortion, clipping, or noise spread across the \
whole spectrum, return an empty bands list and say so in the summary.
  * If the request is not about tone at all, return empty bands and say what \
you would need.\
"""


class EqChatError(RuntimeError):
    """Anything that should stop the run with a readable message."""


def _clamp(value, lo, hi, default):
    """Coerce to a number inside [lo, hi], or return `default`.

    NaN and infinity are rejected rather than clamped. `max(lo, min(hi, nan))`
    returns `hi` — so a NaN frequency would silently become a real 20 kHz band
    that nobody asked for, which is worse than dropping it.
    """
    import math

    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(v) or math.isinf(v):
        return default
    return max(lo, min(hi, v))


def validate(bands) -> list[dict]:
    """Keep only bands that are real, and bring them inside the limits.

    The model is asked for data, but a model can still return a filter type
    that does not exist or a 40 dB boost. Validating here means nothing
    unreasonable reaches the audio graph, whatever came back.
    """
    out: list[dict] = []
    for raw in (bands or [])[:MAX_BANDS]:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("type", "")).strip().lower()
        if kind not in VALID_TYPES:
            log.debug("dropping band with unknown type %r", kind)
            continue
        freq = _clamp(raw.get("freq"), FREQ_MIN, FREQ_MAX, None)
        if freq is None:
            continue
        band = {
            "type": kind,
            "freq": round(freq, 1),
            "gain": round(_clamp(raw.get("gain"), -GAIN_LIMIT, GAIN_LIMIT, 0.0), 2),
            "q": round(_clamp(raw.get("q"), Q_MIN, Q_MAX, 0.707), 3),
        }
        why = raw.get("why")
        if isinstance(why, str) and why.strip():
            band["why"] = why.strip()[:200]
        # A gain-bearing band at 0 dB does nothing; a lowpass at 0 dB does.
        if band["type"] in ("peaking", "lowshelf", "highshelf") and abs(band["gain"]) < 0.05:
            continue
        out.append(band)
    return out


def _context(bands, analysis) -> str:
    """What the model needs to know about the current state."""
    lines = []
    if bands:
        lines.append("Bands currently set:")
        for b in bands:
            lines.append(
                f"  {b.get('type')} {b.get('freq')} Hz "
                f"{b.get('gain'):+.1f} dB Q {b.get('q')}")
    else:
        lines.append("The equaliser is currently flat.")

    if analysis:
        codec = (analysis.get("codec") or {})
        m = (analysis.get("measures") or {})
        if codec.get("lossy_suspected"):
            lines.append(
                f"NOTE: this file has a codec brick wall at "
                f"{codec.get('cutoff_hz', 0) / 1000:.1f} kHz. Content above it is "
                "gone and no EQ restores it — do not try.")
        if m.get("integrated_lufs") is not None:
            lines.append(f"Integrated loudness {m['integrated_lufs']:.1f} LUFS, "
                         f"true peak {m.get('true_peak_dbtp', 0):+.2f} dBTP.")
        bands_tbl = (analysis.get("spectrum") or {}).get("bands")
        if bands_tbl:
            lines.append("Relative band energy (this file only, not a reference): "
                         + ", ".join(f"{k} {v:.0f}" for k, v in bands_tbl.items()))
    return "\n".join(lines)


def interpret(ask: str, bands=None, analysis=None, model: str | None = None,
              api_key: str | None = None) -> dict:
    from music_studio.insight.advise import DEFAULT_MODEL, _load_env_key

    key = api_key or _load_env_key()
    if not key:
        raise EqChatError(
            "No OPENROUTER_API_KEY. Export it, or put it in a .env beside "
            "the code (git-ignored). See the README.")

    user = f"{_context(bands, analysis)}\n\nRequest: {ask}"
    body = json.dumps({
        "model": model or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")

    req = urllib.request.Request(
        OPENROUTER_CHAT_URL, data=body,
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 "X-Title": "music studio eq"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise EqChatError(f"OpenRouter returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise EqChatError(f"Could not reach OpenRouter: {exc.reason}") from exc

    try:
        text = payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError) as exc:
        raise EqChatError(f"Unexpected response shape: {payload}") from exc

    if text.startswith("```"):
        text = text.split("```")[1]
        text = text.split("\n", 1)[1] if text.lower().startswith("json") else text
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise EqChatError(f"Model did not return JSON: {text[:200]}") from exc

    return {
        "bands": validate(data.get("bands")),
        "summary": str(data.get("summary", "")).strip()[:400],
        "replace": bool(data.get("replace")),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Turn a tone request into equaliser bands.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--ask", required=True, help="What you want, in words.")
    p.add_argument("--bands", type=Path, help="JSON array of the current bands.")
    p.add_argument("--bands-json", dest="bands_json",
                   help="The current bands as inline JSON, for callers that hold "
                        "them in memory rather than on disk.")
    p.add_argument("--analysis", type=Path, help="analysis.json, for context.")
    p.add_argument("--model")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s")
    try:
        bands = None
        if args.bands_json:
            try:
                bands = json.loads(args.bands_json)
            except json.JSONDecodeError:
                raise EqChatError("--bands-json is not valid JSON")
        elif args.bands and args.bands.is_file():
            bands = json.loads(args.bands.read_text(encoding="utf-8"))
        analysis = None
        if args.analysis and args.analysis.is_file():
            analysis = json.loads(args.analysis.read_text(encoding="utf-8"))
        print(json.dumps(interpret(args.ask, bands, analysis, args.model)))
    except EqChatError as exc:
        log.error("%s", exc)
        print(json.dumps({"error": str(exc), "bands": [], "summary": ""}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
