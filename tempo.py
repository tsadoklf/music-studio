#!/usr/bin/env python3
"""Estimate tempo, metre and musical key from audio.

    tempo.py --in track.wav
    tempo.py --in track.wav --json

Two estimates, both honest about how sure they are.

TEMPO comes from an onset envelope — the frame-to-frame rise in spectral energy,
which peaks when something is struck or plucked — autocorrelated to find the lag
that best explains the spacing of those peaks. Autocorrelation is used rather
than a comb filter because it degrades gracefully: on rubato material it simply
returns a weak peak, and a weak peak is reported as low confidence rather than
as a confident wrong number.

KEY comes from a chroma vector: energy folded onto the twelve pitch classes,
correlated against the Krumhansl-Kessler profiles for each major and minor key.
The profiles come from listener ratings of how well each pitch class fits a key,
so this measures tonal fit rather than counting notes.

Neither is a transcription. A tempo of 128 BPM on a track in 4/4 is worth
believing; a key on a drone or a heavily modal piece is worth a second look, and
the confidence figure is there to say so.

Requires numpy, scipy and soundfile — the same set the rest of the shop uses.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

log = logging.getLogger("tempo")

HOP = 512               # onset envelope resolution, samples at the analysis rate
ANALYSIS_RATE = 22050   # downsampled; nothing above ~11 kHz helps either estimate
BPM_MIN, BPM_MAX = 55.0, 200.0

# Krumhansl-Kessler key profiles: how well each scale degree fits a key,
# from listener ratings rather than from music theory.
KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


class TempoError(RuntimeError):
    """Anything that should stop the run with a readable message."""


@dataclass(frozen=True)
class Tempo:
    bpm: float | None
    confidence: float
    meter: str | None
    beat_times: list


@dataclass(frozen=True)
class Key:
    name: str | None
    confidence: float
    alternatives: list


# --------------------------------------------------------------------------

def _load(path: Path):
    import numpy as np
    import soundfile as sf
    from scipy import signal

    if not path.is_file():
        raise TempoError(f"File not found: {path}")
    data, rate = sf.read(str(path), always_2d=True, dtype="float64")
    mono = data.mean(axis=1)

    if rate != ANALYSIS_RATE:
        # Rational resample keeps this exact and fast; the ratio is small.
        g = np.gcd(int(rate), ANALYSIS_RATE)
        mono = signal.resample_poly(mono, ANALYSIS_RATE // g, int(rate) // g)
    return mono, ANALYSIS_RATE


def onset_envelope(mono, rate: int):
    """Spectral flux: the positive frame-to-frame change in magnitude.

    Only rises count. A note ending is not an onset, and counting it would
    double the apparent event rate and halve the tempo.
    """
    import numpy as np
    from scipy import signal

    n_fft = 1024
    f, t, Z = signal.stft(mono, fs=rate, nperseg=n_fft, noverlap=n_fft - HOP)
    mag = np.abs(Z)
    # Log compression: a drum hit and a quiet tap should both register as events.
    mag = np.log1p(mag * 10.0)
    flux = np.diff(mag, axis=1)
    flux = np.maximum(flux, 0.0).sum(axis=0)
    if flux.size == 0:
        return np.array([]), np.array([])
    # Remove the slow drift so a crescendo does not read as a run of onsets.
    win = max(3, int(round(rate / HOP)) | 1)
    baseline = signal.medfilt(flux, kernel_size=win)
    env = np.maximum(flux - baseline, 0.0)
    times = t[1:]
    return env, times


def estimate_tempo(mono, rate: int) -> Tempo:
    import numpy as np

    env, times = onset_envelope(mono, rate)
    if env.size < 16:
        return Tempo(None, 0.0, None, [])

    # How strong the onsets are, measured before mean-subtraction.
    #
    # Not a peak-to-median ratio: after median-filtering, the envelope's median
    # is ~0 and that ratio explodes into meaningless magnitudes — measured, a
    # drone scored 8.1e8 and a clean click track 1.9e7, i.e. backwards. What
    # separates them is the absolute height of the onsets: a percussive attack
    # produces a flux spike an order of magnitude above anything a sustained
    # tone can (8.19 vs 0.81 on the same fixtures).
    strength = float(env.max()) if env.size else 0.0

    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[env.size - 1:]
    if ac[0] <= 0:
        return Tempo(None, 0.0, None, [])
    ac = ac / ac[0]

    fps = rate / HOP
    lag_min = int(round(60.0 / BPM_MAX * fps))
    lag_max = int(round(60.0 / BPM_MIN * fps))
    lag_max = min(lag_max, ac.size - 1)
    if lag_max <= lag_min:
        return Tempo(None, 0.0, None, [])

    window = ac[lag_min:lag_max]
    best = int(np.argmax(window)) + lag_min
    bpm = 60.0 * fps / best

    # Confidence: how far the winning lag stands above the rest of the field.
    # A rubato performance produces a broad, flat autocorrelation and scores low.
    peak = float(window.max())
    field = float(np.median(window))
    spread = float(window.std()) or 1e-9
    confidence = max(0.0, min(1.0, (peak - field) / (4.0 * spread)))

    # A sustained tone has no onsets, so the envelope is near-silent and its
    # autocorrelation is shaped by noise — which can still throw up a sharp
    # peak and score well on the test above. Measured on a pure drone that
    # produced "198.8 BPM, confidence 0.56", which is a confident lie.
    #
    # Require that something actually happened. Below this there is no attack
    # in the signal, so there is no pulse to find whatever the correlation says.
    ONSET_FLOOR = 4.0
    if strength < ONSET_FLOOR:
        confidence *= max(0.0, strength / ONSET_FLOOR)

    # Octave correction. Autocorrelation is just as happy at half or double the
    # true tempo — a 120 BPM click correlates perfectly at 60, since every
    # second beat also lines up. Left alone this reports half-time confidently.
    #
    # Score every octave of the winning lag by how well the autocorrelation
    # supports it AND how plausible the tempo is, then take the best. The
    # plausibility term is what breaks the tie the correlation cannot: both
    # lags fit the signal, but most music is not at 60 BPM.
    def plausible(b: float) -> float:
        """A soft preference for the range most music occupies, centred at 120."""
        import math
        return math.exp(-((math.log2(b / 120.0)) ** 2) / 0.5)

    candidates = []
    for factor in (0.25, 0.5, 1.0, 2.0, 4.0):
        cand_bpm = bpm * factor
        if not (BPM_MIN <= cand_bpm <= BPM_MAX):
            continue
        cand_lag = int(round(60.0 * fps / cand_bpm))
        if not (lag_min <= cand_lag < lag_max):
            continue
        support = float(ac[cand_lag])
        # A candidate must still be genuinely supported by the signal; the
        # plausibility term only chooses between lags the audio already fits.
        if support < peak * 0.5:
            continue
        candidates.append((support * plausible(cand_bpm), cand_bpm, cand_lag))

    if candidates:
        candidates.sort(reverse=True)
        _, bpm, best = candidates[0]

    meter = _guess_meter(ac, best, lag_max)
    beats = _beat_times(env, times, best)
    return Tempo(round(bpm, 1), round(confidence, 2), meter, beats)


def _guess_meter(ac, beat_lag: int, lag_max: int) -> str | None:
    """Which grouping of beats the autocorrelation also likes.

    A bar boundary recurs, so a track in 3 shows a secondary peak at 3x the
    beat lag and one in 4 at 4x. This is a weak signal and is reported as a
    guess rather than a finding.
    """
    best_group, best_score = None, 0.0
    for group in (3, 4):
        lag = beat_lag * group
        if lag >= lag_max:
            continue
        score = float(ac[lag])
        if score > best_score:
            best_group, best_score = group, score
    if best_group is None or best_score < 0.1:
        return None
    return f"{best_group}/4"


def _beat_times(env, times, beat_lag: int) -> list:
    """Beat positions, by walking the onset envelope one beat at a time."""
    import numpy as np

    if env.size == 0 or beat_lag <= 0:
        return []
    beats = []
    i = int(np.argmax(env[:beat_lag * 2])) if env.size > beat_lag * 2 else 0
    while i < env.size:
        beats.append(float(times[min(i, times.size - 1)]))
        # Snap to the strongest onset within a small window of the next beat,
        # so a slightly elastic performance does not accumulate drift.
        nxt = i + beat_lag
        lo, hi = max(0, nxt - beat_lag // 8), min(env.size, nxt + beat_lag // 8)
        i = (lo + int(np.argmax(env[lo:hi]))) if hi > lo else nxt
        if len(beats) > 4000:
            break
    return [round(b, 3) for b in beats]


def estimate_key(mono, rate: int) -> Key:
    import numpy as np
    from scipy import signal

    n_fft = 4096
    f, t, Z = signal.stft(mono, fs=rate, nperseg=n_fft, noverlap=n_fft // 2)
    mag = np.abs(Z)
    if mag.size == 0:
        return Key(None, 0.0, [])

    # Fold every bin onto its pitch class. Below C2 and above C7 contributes
    # little but noise and octave errors.
    freqs = f
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69.0 + 12.0 * np.log2(np.maximum(freqs, 1e-9) / 440.0)
    usable = (freqs > 65.0) & (freqs < 2100.0)
    pitch_class = np.mod(np.round(midi[usable]).astype(int), 12)

    chroma = np.zeros(12)
    energy = mag[usable].mean(axis=1)
    for pc, e in zip(pitch_class, energy):
        chroma[pc] += e
    total = chroma.sum()
    if total <= 0:
        return Key(None, 0.0, [])
    chroma /= total

    scores = []
    for tonic in range(12):
        for profile, quality in ((KK_MAJOR, "major"), (KK_MINOR, "minor")):
            rolled = np.roll(chroma, -tonic)
            r = float(np.corrcoef(rolled, profile)[0, 1])
            if not np.isnan(r):
                scores.append((r, f"{NOTES[tonic]} {quality}"))
    if not scores:
        return Key(None, 0.0, [])

    scores.sort(reverse=True)
    best_r, best_name = scores[0]
    runner_r = scores[1][0] if len(scores) > 1 else 0.0

    # White noise spreads energy evenly over all twelve pitch classes, which
    # correlates weakly but *equally* with every profile — so the margin over
    # the runner-up can still look decent while the fit itself is meaningless.
    # Measured: noise came back "A minor, confidence 0.67". Require a real fit
    # as well as a real margin.
    if best_r < 0.55:
        return Key(best_name, 0.0, [n for _, n in scores[1:3]])
    # Confidence is the margin over the next-best key, not the raw correlation:
    # a piece can fit two relative keys almost equally, and that ambiguity is
    # the thing worth reporting.
    confidence = max(0.0, min(1.0, (best_r - runner_r) * 3.0))
    return Key(best_name, round(confidence, 2), [n for _, n in scores[1:3]])


def analyse(path: Path) -> dict:
    mono, rate = _load(path)
    tempo = estimate_tempo(mono, rate)
    key = estimate_key(mono, rate)
    return {"tempo": asdict(tempo), "key": asdict(key)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Estimate tempo, metre and key.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--in", dest="src", type=Path, required=True)
    p.add_argument("--json", action="store_true", help="Emit JSON only.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )
    try:
        result = analyse(args.src)
        if args.json:
            print(json.dumps(result))
        else:
            t, k = result["tempo"], result["key"]
            print(f"tempo  {t['bpm'] or '—'} BPM  {t['meter'] or '—'}"
                  f"   (confidence {t['confidence']:.2f}, {len(t['beat_times'])} beats)")
            print(f"key    {k['name'] or '—'}"
                  f"   (confidence {k['confidence']:.2f}"
                  + (f", or {', '.join(k['alternatives'])}" if k['alternatives'] else "")
                  + ")")
    except TempoError as exc:
        log.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
