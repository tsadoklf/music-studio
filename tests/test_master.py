#!/usr/bin/env python3
"""Tests for master.py.

The interesting cases are the two that were silently wrong before: loudnorm
abandoning linear mode without saying so, and a tone preset running on the wrong
side of the loudness stage. Both are verified against real ffmpeg rather than
mocked, because both bugs lived in what ffmpeg actually did rather than in what
the code looked like.

The classes at the bottom are the opposite kind of test and mock deliberately:
the argv master.py builds, the CLI's argument handling, and the reference mode,
which needs a library that is not installed here. Running those against real
ffmpeg would add minutes and prove nothing the command line does not say.
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
import soundfile as sf

from music_studio.audio import master

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


# --------------------------------------------------------------------------
# the argv, without running it
# --------------------------------------------------------------------------

def _loudnorm_json(**over) -> str:
    """A loudnorm print_format=json block, as it appears in ffmpeg's stderr."""
    d = {"input_i": "-18.00", "input_tp": "-6.00", "input_lra": "5.00",
         "input_thresh": "-28.00", "output_i": "-14.00",
         "normalization_type": "linear"}
    d.update({k: str(v) for k, v in over.items()})
    return "[Parsed_loudnorm_0 @ 0x1]\n" + json.dumps(d) + "\n"


