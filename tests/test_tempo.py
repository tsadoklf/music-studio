#!/usr/bin/env python3
"""Tests for tempo.py.

Tempo estimation has one classic failure — the octave error. Autocorrelation
fits a 120 BPM click just as well at 60, because every second beat also lines
up, and a naive implementation reports half-time with total confidence. That
bug was real here and these tests exist to keep it fixed.

Key estimation is tested for the answer AND for its honesty: a signal with no
tonal centre must come back with low confidence rather than a confident guess.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from music_studio.audio import tempo

RATE = 44100


def click_track(bpm: float, seconds: float = 20.0, tone_hz: float = 220.0,
                rate: int = RATE) -> np.ndarray:
    """A metronome, optionally over a drone so there is something tonal."""
    t = np.arange(int(rate * seconds)) / rate
    x = np.zeros_like(t)
    for beat in range(int(seconds * bpm / 60.0)):
        i = int(beat * rate * 60.0 / bpm)
        n = int(0.02 * rate)
        env = np.exp(-np.arange(n) / (0.004 * rate))
        x[i:i + n] += 0.6 * env * np.sin(2 * np.pi * 1200 * np.arange(n) / rate)
    if tone_hz:
        x += 0.05 * np.sin(2 * np.pi * tone_hz * t)
    return np.column_stack([x, x])


def chord(freqs, seconds: float = 12.0, rate: int = RATE) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    x = sum(0.12 * np.sin(2 * np.pi * f * t) for f in freqs)
    return np.column_stack([x, x])


class Wav:
    """A temporary wav file, written once and cleaned up."""

    def __init__(self, data, rate=RATE):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "t.wav"
        sf.write(str(self.path), data, rate, subtype="PCM_24")

    def __enter__(self):
        return self.path

    def __exit__(self, *exc):
        self.dir.cleanup()
        return False


class TestTempo(unittest.TestCase):
    def test_finds_a_known_tempo(self):
        with Wav(click_track(120)) as p:
            t = tempo.estimate_tempo(*tempo._load(p))
        self.assertIsNotNone(t.bpm)
        self.assertAlmostEqual(t.bpm, 120.0, delta=2.0)

    def test_no_octave_error_at_120(self):
        """The regression: 120 BPM once reported as 60 with full confidence."""
        with Wav(click_track(120)) as p:
            t = tempo.estimate_tempo(*tempo._load(p))
        self.assertGreater(t.bpm, 100.0, f"half-time error: got {t.bpm}")

    def test_several_known_tempos(self):
        for bpm in (75, 90, 140, 160):
            with self.subTest(bpm=bpm), Wav(click_track(bpm)) as p:
                t = tempo.estimate_tempo(*tempo._load(p))
                self.assertAlmostEqual(t.bpm, bpm, delta=3.0,
                                       msg=f"expected ~{bpm}, got {t.bpm}")

    def test_a_clear_pulse_is_confident(self):
        with Wav(click_track(110)) as p:
            t = tempo.estimate_tempo(*tempo._load(p))
        self.assertGreater(t.confidence, 0.5)

    def test_no_pulse_is_not_confident(self):
        """A drone has no beat; saying so is better than inventing one."""
        with Wav(chord([220.0])) as p:
            t = tempo.estimate_tempo(*tempo._load(p))
        self.assertLess(t.confidence, 0.5,
                        f"claimed {t.bpm} BPM at confidence {t.confidence} on a drone")

    def test_beat_times_are_ordered_and_plausible(self):
        with Wav(click_track(120, seconds=10)) as p:
            t = tempo.estimate_tempo(*tempo._load(p))
        self.assertGreater(len(t.beat_times), 5)
        self.assertEqual(t.beat_times, sorted(t.beat_times))
        gaps = np.diff(t.beat_times)
        self.assertAlmostEqual(float(np.median(gaps)), 0.5, delta=0.1)

    def test_silence_does_not_raise(self):
        with Wav(np.zeros((RATE * 3, 2))) as p:
            t = tempo.estimate_tempo(*tempo._load(p))
        self.assertEqual(t.confidence, 0.0)


class TestKey(unittest.TestCase):
    def test_finds_c_major(self):
        with Wav(chord([261.63, 329.63, 392.00])) as p:      # C E G
            k = tempo.estimate_key(*tempo._load(p))
        self.assertIsNotNone(k.name)
        self.assertTrue(k.name.startswith("C"), f"got {k.name}")

    def test_finds_a_minor_tonality(self):
        with Wav(chord([220.00, 261.63, 329.63])) as p:      # A C E
            k = tempo.estimate_key(*tempo._load(p))
        self.assertIn(k.name.split()[0], ("A", "C"), f"got {k.name}")

    def test_reports_alternatives(self):
        with Wav(chord([261.63, 329.63, 392.00])) as p:
            k = tempo.estimate_key(*tempo._load(p))
        self.assertTrue(k.alternatives)

    def test_atonal_input_is_not_confident(self):
        """White noise has no key. A confident answer here would be a lie."""
        rng = np.random.default_rng(0)
        noise = rng.standard_normal((RATE * 5, 2)) * 0.1
        with Wav(noise) as p:
            k = tempo.estimate_key(*tempo._load(p))
        self.assertLess(k.confidence, 0.5,
                        f"claimed {k.name} at confidence {k.confidence} on noise")

    def test_silence_does_not_raise(self):
        with Wav(np.zeros((RATE * 2, 2))) as p:
            k = tempo.estimate_key(*tempo._load(p))
        self.assertEqual(k.confidence, 0.0)


class TestContract(unittest.TestCase):
    """The shape the page reads. A missing field must be absent, not wrong."""

    def test_analyse_returns_both_blocks(self):
        with Wav(click_track(128)) as p:
            out = tempo.analyse(p)
        self.assertIn("tempo", out)
        self.assertIn("key", out)
        for field in ("bpm", "confidence", "meter", "beat_times"):
            self.assertIn(field, out["tempo"])
        for field in ("name", "confidence", "alternatives"):
            self.assertIn(field, out["key"])

    def test_confidence_is_always_in_range(self):
        with Wav(click_track(100)) as p:
            out = tempo.analyse(p)
        for block in ("tempo", "key"):
            c = out[block]["confidence"]
            self.assertGreaterEqual(c, 0.0)
            self.assertLessEqual(c, 1.0)

    def test_missing_file_raises_readably(self):
        with self.assertRaises(tempo.TempoError):
            tempo.analyse(Path("/nonexistent/nope.wav"))


if __name__ == "__main__":
    unittest.main()
