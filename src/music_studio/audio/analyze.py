#!/usr/bin/env python3
"""Analyse a track once, completely, and hand the numbers to a browser.

The point of this module is that listening is not measurement. You cannot hear
whether a file has been through a lossy codec, you cannot hear three clipped
samples, and you cannot hear a 0.4 LU difference — but all three decide whether
a master is fit to publish. So we measure everything in one pass and emit one
JSON document that a player can render: waveform envelopes for the meters, a
loudness curve for the timeline, a spectrogram for the eye, and a short list of
verdicts for the parts that are pass/fail.

The codec check is the one that earns its keep. A file that dies at 16 kHz has
been through an MP3 or an AAC somewhere in its history, whatever the extension
says now, and no amount of mastering puts that back. We diagnosed exactly this
on a real track: it arrived as a WAV, so it looked lossless, and the spectrum
showed a brick wall at 16 kHz.

Loudness follows ITU-R BS.1770-4 / EBU R128 properly: K-weighting (a +4 dB
high shelf at 1.5 kHz, then a 38 Hz high-pass), 400 ms momentary blocks, 3 s
short-term blocks, and the two-stage gate for the integrated figure. The filter
coefficients are re-derived at the file's own sample rate rather than assuming
48 kHz, so a 44.1 kHz file is measured correctly instead of approximately.

Usage:
    analyze.py --in masters/master.wav
    analyze.py --in master.wav --out analysis.json --indent 2
    analyze.py --in master.wav --out analysis.json --spectrogram-frames 800

Requires ffmpeg (for the integrated/true-peak figures, via master.py) and
    pip install soundfile numpy scipy
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("analyze")

# --- R128 / BS.1770 constants ------------------------------------------------

MOMENTARY_WINDOW = 0.400   # s, the "M" meter
SHORT_TERM_WINDOW = 3.000  # s, the "S" meter
BLOCK_OVERLAP = 0.75       # BS.1770 gating blocks overlap by 75%
ABSOLUTE_GATE = -70.0      # LUFS
RELATIVE_GATE = -10.0      # LU below the ungated mean
CHANNEL_WEIGHTS = (1.0, 1.0, 1.0, 1.41, 1.41)  # L R C Ls Rs

# --- output sizing -----------------------------------------------------------

MAX_LOUDNESS_POINTS = 2000
ENVELOPE_RATE = 100        # points per second, before downsampling
MAX_ENVELOPE_POINTS = 4000
SPECTROGRAM_BINS = 256
MAX_SPECTROGRAM_FRAMES = 1500
SPECTRUM_FLOOR = -120.0    # dB; anything quieter is noise in a float32 render

# --- codec detection ---------------------------------------------------------

CUTOFF_DROP_DB = 25.0      # a cliff this deep counts as a brick wall
CUTOFF_SEARCH_LOW = 8000.0 # below this, a cliff is musical content, not a codec
CUTOFF_BENIGN = 19000.0    # a cliff above this is inaudible; report it, don't alarm


class AnalyzeError(RuntimeError):
    """Anything that should stop the run with a readable message."""


# --------------------------------------------------------------------------
# dataclasses
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Metadata:
    path: str
    duration: float
    sample_rate: int
    channels: int
    bit_depth: int
    subtype: str
    frames: int


@dataclass(frozen=True)
class Cutoff:
    cutoff_hz: float
    confidence: float
    drop_db: float
    verdict: str


@dataclass(frozen=True)
class Clipping:
    clipped_samples: int
    clipped_fraction: float
    runs: int
    longest_run: int
    worst: tuple


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def _round(value, places: int = 2):
    """Round for JSON. 17 significant digits of float noise helps nobody."""
    import math

    if value is None:
        return None
    v = float(value)
    if math.isnan(v) or math.isinf(v):
        return None
    return round(v, places)


def _db(value, floor: float = 1e-12) -> float:
    import numpy as np

    return float(20.0 * np.log10(max(float(value), floor)))


def _load(path: Path):
    """Read the whole file as float64, always 2-D, plus its container facts."""
    import soundfile as sf

    if not path.is_file():
        raise AnalyzeError(f"File not found: {path}")
    try:
        info = sf.info(str(path))
        data, rate = sf.read(str(path), always_2d=True, dtype="float64")
    except RuntimeError as exc:
        raise AnalyzeError(f"Could not read {path.name}: {exc}") from exc
    if data.size == 0:
        raise AnalyzeError(f"{path.name} contains no audio.")
    return data, int(rate), info


def _bit_depth(subtype: str) -> int:
    """Bit depth from the soundfile subtype. Float formats report their width."""
    table = {
        "PCM_S8": 8, "PCM_U8": 8, "PCM_16": 16, "PCM_24": 24, "PCM_32": 32,
        "FLOAT": 32, "DOUBLE": 64,
        "ALAW": 8, "ULAW": 8, "IMA_ADPCM": 4, "MS_ADPCM": 4,
        "VORBIS": 0, "MPEG_LAYER_III": 0, "OPUS": 0,
    }
    return table.get(str(subtype).upper(), 0)


def _downsample(values, limit: int):
    """Shrink a series to at most `limit` points, keeping the peaks.

    Plain decimation would drop exactly the transients a meter exists to show,
    so each output point is the maximum of the samples it stands for. For a
    loudness or envelope curve that is the honest reduction: the browser sees
    the loudest thing that happened in that slice, not whichever sample the
    stride happened to land on.
    """
    import numpy as np

    arr = np.asarray(values, dtype=np.float64)
    if arr.size <= limit or limit <= 0:
        return arr
    edges = np.linspace(0, arr.size, limit + 1).astype(int)
    out = np.empty(limit, dtype=np.float64)
    for i in range(limit):
        lo, hi = edges[i], max(edges[i] + 1, edges[i + 1])
        out[i] = arr[lo:hi].max()
    return out


# --------------------------------------------------------------------------
# K-weighting — ITU-R BS.1770-4
# --------------------------------------------------------------------------

def k_weighting_coefficients(rate: int):
    """The two BS.1770 biquads, derived at this sample rate.

    The standard publishes its coefficients as a table at 48 kHz only. Re-using
    that table at 44.1 kHz is the usual shortcut and it puts the shelf and the
    high-pass in slightly the wrong place. Instead we re-derive both stages from
    the analogue prototype, which reproduces the published 48 kHz table to about
    1e-12 and is correct at every other rate as well.

    Stage 1 is a high shelf, +3.999 dB above roughly 1.5 kHz: the head-related
    boost that makes treble count for more. Stage 2 is the RLB high-pass at
    roughly 38 Hz, which stops subsonic rumble inflating the reading.
    """
    import numpy as np

    if rate <= 0:
        raise AnalyzeError(f"Nonsensical sample rate: {rate}")

    # Stage 1 — high shelf.
    f0, gain_db, q = 1681.9744509555319, 3.99984385397, 0.7071752369554193
    k = np.tan(np.pi * f0 / rate)
    vh = 10.0 ** (gain_db / 20.0)
    vb = vh ** 0.499666774155
    a0 = 1.0 + k / q + k * k
    b1 = np.array([
        (vh + vb * k / q + k * k) / a0,
        2.0 * (k * k - vh) / a0,
        (vh - vb * k / q + k * k) / a0,
    ])
    a1 = np.array([
        1.0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    ])

    # Stage 2 — RLB high-pass.
    f0, q = 38.13547087602444, 0.5003270373238773
    k = np.tan(np.pi * f0 / rate)
    a0 = 1.0 + k / q + k * k
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([
        1.0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    ])
    return (b1, a1), (b2, a2)


def k_weight(data, rate: int):
    """Apply both K-weighting stages down the time axis of each channel."""
    from scipy import signal

    (b1, a1), (b2, a2) = k_weighting_coefficients(rate)
    stage1 = signal.lfilter(b1, a1, data, axis=0)
    return signal.lfilter(b2, a2, stage1, axis=0)


def _block_power(weighted, rate: int, window: float, overlap: float):
    """Channel-weighted mean square per gating block, and each block's start.

    Uses a cumulative sum rather than a loop: on a five-minute stereo track at
    48 kHz this is thousands of overlapping 400 ms windows, and summing each one
    from scratch turns a fast analysis into a slow one.
    """
    import numpy as np

    n = int(round(window * rate))
    if n <= 0 or weighted.shape[0] < n:
        return np.empty(0), np.empty(0)
    hop = max(1, int(round(n * (1.0 - overlap))))
    starts = np.arange(0, weighted.shape[0] - n + 1, hop)

    cumulative = np.concatenate([
        np.zeros((1, weighted.shape[1])),
        np.cumsum(weighted ** 2, axis=0),
    ])
    mean_square = (cumulative[starts + n] - cumulative[starts]) / n

    weights = np.array(
        [CHANNEL_WEIGHTS[i] if i < len(CHANNEL_WEIGHTS) else 1.0
         for i in range(weighted.shape[1])]
    )
    return (mean_square * weights).sum(axis=1), starts / float(rate)


def _loudness_from_power(power):
    import numpy as np

    return -0.691 + 10.0 * np.log10(np.maximum(power, 1e-20))


def loudness_series(data, rate: int, window: float):
    """The M or S meter curve: block loudness in LUFS, and block start times."""
    weighted = k_weight(data, rate)
    power, times = _block_power(weighted, rate, window, BLOCK_OVERLAP)
    return _loudness_from_power(power), times


def integrated_loudness(data, rate: int) -> float:
    """BS.1770 integrated loudness, with both gates.

    The absolute gate drops silence; the relative gate then drops everything
    more than 10 LU below what is left, so a track's quiet intro does not drag
    the number down. Gating is what makes the figure match how loud the track
    actually seems.
    """
    import numpy as np

    weighted = k_weight(data, rate)
    power, _ = _block_power(weighted, rate, MOMENTARY_WINDOW, BLOCK_OVERLAP)
    if power.size == 0:
        return float("nan")

    loud = _loudness_from_power(power)
    above_absolute = loud > ABSOLUTE_GATE
    if not above_absolute.any():
        return float("nan")

    threshold = (-0.691 + 10.0 * np.log10(power[above_absolute].mean())
                 + RELATIVE_GATE)
    keep = above_absolute & (loud > threshold)
    if not keep.any():
        return float("nan")
    return float(-0.691 + 10.0 * np.log10(power[keep].mean()))


def loudness_range(short_term) -> float:
    """EBU Tech 3342 loudness range: the 10th-to-95th percentile spread."""
    import numpy as np

    values = np.asarray(short_term)
    values = values[values > ABSOLUTE_GATE]
    if values.size < 2:
        return 0.0
    powers = 10.0 ** ((values + 0.691) / 10.0)
    threshold = -0.691 + 10.0 * np.log10(powers.mean()) - 20.0
    gated = values[values > threshold]
    if gated.size < 2:
        return 0.0
    return float(np.percentile(gated, 95) - np.percentile(gated, 10))


# --------------------------------------------------------------------------
# envelopes
# --------------------------------------------------------------------------

def channel_envelopes(data, rate: int, points_per_second: int = ENVELOPE_RATE,
                      limit: int = MAX_ENVELOPE_POINTS) -> dict:
    """Peak and RMS per channel per frame, for VU animation.

    Peak and RMS are both kept because they say different things: RMS is what a
    VU needle does and roughly what you hear, peak is what clips. A track whose
    peak sits far above its RMS has transients left in it.
    """
    import numpy as np

    hop = max(1, int(round(rate / float(points_per_second))))
    frames = data.shape[0] // hop
    if frames < 1:
        frames = 1
        hop = data.shape[0]

    usable = data[:frames * hop]
    blocks = usable.reshape(frames, hop, data.shape[1])
    peaks = np.abs(blocks).max(axis=1)
    rms = np.sqrt((blocks ** 2).mean(axis=1))

    out = {
        "points_per_second": _round(min(points_per_second, rate), 3),
        "channels": [],
    }
    step = 1
    for ch in range(data.shape[1]):
        peak_series = _downsample(peaks[:, ch], limit)
        rms_series = _downsample(rms[:, ch], limit)
        step = max(1, frames // max(1, peak_series.size))
        out["channels"].append({
            "peak": [_round(v, 4) for v in peak_series],
            "rms": [_round(v, 4) for v in rms_series],
            "peak_db": [_round(_db(v), 1) for v in peak_series],
            "rms_db": [_round(_db(v), 1) for v in rms_series],
        })
    out["points"] = len(out["channels"][0]["peak"]) if out["channels"] else 0
    out["seconds_per_point"] = _round(hop * step / float(rate), 5)
    return out


# --------------------------------------------------------------------------
# spectrum, spectrogram, codec cliff
# --------------------------------------------------------------------------

def _mono(data):
    return data.mean(axis=1)


def average_spectrum(data, rate: int, bins: int = 512):
    """Welch-averaged magnitude spectrum of the whole file, in dB.

    Averaging many short windows rather than one giant FFT is what makes the
    brick wall visible: a single transform of a five-minute file is dominated by
    whatever leaked into each bin, while the average settles down to the real
    noise floor and the cliff stands out against it.
    """
    import numpy as np
    from scipy import signal

    mono = _mono(data)
    nperseg = min(8192, max(256, 1 << int(np.log2(max(len(mono) // 8, 256)))))
    nperseg = max(16, min(nperseg, len(mono)))  # a very short clip must not raise
    freqs, power = signal.welch(
        mono, fs=rate, nperseg=nperseg,
        noverlap=nperseg // 2, scaling="spectrum",
    )
    magnitude_db = 10.0 * np.log10(np.maximum(power, 1e-20))
    return freqs, magnitude_db


def detect_cutoff(freqs, magnitude_db, rate: int) -> Cutoff:
    """Find the brick wall a lossy codec leaves behind.

    A lossy encoder throws away everything above some frequency, and what it
    leaves is a cliff far steeper than anything music does on its own: the
    spectrum falls off a shelf and then sits flat on the noise floor, and it
    never comes back.

    The measurement has to be *local*. An earlier version of this function
    compared everything against the 200 Hz - 2 kHz midrange and called the first
    point 25 dB below it the cutoff. That works on flat noise through a lowpass
    and fails on music, because real programme material is already 20 dB down at
    6 kHz simply by having a normal spectral tilt — so the test was satisfied
    long before the actual cliff, and the answer came back around 8 kHz no
    matter what the file contained. Instead we compare each point against the
    octave below it. A codec cliff is a fall of tens of dB inside one octave; a
    spectral tilt is a few dB per octave, and passes by unremarked.

    So: walk up from 8 kHz, score every bin by how far it sits below the median
    of the octave beneath it, and take the steepest such edge that also stays
    down afterwards. "Stays down" is what separates a cliff from a dip between
    two resonances.

    Below 8 kHz we do not look at all. Music genuinely runs out of energy up
    there sometimes — a solo cello has little above 10 kHz and is not a codec
    victim — so a cliff at 6 kHz is far more likely to be the material than the
    file's history. Confidence reflects how sharp the cliff is and how dead the
    spectrum is above it; a gentle roll-off scores low, which is the honest
    answer, because a gentle roll-off is what analogue tape and a quiet mix both
    look like.
    """
    import numpy as np

    nyquist = rate / 2.0
    search = freqs >= CUTOFF_SEARCH_LOW
    if freqs.size < 8 or not search.any() or nyquist <= CUTOFF_SEARCH_LOW:
        return Cutoff(nyquist, 0.0, 0.0, "inconclusive")

    bin_width = float(freqs[1] - freqs[0])
    if bin_width <= 0:
        return Cutoff(nyquist, 0.0, 0.0, "inconclusive")

    # Smooth lightly so one empty bin does not read as a cliff.
    if magnitude_db.size >= 5:
        smooth = np.convolve(magnitude_db, np.ones(5) / 5.0, mode="same")
    else:
        smooth = magnitude_db.copy()

    first = int(np.argmax(search))
    last = smooth.size - 1

    # The noise floor: the quietest stretch of the spectrum. Everything below
    # this is "dead", and a cliff has to land on it to count.
    floor_level = float(np.percentile(smooth, 5))

    # Scan for the edge. The test is local on both sides: the octave below a
    # bin is its passband reference, and the *near* side above it — a quarter
    # octave, not everything up to Nyquist — is where the level has to have
    # collapsed. Using a median all the way to Nyquist looks robust and is not:
    # a steep filter drives its stopband so far down that the median is already
    # satisfied thousands of Hz before the real cliff, which reads the cutoff
    # far too low.
    best_index = None
    best_fall = 0.0
    best_below = floor_level
    best_above_octave = floor_level

    for i in range(first, last + 1):
        centre = freqs[i]
        if centre <= 0:
            continue
        # Local passband: the octave below, excluding the transition itself.
        # Use a high percentile, not the median: the passband's own dips must
        # not lower the bar, or the scan triggers inside the music.
        lo = max(0, int(round((centre / 2.0) / bin_width)))
        hi = max(lo + 1, i - max(1, int(round(200.0 / bin_width))))
        if hi - lo < 3:
            continue
        below_octave = float(np.percentile(smooth[lo:hi], 75))

        # Local stopband: a short span just above, where a wall has already hit
        # bottom. Bounded, so an extremely dead top end cannot drag the test
        # down the spectrum.
        near_lo = i
        near_hi = min(smooth.size, i + max(2, int(round(800.0 / bin_width))))
        if near_hi - near_lo < 2:
            continue
        above_level = float(np.median(smooth[near_lo:near_hi]))
        fall = below_octave - above_level
        if fall < CUTOFF_DROP_DB:
            continue

        # It must also stay down: a notch between two resonances recovers.
        rest = smooth[i:]
        if float(np.percentile(rest, 90)) > below_octave - 10.0:
            continue

        # Take the LOWEST qualifying cliff. Once a codec has emptied the top
        # octaves, the dead region contains further apparent "cliffs" — noise
        # floor against noise floor — deeper than the real one. The wall that
        # matters is the first.
        best_index, best_fall = i, fall
        best_below, best_above_octave = above_level, below_octave
        break

    if best_index is None or best_fall < CUTOFF_DROP_DB:
        top = float(np.median(smooth[first:]))
        reference_band = (freqs >= 200.0) & (freqs <= 2000.0)
        mid = (float(np.percentile(magnitude_db[reference_band], 75))
               if reference_band.any() else top)
        return Cutoff(
            nyquist, 0.0, float(mid - top),
            "full bandwidth — no cliff below Nyquist",
        )

    # Report the top of the cliff, not its bottom: the last bin still within
    # 3 dB of the local passband, searched only across the transition itself
    # (a few hundred Hz) so it cannot run away down the spectrum the way a
    # walk back from the cliff bottom did.
    # The scan triggers at the first bin whose *forward median* has collapsed,
    # which is partway down the slope. Find the edge properly: take the local
    # passband as the median of the octave below the cliff, then move outward
    # from the trigger to the last bin still within 6 dB of it. Searching a
    # bounded window (1 kHz) keeps this from running away down the spectrum,
    # which is exactly how an earlier version ended up reporting 8 kHz on
    # every file it was given.
    passband = best_above_octave
    shoulder = passband - 6.0
    span = max(1, int(round(1000.0 / bin_width)))
    lo_limit = max(first, best_index - span)
    hi_limit = min(smooth.size - 1, best_index + span)

    knee = best_index
    # Walk forward while still in the passband (the trigger fired early).
    while knee < hi_limit and smooth[knee] >= shoulder:
        knee += 1
    # Walk back if the trigger fired late (already past the edge).
    while knee > lo_limit and smooth[knee - 1] < shoulder:
        knee -= 1
    cutoff = float(freqs[knee])

    # Detection was deliberately local; the *reported* depth should describe the
    # whole cliff, so measure from the passband down to the dead region above
    # it. A codec wall is 60-100 dB deep even though the trigger only needed 25.
    dead_start = min(knee + max(2, int(round(1500.0 / bin_width))), smooth.size - 1)
    dead = smooth[dead_start:]
    dead_level = float(np.median(dead)) if dead.size else best_below
    drop = float(max(best_fall, best_above_octave - dead_level))
    transition_hz = max(float(freqs[best_index] - freqs[knee]), bin_width)
    steepness = drop * 1000.0 / transition_hz  # dB per kHz

    depth_score = min(1.0, max(0.0, (drop - CUTOFF_DROP_DB) / 40.0))
    steep_score = min(1.0, max(0.0, steepness / 40.0))
    headroom_score = min(1.0, max(0.0, (nyquist - cutoff) / 4000.0))
    confidence = float(
        max(0.0, min(1.0, 0.45 * depth_score + 0.35 * steep_score
                     + 0.20 * headroom_score))
    )

    # A wall above 19 kHz is real but inaudible — 48 kHz material routinely
    # stops around 20 kHz, and every adult listener stops before that. Report
    # the frequency, but do not raise an alarm nobody can hear: confidence here
    # means "this damages the audio", not merely "a filter exists".
    if cutoff >= CUTOFF_BENIGN:
        return Cutoff(
            cutoff, 0.0, drop,
            f"band-limited at {cutoff / 1000.0:.1f} kHz — above hearing, harmless",
        )

    if confidence >= 0.66:
        verdict = (f"brick wall at {cutoff / 1000.0:.1f} kHz — "
                   "this file has been through a lossy codec")
    elif confidence >= 0.33:
        verdict = (f"probable cutoff near {cutoff / 1000.0:.1f} kHz — "
                   "lossy somewhere in its history, or a steep mix filter")
    else:
        verdict = (f"gentle roll-off from {cutoff / 1000.0:.1f} kHz — "
                   "more likely the material than a codec")

    return Cutoff(cutoff, confidence, drop, verdict)


def band_energy(data, rate: int) -> dict:
    """The seven-band table, using compare.py's bands so the two tools agree."""
    import numpy as np
    from music_studio.audio.compare import BANDS

    freqs, magnitude_db = average_spectrum(data, rate)
    power = 10.0 ** (magnitude_db / 10.0)
    out = {}
    for name, low, high in BANDS:
        selected = (freqs >= low) & (freqs < high)
        if selected.any():
            out[name] = _round(10.0 * np.log10(max(power[selected].mean(), 1e-20)), 2)
        else:
            out[name] = None
    return out