class _Argv(unittest.TestCase):
    """Captures every ffmpeg/ffprobe invocation without running one."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.src = self.tmp / "in.wav"
        self.dst = self.tmp / "out.wav"
        self.src.write_bytes(b"")

        self.commands: list[list[str]] = []

        def fake_run(argv, **kw):
            self.commands.append(argv)
            if argv[0] == "ffprobe":
                return subprocess.CompletedProcess(argv, 0, json.dumps({
                    "streams": [{"sample_rate": "48000", "channels": 2,
                                 "bits_per_raw_sample": "24"}],
                    "format": {"duration": "240.0"},
                }), "")
            if str(argv[-1]) != "-":            # a real write
                Path(argv[-1]).write_bytes(b"\0" * 64)
            return subprocess.CompletedProcess(argv, 0, "", _loudnorm_json())

        run = unittest.mock.patch("subprocess.run", side_effect=fake_run)
        run.start()
        self.addCleanup(run.stop)

        for level in ("info", "warning"):
            quiet = unittest.mock.patch.object(master.log, level)
            quiet.start()
            self.addCleanup(quiet.stop)

    @property
    def ffmpeg(self) -> list[list[str]]:
        return [c for c in self.commands if c[0] == "ffmpeg"]

    def filters(self) -> list[str]:
        """The -af argument of every ffmpeg call that had one."""
        return [c[c.index("-af") + 1] for c in self.ffmpeg if "-af" in c]

    def write_command(self) -> list[str]:
        """The one ffmpeg call that writes a file rather than measuring."""
        writes = [c for c in self.ffmpeg if c[-1] != "-"]
        self.assertEqual(len(writes), 1, "expected exactly one write")
        return writes[0]


class TestChainOrder(_Argv):
    """Tone before loudness. This is the bug the file's docstring names, and
    the only place the order is visible is the filter string."""

    def test_the_tone_chain_precedes_loudnorm(self):
        master.master_loudnorm(self.src, self.dst, eq="warm")
        af = self.write_command()[self.write_command().index("-af") + 1]
        self.assertLess(af.index("firequalizer"), af.index("loudnorm"),
                        "tone must run before the loudness stage, or the "
                        "true-peak ceiling is applied to the wrong signal")

    def test_flat_adds_no_filter_before_loudnorm(self):
        """The default must not smuggle in a chain of its own."""
        master.master_loudnorm(self.src, self.dst, eq="flat")
        af = self.write_command()[self.write_command().index("-af") + 1]
        self.assertTrue(af.startswith("loudnorm"), af)

    def test_the_first_pass_is_measured_through_the_tone_chain(self):
        """Measuring the dry source and normalising an EQ'd one hands loudnorm
        numbers describing a signal it never sees, and the target is missed by
        however much the EQ moved the level."""
        master.master_loudnorm(self.src, self.dst, eq="warm")
        measuring = [f for f in self.filters() if "firequalizer" in f]
        self.assertGreaterEqual(len(measuring), 2,
                                "the measure pass did not go through the tone")

    def test_a_raw_chain_is_passed_through_verbatim(self):
        master.master_loudnorm(self.src, self.dst, eq="highpass=f=35:poles=2")
        af = self.write_command()[self.write_command().index("-af") + 1]
        self.assertTrue(af.startswith("highpass=f=35:poles=2,"), af)


class TestLoudnormParameters(_Argv):
    """What the second pass is told. The measured_* values are what make it
    linear rather than dynamic."""

    def test_the_targets_reach_the_filter(self):
        master.master_loudnorm(self.src, self.dst, lufs=-16.0, tp=-1.5, lra=9.0)
        af = self.write_command()[self.write_command().index("-af") + 1]
        self.assertIn("I=-16.0", af)
        self.assertIn("TP=-1.5", af)
        self.assertIn("LRA=9.0", af)

    def test_the_first_pass_measurements_are_handed_to_the_second(self):
        """Without measured_*, loudnorm re-measures in a single dynamic pass
        and rides the level through the track instead of applying one gain."""
        master.master_loudnorm(self.src, self.dst)
        af = self.write_command()[self.write_command().index("-af") + 1]
        for key in ("measured_I", "measured_TP", "measured_LRA",
                    "measured_thresh"):
            self.assertIn(key, af)

    def test_linear_is_requested_explicitly(self):
        master.master_loudnorm(self.src, self.dst)
        af = self.write_command()[self.write_command().index("-af") + 1]
        self.assertIn("linear=true", af)

    def test_the_second_pass_reports_back_as_json(self):
        """_warn_if_not_linear reads that report; without print_format=json
        there is nothing to read and the fallback goes unnoticed."""
        master.master_loudnorm(self.src, self.dst)
        af = self.write_command()[self.write_command().index("-af") + 1]
        self.assertIn("print_format=json", af)

    def test_the_source_rate_is_kept_when_none_is_asked_for(self):
        """Resampling silently is a change nobody requested, and 44.1 from 48
        is audible on cymbals."""
        master.master_loudnorm(self.src, self.dst)
        cmd = self.write_command()
        self.assertEqual(cmd[cmd.index("-ar") + 1], "48000")

    def test_an_explicit_rate_overrides_it(self):
        master.master_loudnorm(self.src, self.dst, sample_rate=44100)
        cmd = self.write_command()
        self.assertEqual(cmd[cmd.index("-ar") + 1], "44100")

    def test_each_bit_depth_maps_to_its_codec(self):
        for depth, codec in ((16, "pcm_s16le"), (24, "pcm_s24le"),
                             (32, "pcm_s32le")):
            with self.subTest(depth=depth):
                self.commands.clear()
                master.master_loudnorm(self.src, self.dst, bit_depth=depth)
                cmd = self.write_command()
                self.assertEqual(cmd[cmd.index("-c:a") + 1], codec)

    def test_an_unsupported_depth_is_refused_before_anything_runs(self):
        with self.assertRaises(master.MasterError) as c:
            master.master_loudnorm(self.src, self.dst, bit_depth=20)
        self.assertIn("20", str(c.exception))
        self.assertEqual([c for c in self.ffmpeg if c[-1] != "-"], [])

    def test_stdin_is_closed_on_every_call(self):
        """ffmpeg prompts to overwrite and waits forever when it cannot."""
        master.master_loudnorm(self.src, self.dst)
        for cmd in self.ffmpeg:
            self.assertIn("-nostdin", cmd)

    def test_nothing_is_ever_a_shell_string(self):
        master.master_loudnorm(self.src, self.dst, eq="warm")
        for cmd in self.commands:
            self.assertIsInstance(cmd, list)


class TestAtomicWrite(_Argv):
    """It encodes to a temp file and moves it into place."""

    def test_the_output_directory_is_created(self):
        deep = self.tmp / "masters" / "final" / "out.wav"
        master.master_loudnorm(self.src, deep)
        self.assertTrue(deep.parent.is_dir())

    def test_a_failed_encode_leaves_nothing_behind(self):
        """A half-written master sitting where the finished one belongs is
        worse than no file: the next step reads it as done."""
        def failing(argv, **kw):
            self.commands.append(argv)
            if argv[0] == "ffprobe":
                return subprocess.CompletedProcess(argv, 0, json.dumps(
                    {"streams": [{"sample_rate": "48000", "channels": 2}],
                     "format": {"duration": "240.0"}}), "")
            if argv[-1] == "-":
                return subprocess.CompletedProcess(argv, 0, "", _loudnorm_json())
            return subprocess.CompletedProcess(argv, 1, "", "Invalid argument")

        with unittest.mock.patch("subprocess.run", side_effect=failing):
            with self.assertRaises(master.MasterError):
                master.master_loudnorm(self.src, self.dst)
        self.assertFalse(self.dst.exists())
        self.assertEqual([p for p in self.tmp.iterdir() if p != self.src], [])

    def test_a_failure_reports_ffmpegs_last_lines(self):
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 1, "", "\n".join(f"line {i}" for i in range(40)))):
            with self.assertRaises(master.MasterError) as c:
                master._run(["ffmpeg"], "writing out.wav")
        self.assertIn("line 39", str(c.exception))
        self.assertNotIn("line 0", str(c.exception))
        self.assertIn("writing out.wav", str(c.exception))


class TestMeasureParsing(unittest.TestCase):
    """measure() scrapes JSON out of ffmpeg's stderr around a banner."""

    def test_the_four_fields_are_read(self):
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 0, "", _loudnorm_json(input_i=-11.5, input_tp=0.7,
                                              input_lra=4.2,
                                              input_thresh=-22.1))), \
                unittest.mock.patch.object(Path, "is_file", return_value=True):
            got = master.measure(Path("x.wav"))
        self.assertAlmostEqual(got.integrated, -11.5)
        self.assertAlmostEqual(got.true_peak, 0.7)
        self.assertAlmostEqual(got.lra, 4.2)
        self.assertAlmostEqual(got.threshold, -22.1)

    def test_a_missing_file_is_named_before_ffmpeg_is_called(self):
        with unittest.mock.patch("subprocess.run") as run:
            with self.assertRaises(master.MasterError) as c:
                master.measure(Path("/nowhere/absent.wav"))
        run.assert_not_called()
        self.assertIn("absent.wav", str(c.exception))

    def test_output_with_no_measurement_is_a_readable_error(self):
        """ffmpeg exits 0 with no report on a file it cannot decode."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 0, "", "Invalid data found when processing input")), \
                unittest.mock.patch.object(Path, "is_file", return_value=True):
            with self.assertRaises(master.MasterError) as c:
                master.measure(Path("broken.wav"))
        self.assertIn("Could not read loudness", str(c.exception))

    def test_describe_states_all_three_headline_numbers(self):
        """It is the one line a person reads before and after a master."""
        text = master.Loudness(-14.2, -1.35, 6.4, -25.0).describe()
        self.assertIn("-14.2", text)
        self.assertIn("-1.4", text)      # rounded to a tenth, like the rest
        self.assertIn("6.4", text)

    def test_describe_keeps_the_sign_on_a_peak_over_the_ceiling(self):
        """+0.5 and -0.5 dBTP mean opposite things about whether the file is
        about to distort, and the line is read at a glance."""
        self.assertIn("+0.5", master.Loudness(-9.0, 0.5, 3.0, -20.0).describe())

    def test_measure_through_with_no_chain_does_not_build_one(self):
        """An empty chain must not produce a leading comma, which ffmpeg
        rejects as an empty filter."""
        with unittest.mock.patch.object(master, "measure") as plain:
            master._measure_through(Path("x.wav"), "")
        plain.assert_called_once()

    def test_measure_through_reports_an_unreadable_chain(self):
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "", "nothing")):
            with self.assertRaises(master.MasterError) as c:
                master._measure_through(Path("x.wav"), "highpass=f=30")
        self.assertIn("tone chain", str(c.exception))


class TestRequire(unittest.TestCase):
    def test_both_tools_are_named_when_both_are_missing(self):
        with unittest.mock.patch.object(master.shutil, "which", return_value=None):
            with self.assertRaises(master.MasterError) as c:
                master._require("ffmpeg", "ffprobe")
        self.assertIn("ffmpeg", str(c.exception))
        self.assertIn("ffprobe", str(c.exception))

    def test_the_message_says_how_to_install_it(self):
        """A missing ffmpeg is the most common first-run failure."""
        with unittest.mock.patch.object(master.shutil, "which", return_value=None):
            with self.assertRaises(master.MasterError) as c:
                master._require("ffmpeg")
        self.assertIn("brew install ffmpeg", str(c.exception))


class TestReferenceMode(unittest.TestCase):
    """Reference mastering needs matchering, which is not a dependency here.
    Both the library and its absence are simulated: the import is the branch
    that matters and it cannot be reached any other way on this machine."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.src = self.tmp / "in.wav"
        self.ref = self.tmp / "ref.wav"
        for p in (self.src, self.ref):
            p.write_bytes(b"")
        quiet = unittest.mock.patch.object(master.log, "info")
        quiet.start()
        self.addCleanup(quiet.stop)

    def _matchering(self):
        """A stand-in for the library, recording what it was asked to do."""
        mg = unittest.mock.MagicMock()
        mg.pcm24.side_effect = lambda p: ("pcm24", p)
        return mg

    def test_a_missing_library_says_how_to_install_it(self):
        """The feature is optional, so the error has to be the instructions."""
        with unittest.mock.patch.dict("sys.modules", {"matchering": None}):
            with self.assertRaises(master.MasterError) as c:
                master.master_reference(self.src, self.tmp / "o.wav", self.ref)
        self.assertIn("pip install matchering", str(c.exception))

    def test_a_missing_reference_is_named(self):
        mg = self._matchering()
        with unittest.mock.patch.dict("sys.modules", {"matchering": mg}):
            with self.assertRaises(master.MasterError) as c:
                master.master_reference(self.src, self.tmp / "o.wav",
                                        self.tmp / "absent.wav")
        self.assertIn("absent.wav", str(c.exception))
        mg.process.assert_not_called()

    def test_the_target_and_reference_reach_matchering(self):
        mg = self._matchering()
        out = self.tmp / "o.wav"
        with unittest.mock.patch.dict("sys.modules", {"matchering": mg}), \
                unittest.mock.patch.object(master, "measure",
                                           return_value=master.Loudness(
                                               -14.0, -1.0, 6.0, -24.0)):
            master.master_reference(self.src, out, self.ref)
        kw = mg.process.call_args[1]
        self.assertEqual(kw["target"], str(self.src))
        self.assertEqual(kw["reference"], str(self.ref))

    def test_the_result_is_written_at_24_bit(self):
        """16-bit would throw away headroom before the file is even auditioned."""
        mg = self._matchering()
        with unittest.mock.patch.dict("sys.modules", {"matchering": mg}), \
                unittest.mock.patch.object(master, "measure",
                                           return_value=master.Loudness(
                                               -14.0, -1.0, 6.0, -24.0)):
            master.master_reference(self.src, self.tmp / "o.wav", self.ref)
        mg.pcm24.assert_called_once()

    def test_the_output_directory_is_created(self):
        mg = self._matchering()
        deep = self.tmp / "masters" / "o.wav"
        with unittest.mock.patch.dict("sys.modules", {"matchering": mg}), \
                unittest.mock.patch.object(master, "measure",
                                           return_value=master.Loudness(
                                               -14.0, -1.0, 6.0, -24.0)):
            master.master_reference(self.src, deep, self.ref)
        self.assertTrue(deep.parent.is_dir())

    def test_a_matchering_failure_becomes_a_readable_error(self):
        mg = self._matchering()
        mg.process.side_effect = RuntimeError("length mismatch")
        with unittest.mock.patch.dict("sys.modules", {"matchering": mg}), \
                unittest.mock.patch.object(master, "measure",
                                           return_value=master.Loudness(
                                               -14.0, -1.0, 6.0, -24.0)):
            with self.assertRaises(master.MasterError) as c:
                master.master_reference(self.src, self.tmp / "o.wav", self.ref)
        self.assertIn("length mismatch", str(c.exception))


