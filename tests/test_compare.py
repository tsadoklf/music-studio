#!/usr/bin/env python3
"""Tests for compare.py.

The null test is the one measurement in this repo whose answer a person cannot
check by ear first: it *is* the ear check. So the arithmetic behind it is
tested against signals built here, where the right answer is known in advance —
two identical arrays must cancel, a gain difference must cancel once it is
matched, and a real tonal change must not.

Nothing decodes audio and nothing runs ffmpeg. `_loudness` shells out, so it is
patched with recorded loudnorm output; `_load` reads a file, so the tests that
need samples build them with numpy and patch it. The band table and the
alignment are pure arithmetic and are called directly.
"""

from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np

from music_studio.audio import compare


RATE = 48000


def _tone(hz: float, seconds: float = 1.0, amp: float = 0.5,
          rate: int = RATE, channels: int = 2):
    """A steady sine, shaped the way soundfile hands data back (always 2D)."""
    t = np.arange(int(seconds * rate)) / rate
    mono = amp * np.sin(2 * np.pi * hz * t)
    return np.repeat(mono[:, None], channels, axis=1)


def _noise(seconds: float = 1.0, amp: float = 0.2, rate: int = RATE, seed: int = 0):
    rng = np.random.default_rng(seed)
    mono = amp * rng.standard_normal(int(seconds * rate))
    return np.repeat(mono[:, None], 2, axis=1)


def _loudnorm_stderr(i: float = -14.0, tp: float = -1.0, lra: float = 6.0,
                     thresh: float = -24.0) -> str:
    """What ffmpeg prints on stderr with print_format=json, as compare reads it."""
    return (
        "[Parsed_loudnorm_0 @ 0x1] \n"
        + json.dumps({
            "input_i": f"{i:.2f}", "input_tp": f"{tp:.2f}",
            "input_lra": f"{lra:.2f}", "input_thresh": f"{thresh:.2f}",
            "output_i": "-14.00", "normalization_type": "linear",
        })
        + "\n"
    )