def spectrogram(data, rate: int, bins: int = SPECTROGRAM_BINS,
                max_frames: int = MAX_SPECTROGRAM_FRAMES) -> dict:
    """STFT magnitude in dB on a log frequency axis, flattened for JSON.

    Log frequency because that is how hearing works and how the picture reads:
    on a linear axis the bottom three octaves — where nearly all the music is —
    are squeezed into the first few pixels. Values are rounded to one decimal
    and sent as one flat array with a shape, which is several times smaller than
    nested lists of full-precision floats and is what a browser wants anyway to
    push straight into a canvas.
    """
    import numpy as np
    from scipy import signal

    mono = _mono(data)
    # A clip shorter than one segment still has to produce something rather
    # than raising out of scipy, so the segment shrinks to fit very short files.
    nperseg = 2048 if len(mono) >= 4096 else max(16, 1 << int(np.log2(max(len(mono), 16))))
    nperseg = min(nperseg, len(mono))
    if nperseg < 16:
        return {"shape": [0, 0], "layout": "freq-major: db[f * frames + t]",
                "freqs": [], "times": [], "db": [],
                "db_min": None, "db_max": None}

    # Choose a hop that lands near max_frames rather than making a huge STFT
    # and throwing most of it away.
    target_hop = max(nperseg // 2, int(len(mono) / max(1, max_frames)))
    noverlap = max(0, min(nperseg - 1, nperseg - target_hop))

    freqs, times, magnitude = signal.stft(
        mono, fs=rate, nperseg=nperseg, noverlap=noverlap,
        window="hann", padded=False, boundary=None,
    )
    magnitude = np.abs(magnitude)
    if magnitude.size == 0:
        return {"shape": [0, 0], "freqs": [], "times": [], "db": [],
                "db_min": None, "db_max": None}

    # Log-spaced frequency bins, each the max of the linear bins it covers.
    low = max(20.0, float(freqs[1]) if len(freqs) > 1 else 20.0)
    high = float(freqs[-1])
    edges = np.geomspace(low, high, bins + 1)
    indices = np.searchsorted(freqs, edges)
    binned = np.empty((bins, magnitude.shape[1]))
    for i in range(bins):
        lo = indices[i]
        hi = max(lo + 1, indices[i + 1])
        hi = min(hi, magnitude.shape[0])
        lo = min(lo, hi - 1)
        binned[i] = magnitude[lo:hi].max(axis=0)

    # Time frames down to the cap, keeping the loudest frame of each group.
    if binned.shape[1] > max_frames:
        edges_t = np.linspace(0, binned.shape[1], max_frames + 1).astype(int)
        reduced = np.empty((bins, max_frames))
        reduced_times = np.empty(max_frames)
        for i in range(max_frames):
            lo, hi = edges_t[i], max(edges_t[i] + 1, edges_t[i + 1])
            reduced[:, i] = binned[:, lo:hi].max(axis=1)
            reduced_times[i] = times[lo]
        binned, times = reduced, reduced_times

    db = 20.0 * np.log10(np.maximum(binned, 1e-12))
    db = np.maximum(db, SPECTRUM_FLOOR)

    centres = np.sqrt(edges[:-1] * edges[1:])
    return {
        "shape": [int(db.shape[0]), int(db.shape[1])],
        "layout": "freq-major: db[f * frames + t]",
        "freqs": [_round(f, 1) for f in centres],
        "times": [_round(t, 3) for t in times],
        "db_min": _round(float(db.min()), 1),
        "db_max": _round(float(db.max()), 1),
        "db": [round(float(v), 1) for v in db.reshape(-1)],
    }


# --------------------------------------------------------------------------
# clipping
# --------------------------------------------------------------------------

def detect_clipping(data, rate: int, threshold: float = 0.999,
                    run_length: int = 3, worst: int = 10) -> Clipping:
    """Count samples pinned at full scale, and the runs that mean real clipping.

    One sample at 0 dBFS is a coincidence; a run of consecutive samples all at
    the same full-scale value is a flat top, which is an amplifier or a limiter
    having run out of numbers. So we report both, and the timestamps of the
    worst runs, because knowing a track clips is useless next to knowing it
    clips at 2:14 where the snare is.
    """
    import numpy as np

    magnitude = np.abs(data)
    at_ceiling = magnitude >= threshold
    clipped = int(at_ceiling.sum())
    total = int(magnitude.size)

    # Runs are found per channel; a flat top in one channel is still clipping.
    runs = []
    for ch in range(data.shape[1]):
        flags = at_ceiling[:, ch]
        if not flags.any():
            continue
        padded = np.concatenate([[False], flags, [False]])
        edges = np.flatnonzero(padded[1:] != padded[:-1])
        for start, stop in zip(edges[0::2], edges[1::2]):
            length = int(stop - start)
            if length >= run_length:
                runs.append((length, int(start), ch))

    runs.sort(reverse=True)
    worst_runs = tuple(
        {
            "channel": ch,
            "start_sample": start,
            "time": _round(start / float(rate), 3),
            "samples": length,
            "duration_ms": _round(1000.0 * length / float(rate), 3),
        }
        for length, start, ch in runs[:worst]
    )

    return Clipping(
        clipped_samples=clipped,
        clipped_fraction=clipped / float(total) if total else 0.0,
        runs=len(runs),
        longest_run=max((r[0] for r in runs), default=0),
        worst=worst_runs,
    )


# --------------------------------------------------------------------------
# stereo
# --------------------------------------------------------------------------

def stereo_analysis(data, rate: int) -> dict:
    """Correlation, mid/side balance, and the level difference between channels.

    Correlation near +1 is a near-mono mix, near 0 is wide, and negative means
    the channels fight each other and the track will lose bass the moment
    anything sums it to mono — which phones, club systems and most radio do.
    """
    import numpy as np

    if data.shape[1] < 2:
        return {"stereo": False, "reason": "not a two-channel file"}

    left, right = data[:, 0], data[:, 1]
    if left.std() < 1e-12 or right.std() < 1e-12:
        correlation = None
    else:
        correlation = float(np.corrcoef(left, right)[0, 1])

    mid = (left + right) / 2.0
    side = (left - right) / 2.0
    mid_rms = float(np.sqrt(np.mean(mid ** 2)))
    side_rms = float(np.sqrt(np.mean(side ** 2)))

    left_lufs = integrated_loudness(left.reshape(-1, 1), rate)
    right_lufs = integrated_loudness(right.reshape(-1, 1), rate)
    difference = (left_lufs - right_lufs
                  if np.isfinite(left_lufs) and np.isfinite(right_lufs)
                  else None)

    if correlation is None:
        note = "a channel is silent"
    elif correlation > 0.95:
        note = "effectively mono"
    elif correlation < 0.0:
        note = "out of phase — this will lose energy when summed to mono"
    elif correlation < 0.3:
        note = "very wide"
    else:
        note = "normal stereo"

    return {
        "stereo": True,
        "correlation": _round(correlation, 4),
        "mid_rms_db": _round(_db(mid_rms), 2),
        "side_rms_db": _round(_db(side_rms), 2),
        "side_to_mid_db": _round(_db(side_rms) - _db(mid_rms), 2),
        "width": _round(side_rms / mid_rms, 4) if mid_rms > 1e-12 else None,
        "left_lufs": _round(left_lufs, 2),
        "right_lufs": _round(right_lufs, 2),
        "balance_db": _round(difference, 2),
        "note": note,
    }


# --------------------------------------------------------------------------
# the whole analysis
# --------------------------------------------------------------------------

def _musical(path: Path) -> dict:
    """Tempo, metre and key, when they can be estimated.

    Kept optional: a failure here must not cost the loudness analysis, which is
    the part everything else depends on.
    """
    try:
        from music_studio.audio.tempo import analyse as _analyse_musical
        return _analyse_musical(path)
    except Exception as exc:                      # noqa: BLE001
        log.debug("no tempo/key estimate: %s", exc)
        return {}


def _delivery_targets() -> dict:
    """The loudness targets, read from master.py so there is one source.

    Falls back to the published streaming numbers if master.py cannot be
    imported, so an analysis produced in isolation still carries targets rather
    than none at all.
    """
    try:
        from music_studio.audio.master import DEFAULT_LUFS, DEFAULT_TP
        lufs, tp, source = DEFAULT_LUFS, DEFAULT_TP, "master.py"
    except ImportError:
        lufs, tp, source = -14.0, -1.0, "fallback"
    return {
        "integrated_lufs": lufs,
        "true_peak_dbtp": tp,
        "source": source,
        "note": ("Spotify, YouTube, Tidal and Amazon normalise to this; "
                 "Apple Music uses -16 LUFS but the same file serves both."),
    }


def analyze(path: Path, *, spectrogram_bins: int = SPECTROGRAM_BINS,
            spectrogram_frames: int = MAX_SPECTROGRAM_FRAMES,
            loudness_points: int = MAX_LOUDNESS_POINTS,
            envelope_points: int = MAX_ENVELOPE_POINTS,
            use_ffmpeg: bool = True) -> dict:
    """Measure everything and return one JSON-ready dict."""
    import numpy as np

    data, rate, info = _load(path)
    duration = data.shape[0] / float(rate)
    log.info("Loaded %s: %.1f s, %d Hz, %d ch",
             path.name, duration, rate, data.shape[1])

    meta = Metadata(
        path=str(path),
        duration=duration,
        sample_rate=rate,
        channels=int(data.shape[1]),
        bit_depth=_bit_depth(info.subtype),
        subtype=str(info.subtype),
        frames=int(data.shape[0]),
    )

    # --- whole-file measures ------------------------------------------------
    mono = _mono(data)
    rms = float(np.sqrt(np.mean(mono ** 2)))
    peak = float(np.max(np.abs(data)))
    rms_db, peak_db = _db(rms), _db(peak)

    measures = {
        "rms": _round(rms_db, 2),
        "peak": _round(peak_db, 2),
        "crest_factor": _round(peak_db - rms_db, 2),
        "sample_peak": _round(peak, 6),
    }

    # master.py's measure() is the authority for the ffmpeg-derived figures:
    # one implementation of loudnorm parsing, not two.
    ffmpeg_ok = False
    if use_ffmpeg:
        try:
            from music_studio.audio.master import MasterError, measure

            loudness = measure(path)
            measures.update({
                "integrated_lufs": _round(loudness.integrated, 2),
                "true_peak_dbtp": _round(loudness.true_peak, 2),
                "lra": _round(loudness.lra, 2),
                "gate_threshold_lufs": _round(loudness.threshold, 2),
                "true_peak_is_estimate": False,
                "source": "ffmpeg loudnorm",
            })
            ffmpeg_ok = True
        except (MasterError, ImportError, OSError) as exc:
            log.warning("ffmpeg loudness unavailable (%s); using the "
                        "internal BS.1770 implementation.", exc)

    # --- loudness over time -------------------------------------------------
    log.debug("K-weighting and gating")
    momentary, momentary_times = loudness_series(data, rate, MOMENTARY_WINDOW)
    short_term, short_term_times = loudness_series(data, rate, SHORT_TERM_WINDOW)
    internal_integrated = integrated_loudness(data, rate)

    measures["integrated_lufs_internal"] = _round(internal_integrated, 2)
    if not ffmpeg_ok:
        measures["integrated_lufs"] = _round(internal_integrated, 2)
        # Without ffmpeg there is no oversampled true-peak detector here, so
        # this is the sample peak: it understates real inter-sample peaks by a
        # few tenths of a dB. Name it so a consumer cannot mistake it for a
        # measured dBTP, and flag it separately for anything doing arithmetic.
        measures["true_peak_dbtp"] = _round(peak_db, 2)
        measures["true_peak_is_estimate"] = True
        measures["lra"] = _round(loudness_range(short_term), 2)
        measures["source"] = "internal BS.1770 (true peak = sample_peak_estimate)"

    def _series(values, times, limit):
        values = np.asarray(values)
        if values.size == 0:
            return {"times": [], "lufs": []}
        reduced = _downsample(values, limit)
        if reduced.size == values.size:
            reduced_times = times
        else:
            idx = np.linspace(0, values.size - 1, reduced.size).astype(int)
            reduced_times = np.asarray(times)[idx]
        return {
            "times": [_round(t, 3) for t in reduced_times],
            "lufs": [_round(v, 2) for v in reduced],
        }

    loudness_block = {
        "momentary": dict(_series(momentary, momentary_times, loudness_points),
                          window=MOMENTARY_WINDOW),
        "short_term": dict(_series(short_term, short_term_times, loudness_points),
                           window=SHORT_TERM_WINDOW),
        "max_momentary": _round(float(momentary.max()) if momentary.size else None, 2),
        "max_short_term": _round(float(short_term.max()) if short_term.size else None, 2),
        "lra_internal": _round(loudness_range(short_term), 2),
    }

    # --- spectrum -----------------------------------------------------------
    log.debug("Spectrum and codec check")
    freqs, magnitude_db = average_spectrum(data, rate)
    cutoff = detect_cutoff(freqs, magnitude_db, rate)

    # The average spectrum is thinned onto a log axis; a browser cannot draw
    # 4096 linear bins anyway, and half of them sit in the top octave.
    log_edges = np.geomspace(max(20.0, float(freqs[1])), float(freqs[-1]), 513)
    indices = np.searchsorted(freqs, log_edges)
    spectrum_freqs, spectrum_db = [], []
    for i in range(512):
        lo = indices[i]
        hi = max(lo + 1, min(indices[i + 1], magnitude_db.size))
        lo = min(lo, hi - 1)
        spectrum_freqs.append(_round(float(np.sqrt(log_edges[i] * log_edges[i + 1])), 1))
        spectrum_db.append(_round(float(magnitude_db[lo:hi].max()), 1))

    # --- assemble -----------------------------------------------------------
    clipping = detect_clipping(data, rate)

    report = {
        "schema": "audio-analysis/v1",
        # The delivery targets travel with the data rather than being copied
        # into every consumer. A player that hardcodes -14 keeps showing -14
        # after master.py's default changes, and nothing says it is wrong.
        "targets": _delivery_targets(),
        # Tempo and key are estimates, not transcription; each carries its own
        # confidence and a consumer must respect it. See tempo.py.
        **_musical(path),
        "metadata": {
            "path": meta.path,
            "filename": path.name,
            "duration": _round(meta.duration, 3),
            "sample_rate": meta.sample_rate,
            "channels": meta.channels,
            "bit_depth": meta.bit_depth,
            "subtype": meta.subtype,
            "frames": meta.frames,
        },
        "measures": measures,
        "loudness": loudness_block,
        "envelopes": channel_envelopes(data, rate, limit=envelope_points),
        "spectrogram": spectrogram(data, rate, bins=spectrogram_bins,
                                   max_frames=spectrogram_frames),
        "spectrum": {
            "freqs": spectrum_freqs,
            "db": spectrum_db,
            "bands": band_energy(data, rate),
        },
        "codec": {
            "cutoff_hz": _round(cutoff.cutoff_hz, 1),
            "confidence": _round(cutoff.confidence, 3),
            "drop_db": _round(cutoff.drop_db, 2),
            "nyquist_hz": _round(rate / 2.0, 1),
            "lossy_suspected": bool(cutoff.confidence >= 0.33),
            "verdict": cutoff.verdict,
        },
        "clipping": {
            "clipped_samples": clipping.clipped_samples,
            "clipped_fraction": _round(clipping.clipped_fraction, 9),
            "runs": clipping.runs,
            "longest_run": clipping.longest_run,
            "clipping_suspected": bool(clipping.runs > 0),
            "worst": list(clipping.worst),
        },
        "stereo": stereo_analysis(data, rate),
    }

    # Dated findings travel with the analysis. The studio page reads them from
    # here first, so any analysis carries its own timeline rather than only the
    # ones written through studio_run.py — an analyze.py file loaded directly
    # otherwise showed "No analysis yet" beside fully populated verdict cards.
    # Derived from the series already in `report`, so this costs no extra I/O.
    try:
        from music_studio.insight.timeline import find_events
        report["timeline"] = find_events(report)
    except Exception as exc:                          # noqa: BLE001
        log.debug("no timeline: %s", exc)

    return report


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Analyse an audio file into one JSON document for a browser player.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--in", dest="src", type=Path, required=True, help="Audio file.")
    p.add_argument("--out", type=Path, help="Write JSON here. Default: stdout.")
    p.add_argument("--indent", type=int, default=None,
                   help="Pretty-print with this indent. Default: compact.")
    p.add_argument("--spectrogram-bins", type=int, default=SPECTROGRAM_BINS,
                   help="Log-spaced frequency bins in the spectrogram.")
    p.add_argument("--spectrogram-frames", type=int, default=MAX_SPECTROGRAM_FRAMES,
                   help="Maximum spectrogram time frames.")
    p.add_argument("--loudness-points", type=int, default=MAX_LOUDNESS_POINTS,
                   help="Maximum points in each loudness series.")
    p.add_argument("--envelope-points", type=int, default=MAX_ENVELOPE_POINTS,
                   help="Maximum points in each channel envelope.")
    p.add_argument("--no-ffmpeg", dest="use_ffmpeg", action="store_false",
                   help="Skip ffmpeg; use the internal BS.1770 loudness only.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
        stream=sys.stderr,
    )

    try:
        result = analyze(
            args.src,
            spectrogram_bins=args.spectrogram_bins,
            spectrogram_frames=args.spectrogram_frames,
            loudness_points=args.loudness_points,
            envelope_points=args.envelope_points,
            use_ffmpeg=args.use_ffmpeg,
        )
        text = json.dumps(result, indent=args.indent,
                          separators=(",", ":") if args.indent is None else None)

        if args.out:
            # Write beside the target and rename, so an interrupted run never
            # leaves a half-written JSON where a reader expects a whole one.
            import tempfile

            args.out.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(suffix=args.out.suffix, dir=args.out.parent)
            import os
            os.close(fd)
            tmp = Path(tmp_name)
            try:
                tmp.write_text(text, encoding="utf-8")
                tmp.replace(args.out)
            finally:
                tmp.unlink(missing_ok=True)
            log.info("Wrote %s (%.1f KB)", args.out, len(text) / 1000.0)
            print(args.out)
        else:
            print(text)

    except AnalyzeError as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.error("Interrupted.")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