class TestMain(unittest.TestCase):
    """The CLI. serve.py and mcp.py both run this as a subprocess, so the exit
    codes and what lands on stdout are an interface."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.src = self.tmp / "in.wav"
        self.src.write_bytes(b"")
        quiet = unittest.mock.patch.object(master.log, "error")
        quiet.start()
        self.addCleanup(quiet.stop)
        ok = unittest.mock.patch.object(master, "_require")
        ok.start()
        self.addCleanup(ok.stop)

    def test_list_eq_prints_every_preset_and_exits(self):
        """The discovery path. It must not need a file, since you run it
        before you have decided what to master."""
        buf = io.StringIO()
        with unittest.mock.patch.object(master, "master_loudnorm") as ran, \
                redirect_stdout(buf):
            rc = master.main(["--list-eq"])
        self.assertEqual(rc, 0)
        ran.assert_not_called()
        for name in master.EQ_PRESETS:
            self.assertIn(name, buf.getvalue())

    def test_measure_prints_the_numbers_and_writes_nothing(self):
        buf = io.StringIO()
        with unittest.mock.patch.object(
                master, "measure",
                return_value=master.Loudness(-12.2, -0.5, 5.5, -24.0)), \
                unittest.mock.patch.object(master, "master_loudnorm") as ran, \
                redirect_stdout(buf):
            rc = master.main(["--in", str(self.src), "--measure"])
        self.assertEqual(rc, 0)
        ran.assert_not_called()
        self.assertIn("-12.2", buf.getvalue())

    def test_every_flag_reaches_master_loudnorm(self):
        with unittest.mock.patch.object(master, "master_loudnorm") as ran, \
                redirect_stdout(io.StringIO()):
            master.main(["--in", str(self.src), "--out", str(self.tmp / "o.wav"),
                         "--lufs", "-16", "--tp", "-1.5", "--lra", "9",
                         "--sample-rate", "44100", "--bit-depth", "16",
                         "--eq", "warm"])
        kw = ran.call_args[1]
        self.assertEqual(kw["lufs"], -16.0)
        self.assertEqual(kw["tp"], -1.5)
        self.assertEqual(kw["lra"], 9.0)
        self.assertEqual(kw["sample_rate"], 44100)
        self.assertEqual(kw["bit_depth"], 16)
        self.assertEqual(kw["eq"], "warm")

    def test_the_defaults_are_the_streaming_targets(self):
        """-14 LUFS / -1 dBTP is what the rest of the shop assumes; a drift
        here would silently change every master made without flags."""
        with unittest.mock.patch.object(master, "master_loudnorm") as ran, \
                redirect_stdout(io.StringIO()):
            master.main(["--in", str(self.src), "--out", str(self.tmp / "o.wav")])
        kw = ran.call_args[1]
        self.assertEqual(kw["lufs"], master.DEFAULT_LUFS)
        self.assertEqual(kw["tp"], master.DEFAULT_TP)
        self.assertEqual(kw["bit_depth"], 24)
        self.assertEqual(kw["eq"], "flat")

    def test_a_reference_switches_modes(self):
        ref = self.tmp / "ref.wav"
        ref.write_bytes(b"")
        with unittest.mock.patch.object(master, "master_reference") as matched, \
                unittest.mock.patch.object(master, "master_loudnorm") as normed, \
                redirect_stdout(io.StringIO()):
            master.main(["--in", str(self.src), "--out", str(self.tmp / "o.wav"),
                         "--reference", str(ref)])
        matched.assert_called_once()
        normed.assert_not_called()

    def test_writing_over_the_source_is_refused(self):
        """There is no undo. Overwriting the take with its own master loses
        the only copy of what went in."""
        with unittest.mock.patch.object(master, "master_loudnorm") as ran:
            rc = master.main(["--in", str(self.src), "--out", str(self.src)])
        self.assertEqual(rc, 1)
        ran.assert_not_called()

    def test_a_path_that_resolves_to_the_source_is_refused_too(self):
        """Compared after resolve(), so `takes/../in.wav` does not slip past."""
        sneaky = self.tmp / "sub" / ".." / "in.wav"
        (self.tmp / "sub").mkdir()
        with unittest.mock.patch.object(master, "master_loudnorm") as ran:
            rc = master.main(["--in", str(self.src), "--out", str(sneaky)])
        self.assertEqual(rc, 1)
        ran.assert_not_called()

    def test_it_prints_the_path_it_wrote(self):
        """The caller reads this off stdout to find the file."""
        out = self.tmp / "o.wav"
        buf = io.StringIO()
        with unittest.mock.patch.object(master, "master_loudnorm"), \
                redirect_stdout(buf):
            master.main(["--in", str(self.src), "--out", str(out)])
        self.assertEqual(buf.getvalue().strip(), str(out))

    def test_a_missing_in_is_a_usage_error(self):
        with self.assertRaises(SystemExit):
            master.main(["--out", str(self.tmp / "o.wav")])

    def test_a_missing_out_without_measure_is_a_usage_error(self):
        with self.assertRaises(SystemExit):
            master.main(["--in", str(self.src)])

    def test_a_refusal_is_an_exit_code_not_a_traceback(self):
        with unittest.mock.patch.object(
                master, "master_loudnorm",
                side_effect=master.MasterError("unsupported bit depth")):
            rc = master.main(["--in", str(self.src),
                              "--out", str(self.tmp / "o.wav")])
        self.assertEqual(rc, 1)

    def test_ctrl_c_is_130(self):
        """A master on a long track runs for minutes; interrupting is normal."""
        with unittest.mock.patch.object(master, "master_loudnorm",
                                        side_effect=KeyboardInterrupt):
            rc = master.main(["--in", str(self.src),
                              "--out", str(self.tmp / "o.wav")])
        self.assertEqual(rc, 130)

    def test_missing_ffmpeg_stops_before_anything_is_measured(self):
        with unittest.mock.patch.object(
                master, "_require",
                side_effect=master.MasterError("ffmpeg not found")), \
                unittest.mock.patch.object(master, "measure") as measured:
            rc = master.main(["--in", str(self.src), "--measure"])
        self.assertEqual(rc, 1)
        measured.assert_not_called()


if __name__ == "__main__":
    unittest.main()
