#!/usr/bin/env python3
"""Tests for master.py.

The interesting cases are the two that were silently wrong before: loudnorm
abandoning linear mode without saying so, and a tone preset running on the wrong
side of the loudness stage. Both are verified against real ffmpeg rather than
mocked, because both bugs lived in what ffmpeg actually did rather than in what
the code looked like.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

import master

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not on PATH")

RATE = 48000


def _tone(seconds: float = 4.0, amp: float = 0.2, freq: float = 440.0,
          rate: int = RATE) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    x = amp * np.sin(2 * np.pi * freq * t)
    return np.column_stack([x, x])


def _write(path: Path, data: np.ndarray, rate: int = RATE) -> Path:
    sf.write(str(path), data, rate, subtype="PCM_24")
    return path


class TestEqChain(unittest.TestCase):
    def test_known_preset_returns_chain_and_reason(self):
        chain, why = master._eq_chain("warm")
        self.assertIn("firequalizer", chain)
        self.assertTrue(why)

    def test_flat_is_empty(self):
        chain, _ = master._eq_chain("flat")
        self.assertEqual(chain, "")

    def test_raw_chain_passes_through(self):
        chain, why = master._eq_chain("highpass=f=40")
        self.assertEqual(chain, "highpass=f=40")
        self.assertEqual(why, "custom chain")

    def test_unknown_name_raises_and_lists_presets(self):
        with self.assertRaises(master.MasterError) as ctx:
            master._eq_chain("nonsense")
        self.assertIn("warm", str(ctx.exception))


class _CaptureWarnings(logging.Handler):
    """assertNoLogs only exists on 3.10+, and this venv is 3.9."""

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.records: list[str] = []

    def emit(self, record):
        self.records.append(record.getMessage())

    def __enter__(self):
        master.log.addHandler(self)
        return self

    def __exit__(self, *exc):
        master.log.removeHandler(self)
        return False


class TestLinearFallbackWarning(unittest.TestCase):
    """The warning must fire on dynamic, stay silent on linear, and give
    advice that fits the cause."""

    def _stderr(self, kind: str) -> str:
        return 'x\n{\n\t"normalization_type" : "%s",\n\t"target_offset" : "0.0"\n}\n' % kind

    def test_silent_when_linear(self):
        with _CaptureWarnings() as cap:
            master._warn_if_not_linear(self._stderr("linear"), -14.0, -1.0)
        self.assertEqual(cap.records, [])

    def test_warns_when_dynamic(self):
        with self.assertLogs(master.log, level="WARNING") as cm:
            master._warn_if_not_linear(self._stderr("dynamic"), -14.0, -1.0)
        self.assertTrue(any("DYNAMIC" in m for m in cm.output))

    def test_advice_when_source_is_over_the_ceiling(self):
        """Lowering the target cannot help here, so it must not be suggested."""
        hot = master.Loudness(integrated=-14.0, true_peak=0.3, lra=7.0, threshold=-24.0)
        with self.assertLogs(master.log, level="WARNING") as cm:
            master._warn_if_not_linear(self._stderr("dynamic"), -14.0, -1.0, hot)
        joined = "\n".join(cm.output)
        self.assertIn("source itself peaks", joined)
        self.assertNotIn("--lufs -16", joined)

    def test_advice_when_target_is_merely_too_loud(self):
        quiet = master.Loudness(integrated=-20.0, true_peak=-6.0, lra=7.0, threshold=-30.0)
        with self.assertLogs(master.log, level="WARNING") as cm:
            master._warn_if_not_linear(self._stderr("dynamic"), -14.0, -1.0, quiet)
        joined = "\n".join(cm.output)
        self.assertIn("--lufs", joined)
        self.assertNotIn("source itself peaks", joined)

    def test_unparseable_output_is_ignored(self):
        with _CaptureWarnings() as cap:
            master._warn_if_not_linear("no json here", -14.0, -1.0)
        self.assertEqual(cap.records, [])


@needs_ffmpeg
class TestMasteringEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hits_the_target_and_the_ceiling(self):
        src = _write(self.tmp / "in.wav", _tone(amp=0.2))
        dst = self.tmp / "out.wav"
        master.master_loudnorm(src, dst, lufs=-18.0, tp=-1.0)
        after = master.measure(dst)
        self.assertAlmostEqual(after.integrated, -18.0, delta=0.6)
        self.assertLessEqual(after.true_peak, -0.9)

    def test_tone_preset_still_respects_the_ceiling(self):
        """The whole point of running EQ before loudnorm: the ceiling holds.

        Every tone chain changes peak level, so if the order were reversed this
        would come back above -1 dBTP.
        """
        src = _write(self.tmp / "in.wav", _tone(amp=0.5))
        dst = self.tmp / "out.wav"
        master.master_loudnorm(src, dst, lufs=-16.0, tp=-1.0, eq="warm")
        after = master.measure(dst)
        self.assertLessEqual(after.true_peak, -0.9)

    def test_tone_preset_actually_changes_the_tone(self):
        """A preset that produced an identical file would be a silent no-op."""
        src = _write(self.tmp / "in.wav", _tone(amp=0.3))
        flat, warm = self.tmp / "flat.wav", self.tmp / "warm.wav"
        master.master_loudnorm(src, flat, lufs=-18.0, eq="flat")
        master.master_loudnorm(src, warm, lufs=-18.0, eq="warm")
        a, _ = sf.read(str(flat), always_2d=True, dtype="float64")
        b, _ = sf.read(str(warm), always_2d=True, dtype="float64")
        n = min(len(a), len(b))
        self.assertGreater(float(np.max(np.abs(a[:n] - b[:n]))), 1e-4)

    def test_measure_through_reflects_the_chain(self):
        """A high-pass on a 40 Hz tone must read quieter through the chain."""
        src = _write(self.tmp / "in.wav", _tone(amp=0.3, freq=40.0))
        dry = master._measure_through(src, "")
        wet = master._measure_through(src, "highpass=f=300:poles=2")
        self.assertLess(wet.integrated, dry.integrated - 3.0)

    def test_refuses_unsupported_bit_depth(self):
        src = _write(self.tmp / "in.wav", _tone())
        with self.assertRaises(master.MasterError):
            master.master_loudnorm(src, self.tmp / "out.wav", bit_depth=20)


class TestPresetsAreWellFormed(unittest.TestCase):
    def test_every_preset_has_a_reason(self):
        for name, (_, why) in master.EQ_PRESETS.items():
            self.assertTrue(why.strip(), f"{name} has no explanation")

    @needs_ffmpeg
    def test_every_preset_chain_runs(self):
        """A preset that ffmpeg rejects is worse than no preset."""
        tmp = Path(tempfile.mkdtemp())
        try:
            src = _write(tmp / "in.wav", _tone())
            for name, (chain, _) in master.EQ_PRESETS.items():
                if not chain:
                    continue
                out = tmp / f"{name}.wav"
                proc = subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-i", str(src),
                     "-filter:a", chain, str(out)],
                    capture_output=True, text=True,
                )
                self.assertEqual(proc.returncode, 0,
                                 f"preset {name} failed: {proc.stderr[:200]}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