class TestBandTable(unittest.TestCase):
    """The tonal comparison. Its only job is to say which part of the spectrum
    moved, so a band that does not follow its own frequency is the one failure
    that would make the whole table misleading rather than merely wrong."""

    def test_every_band_is_reported(self):
        out = compare._band_energy(_noise(0.5), RATE)
        self.assertEqual(set(out), {name for name, _, _ in compare.BANDS})

    def test_a_tone_lands_in_its_own_band(self):
        """1 kHz is inside `mid` (800-2500). If the frequency axis were off by
        a factor of two — an rfftfreq called with the wrong rate, say — the
        energy would show up in a neighbour and nobody would notice."""
        out = compare._band_energy(_tone(1000, 0.5), RATE)
        loudest = max(out, key=out.get)
        self.assertEqual(loudest, "mid", out)

    def test_a_sub_tone_lands_in_sub(self):
        out = compare._band_energy(_tone(40, 0.5), RATE)
        self.assertEqual(max(out, key=out.get), "sub", out)

    def test_an_air_tone_lands_in_air(self):
        out = compare._band_energy(_tone(15000, 0.5), RATE)
        self.assertEqual(max(out, key=out.get), "air", out)

    def test_silence_floors_rather_than_returning_minus_infinity(self):
        """log10(0) is -inf, and an -inf in the table formats as a column of
        garbage and poisons every difference computed from it."""
        out = compare._band_energy(np.zeros((RATE // 2, 2)), RATE)
        for name, value in out.items():
            self.assertTrue(np.isfinite(value), f"{name} is {value}")

    def test_the_bands_tile_the_audible_range_without_gaps(self):
        """A gap would hide a change; an overlap would double-count one."""
        edges = [(lo, hi) for _, lo, hi in compare.BANDS]
        for (_, hi), (lo, _) in zip(edges, edges[1:]):
            self.assertEqual(hi, lo)
        self.assertEqual(edges[0][0], 20)
        self.assertEqual(edges[-1][1], 20000)

    def test_a_band_above_nyquist_does_not_raise(self):
        """At 22.05 kHz there are no bins at all in `air`. An empty selection
        must floor, not divide by zero."""
        out = compare._band_energy(_tone(1000, 0.3, rate=22050), 22050)
        self.assertTrue(np.isfinite(out["air"]))


class TestAlignment(unittest.TestCase):
    """The null test cancels only if the two files line up sample for sample.
    One sample of offset at 1 kHz is already 7 degrees of phase error, and the
    residue it leaves looks exactly like real processing."""

    def test_identical_input_needs_no_shift(self):
        a = _noise(0.5)
        _, _, lag = compare._align(a, a.copy())
        self.assertEqual(lag, 0)

    def test_a_delay_is_found_and_removed(self):
        a = _noise(0.5, seed=1)
        shift = 120
        b = np.vstack([np.zeros((shift, 2)), a[:-shift]])   # b lags a
        a_al, b_al, lag = compare._align(a, b)
        self.assertEqual(lag, -shift)
        self.assertLess(float(np.max(np.abs(a_al - b_al))), 1e-9)

    def test_the_trimmed_arrays_stay_the_same_length(self):
        """They are subtracted from each other immediately afterwards."""
        a_al, b_al, _ = compare._align(_noise(0.5, seed=2), _noise(0.4, seed=3))
        self.assertEqual(len(a_al), len(b_al))

    def test_different_lengths_are_trimmed_to_the_shorter(self):
        a_al, b_al, _ = compare._align(_noise(0.5, seed=4), _noise(0.25, seed=4))
        self.assertLessEqual(len(a_al), int(0.25 * RATE))


class _Compare(unittest.TestCase):
    """Base for the tests that call compare() itself.

    compare() prints a report and optionally writes a WAV. Both are captured:
    stdout into a buffer, the file into a temp directory. _loudness is the only
    ffmpeg call in the path and is patched per test.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        # compare() narrates at INFO ("aligned with a 120-sample offset"). That
        # is for a terminal, not for the test output.
        quiet = unittest.mock.patch.object(compare.log, "info")
        quiet.start()
        self.addCleanup(quiet.stop)

    def run_compare(self, a, b, *, loud=(-14.0, -14.0), null=None, amplify=20.0):
        """Returns everything compare() printed."""
        files = {self.tmp / "a.wav": a, self.tmp / "b.wav": b}
        for path in files:
            path.write_bytes(b"")          # _load is patched; existence is enough

        def fake_load(path):
            return files[path], RATE

        def fake_loudness(path):
            i = loud[0] if path.name == "a.wav" else loud[1]
            return i, -1.0, 6.0

        buf = io.StringIO()
        with unittest.mock.patch.object(compare, "_load", fake_load), \
                unittest.mock.patch.object(compare, "_loudness", fake_loudness), \
                redirect_stdout(buf):
            compare.compare(self.tmp / "a.wav", self.tmp / "b.wav", null, amplify)
        return buf.getvalue()


class TestNullTest(_Compare):
    """The verdict the whole script exists to print."""

    def test_identical_files_read_as_essentially_identical(self):
        a = _noise(1.0, seed=10)
        out = self.run_compare(a, a.copy())
        self.assertIn("Essentially identical", out)

    def test_a_pure_gain_difference_still_nulls(self):
        """Gain-matching before subtracting is the reason: a master that is
        only 3 dB louder changed nothing, and saying otherwise would make the
        null test useless on exactly the case it is most often run on."""
        a = _noise(1.0, seed=11)
        out = self.run_compare(a, a * (10 ** (3 / 20)), loud=(-17.0, -14.0))
        self.assertIn("Essentially identical", out)

    def test_a_real_tonal_change_does_not_null(self):
        a = _noise(1.0, seed=12)
        b = a + _tone(3000, 1.0, amp=0.05)
        out = self.run_compare(a, b)
        self.assertNotIn("Essentially identical", out)

    def test_two_different_takes_read_as_a_large_change(self):
        out = self.run_compare(_noise(1.0, seed=13), _noise(1.0, seed=14))
        self.assertIn("Large change", out)

    def test_the_residue_ratio_is_printed_with_a_sign(self):
        """It is always negative in practice, and the sign is what tells you
        the residue is below the source rather than above it."""
        a = _noise(1.0, seed=15)
        out = self.run_compare(a, a.copy())
        self.assertRegex(out, r"residue is [-+]\d")

    def test_silence_does_not_divide_by_zero(self):
        """Two silent files are a degenerate but reachable input — a bounced
        stem that came out empty."""
        z = np.zeros((RATE, 2))
        out = self.run_compare(z, z.copy())
        self.assertIn("Null test", out)
        self.assertNotIn("nan", out.lower())


class TestReportBody(_Compare):
    def test_the_measured_rows_are_all_present(self):
        a = _noise(0.5, seed=20)
        out = self.run_compare(a, a.copy())
        for row in ("Integrated", "True peak", "Loudness range", "RMS",
                    "Peak", "Crest factor"):
            self.assertIn(row, out)

    def test_the_tonal_table_states_that_it_is_gain_matched(self):
        """Without that caption the column reads as an absolute tonal
        judgement, which is the misreading advise.py's prompt also guards."""
        a = _noise(0.5, seed=21)
        out = self.run_compare(a, a * 2, loud=(-20.0, -14.0))
        self.assertIn("gain-matched", out)
        self.assertIn("dB removed", out)

    def test_every_band_gets_a_row(self):
        a = _noise(0.5, seed=22)
        out = self.run_compare(a, a.copy())
        for name, _, _ in compare.BANDS:
            self.assertIn(name, out)


class TestNullFile(_Compare):
    """The residue WAV. It is the deliverable — you listen to it — so it has to
    be audible and it has to not clip."""

    def test_the_residue_is_written_where_asked(self):
        a = _noise(1.0, seed=30)
        null = self.tmp / "out" / "diff.wav"
        self.run_compare(a, a + _tone(3000, 1.0, amp=0.02), null=null)
        self.assertTrue(null.is_file())

    def test_the_parent_directory_is_created(self):
        """`--null dist/diff.wav` into a directory that does not exist yet is
        the normal case, not an error."""
        a = _noise(0.5, seed=31)
        null = self.tmp / "a" / "b" / "c" / "diff.wav"
        self.run_compare(a, a.copy(), null=null)
        self.assertTrue(null.is_file())

    def test_amplification_makes_a_quiet_residue_audible(self):
        """A -60 dB residue played at unity is silence. The boost is the whole
        reason the file is worth writing."""
        a = _noise(1.0, seed=32)
        b = a + _tone(3000, 1.0, amp=0.001)
        quiet, loudfile = self.tmp / "q.wav", self.tmp / "l.wav"
        self.run_compare(a, b, null=quiet, amplify=0.0)
        self.run_compare(a, b, null=loudfile, amplify=20.0)

        import soundfile as sf
        q = np.max(np.abs(sf.read(str(quiet), always_2d=True)[0]))
        l = np.max(np.abs(sf.read(str(loudfile), always_2d=True)[0]))
        self.assertGreater(l, q * 5)

    def test_a_boost_that_would_clip_is_normalised_instead(self):
        """+40 dB on a loud residue overflows the sample range. Writing that
        gives you a file of buzzing rather than the difference you asked to
        hear, so it is scaled back and said so."""
        a = _noise(1.0, seed=33)
        b = _noise(1.0, seed=34)
        null = self.tmp / "hot.wav"
        self.run_compare(a, b, null=null, amplify=40.0)

        import soundfile as sf
        peak = float(np.max(np.abs(sf.read(str(null), always_2d=True)[0])))
        self.assertLessEqual(peak, 1.0)
        self.assertGreater(peak, 0.9, "normalised so far down it is inaudible")

    def test_nothing_is_written_when_null_is_not_asked_for(self):
        a = _noise(0.5, seed=35)
        self.run_compare(a, a.copy(), null=None)
        self.assertEqual(list(self.tmp.glob("*.wav")), [self.tmp / "a.wav",
                                                        self.tmp / "b.wav"])


class TestRefusals(unittest.TestCase):
    """Cases where a null test cannot mean anything, refused with a reason
    rather than producing a confident wrong number."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        for name in ("a.wav", "b.wav"):
            (self.tmp / name).write_bytes(b"")

    def _compare(self, a, b, rate_a=RATE, rate_b=RATE):
        loaded = {self.tmp / "a.wav": (a, rate_a), self.tmp / "b.wav": (b, rate_b)}
        with unittest.mock.patch.object(compare, "_load", lambda p: loaded[p]), \
                unittest.mock.patch.object(compare, "_loudness",
                                           lambda p: (-14.0, -1.0, 6.0)):
            compare.compare(self.tmp / "a.wav", self.tmp / "b.wav", None, 20.0)

    def test_mismatched_sample_rates_are_refused(self):
        """Subtracting 44.1 from 48 compares different instants and produces a
        residue that is entirely artefact."""
        with self.assertRaises(compare.CompareError) as c:
            self._compare(_noise(0.2), _noise(0.2, rate=44100), rate_b=44100)
        self.assertIn("Sample rates differ", str(c.exception))

    def test_mismatched_channel_counts_are_refused(self):
        with self.assertRaises(compare.CompareError) as c:
            self._compare(_noise(0.2), _tone(440, 0.2, channels=1))
        self.assertIn("Channel counts differ", str(c.exception))

    def test_a_missing_file_names_itself(self):
        with self.assertRaises(compare.CompareError) as c:
            compare._load(self.tmp / "nowhere.wav")
        self.assertIn("nowhere.wav", str(c.exception))


class TestLoudnessParsing(unittest.TestCase):
    """_loudness scrapes JSON out of ffmpeg's stderr. The regex is the fragile
    part: loudnorm prints a second JSON block and a banner around it."""

    def _with_stderr(self, stderr: str):
        proc = subprocess.CompletedProcess([], 0, "", stderr)
        with unittest.mock.patch("subprocess.run", return_value=proc):
            return compare._loudness(Path("x.wav"))

    def test_reads_the_input_measurements(self):
        i, tp, lra = self._with_stderr(_loudnorm_stderr(-11.5, 0.7, 4.2))
        self.assertAlmostEqual(i, -11.5)
        self.assertAlmostEqual(tp, 0.7)
        self.assertAlmostEqual(lra, 4.2)

    def test_the_banner_around_the_json_does_not_confuse_it(self):
        noisy = ("ffmpeg version 7.1\n  libavutil 59\n"
                 + _loudnorm_stderr(-13.0)
                 + "size=N/A time=00:04:00.00 bitrate=N/A speed=180x\n")
        i, _, _ = self._with_stderr(noisy)
        self.assertAlmostEqual(i, -13.0)

    def test_output_with_no_measurement_is_a_readable_error(self):
        """ffmpeg exits 0 with an empty report when handed a file it cannot
        decode, so a missing block is the normal shape of that failure."""
        with self.assertRaises(compare.CompareError) as c:
            self._with_stderr("ffmpeg version 7.1\nInvalid data found\n")
        self.assertIn("Could not measure loudness", str(c.exception))

    def test_ffmpeg_is_never_given_a_shell_string(self):
        proc = subprocess.CompletedProcess([], 0, "", _loudnorm_stderr())
        with unittest.mock.patch("subprocess.run", return_value=proc) as run:
            compare._loudness(Path("a b.wav"))
        argv = run.call_args[0][0]
        self.assertIsInstance(argv, list)
        self.assertIn("a b.wav", argv)


class TestRequire(unittest.TestCase):
    def test_a_missing_tool_is_named(self):
        with unittest.mock.patch.object(compare.shutil, "which", return_value=None):
            with self.assertRaises(compare.CompareError) as c:
                compare._require("ffmpeg")
        self.assertIn("ffmpeg", str(c.exception))

    def test_a_present_tool_passes(self):
        with unittest.mock.patch.object(compare.shutil, "which",
                                        return_value="/usr/bin/ffmpeg"):
            compare._require("ffmpeg")      # must not raise


class TestMain(unittest.TestCase):
    """The CLI. compare() is patched: what is under test is the wiring and the
    exit codes, not the arithmetic above."""

    def setUp(self):
        quiet = unittest.mock.patch.object(compare.log, "error")
        quiet.start()
        self.addCleanup(quiet.stop)

    def test_arguments_reach_compare(self):
        with unittest.mock.patch.object(compare, "compare") as called, \
                unittest.mock.patch.object(compare, "_require"):
            rc = compare.main(["--a", "take.wav", "--b", "master.wav",
                               "--null", "diff.wav", "--amplify", "12"])
        self.assertEqual(rc, 0)
        a, b, null, amplify = called.call_args[0]
        self.assertEqual((a.name, b.name, null.name), ("take.wav", "master.wav",
                                                       "diff.wav"))
        self.assertEqual(amplify, 12.0)

    def test_the_default_boost_is_applied_when_none_is_given(self):
        with unittest.mock.patch.object(compare, "compare") as called, \
                unittest.mock.patch.object(compare, "_require"):
            compare.main(["--a", "a.wav", "--b", "b.wav"])
        self.assertEqual(called.call_args[0][3], 20.0)
        self.assertIsNone(called.call_args[0][2])

    def test_a_refusal_is_an_exit_code_not_a_traceback(self):
        with unittest.mock.patch.object(compare, "_require"), \
                unittest.mock.patch.object(
                    compare, "compare",
                    side_effect=compare.CompareError("rates differ")):
            self.assertEqual(compare.main(["--a", "a.wav", "--b", "b.wav"]), 1)

    def test_a_missing_ffmpeg_stops_before_anything_is_read(self):
        with unittest.mock.patch.object(compare.shutil, "which", return_value=None), \
                unittest.mock.patch.object(compare, "compare") as called:
            self.assertEqual(compare.main(["--a", "a.wav", "--b", "b.wav"]), 1)
        called.assert_not_called()

    def test_ctrl_c_is_130(self):
        """The shell convention. A traceback on ^C during a four-minute
        correlation looks like a crash."""
        with unittest.mock.patch.object(compare, "_require"), \
                unittest.mock.patch.object(compare, "compare",
                                           side_effect=KeyboardInterrupt):
            self.assertEqual(compare.main(["--a", "a.wav", "--b", "b.wav"]), 130)


if __name__ == "__main__":
    unittest.main()
