#!/usr/bin/env python3
"""Comparing a track against records that already work.

A delivery target says a track should sit near -14 LUFS. It cannot say whether
7.5 LU of range is generous or mean, because that question has no answer in the
abstract. A benchmark is the other half of the verdict.

The property worth guarding hardest is what may be compared. Band energies are
RELATIVE TO ONE FILE — the table carries no reference level and every mix reads
lower toward the top — so raw band dB between two records is meaningless, and
would be meaningless while looking authoritative. `_tilt` normalises first.
That is invariant 5 in STATUS.md, and a model reliably gets it wrong.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from music_studio.insight import benchmark as bm


def _analysis(lufs=-14.0, lra=7.5, crest=14.0, tp=-2.0, bands=None, corr=0.7):
    return {
        "schema": "audio-analysis/v1",
        "metadata": {"filename": "take.wav", "duration": 200.0,
                     "sample_rate": 48000, "channels": 2},
        "measures": {"integrated_lufs": lufs, "lra": lra, "crest_factor": crest,
                     "true_peak_dbtp": tp, "rms": -18.0, "peak": tp},
        "spectrum": {"bands": bands or {"sub": -29.0, "bass": -36.0,
                                        "low-mid": -41.0, "mid": -48.0,
                                        "high-mid": -62.0, "treble": -66.0,
                                        "air": -69.0}},
        "stereo": {"correlation": corr, "width": 1.0, "side_to_mid_db": -8.0},
    }


class TestDigest(unittest.TestCase):
    """A benchmark must be small enough to commit, which is the whole design."""

    def test_the_bulk_is_dropped(self):
        full = _analysis()
        full["spectrogram"] = {"db": [0.0] * 100000}     # the megabytes
        full["envelopes"] = {"channels": [{"peak": [0.0] * 50000}]}
        d = bm.digest(full)
        self.assertNotIn("spectrogram", d)
        self.assertNotIn("envelopes", d)

    def test_it_stays_small(self):
        """A library of references has to survive a fresh clone. If a digest
        runs to megabytes the idea does not work."""
        blob = json.dumps(bm.digest(_analysis()))
        self.assertLess(len(blob), 4096, f"{len(blob)} bytes is too big to commit")

    def test_no_path_to_the_audio_is_kept(self):
        """The audio is not stored, referenced or needed — that is what makes
        a commercial reference possible at all."""
        blob = json.dumps(bm.digest(_analysis()))
        self.assertNotIn(".wav", blob.replace("take.wav", ""))

    def test_the_measurements_that_compare_are_kept(self):
        d = bm.digest(_analysis())
        for key in ("integrated_lufs", "lra", "crest_factor", "true_peak_dbtp"):
            self.assertIn(key, d["measures"])
        self.assertIn("bands", d)
        self.assertIn("correlation", d["stereo"])

    def test_the_note_and_title_survive(self):
        d = bm.digest(_analysis(), note="why this one", title="Aja")
        self.assertEqual(d["note"], "why this one")
        self.assertEqual(d["title"], "Aja")


class TestTilt(unittest.TestCase):
    """The rule that stops this being confidently wrong."""

    def test_a_uniform_offset_does_not_change_the_tilt(self):
        """Two records at different absolute levels with the SAME balance must
        compare as identical. Raw band dB would call them wildly different."""
        a = {"sub": -20.0, "mid": -40.0, "air": -60.0}
        b = {k: v - 12.0 for k, v in a.items()}          # same shape, 12 dB down
        self.assertEqual(bm._tilt(a), bm._tilt(b))

    def test_the_reference_band_is_zero_by_construction(self):
        t = bm._tilt({"sub": -20.0, "mid": -40.0, "air": -60.0})
        self.assertEqual(t[bm.TILT_REFERENCE], 0.0)

    def test_a_real_difference_survives_normalisation(self):
        dark = {"mid": -40.0, "air": -70.0}
        bright = {"mid": -40.0, "air": -55.0}
        self.assertLess(bm._tilt(dark)["air"], bm._tilt(bright)["air"])

    def test_no_reference_band_means_no_tilt_rather_than_a_guess(self):
        self.assertEqual(bm._tilt({"sub": -20.0, "air": -60.0}), {})

    def test_bands_are_compared_as_tilt_not_as_levels(self):
        """The integration check: a benchmark recorded 12 dB hotter across
        every band must produce NO tonal finding."""
        mine = _analysis()
        theirs = bm.digest(_analysis(
            bands={k: v + 12.0 for k, v in mine["spectrum"]["bands"].items()}))
        self.assertEqual(bm.compare(mine, theirs)["bands"], [],
                         "a uniform level difference was reported as tonal")


class TestCompare(unittest.TestCase):
    def test_a_quieter_track_is_named_as_quieter(self):
        rows = bm.compare(_analysis(lufs=-18.0),
                          bm.digest(_analysis(lufs=-12.0)))["measures"]
        row = next(r for r in rows if r["field"] == "integrated_lufs")
        self.assertLess(row["delta"], 0)
        self.assertIn("quieter", row["meaning"])

    def test_more_range_is_named_as_more_dynamic(self):
        rows = bm.compare(_analysis(lra=11.0),
                          bm.digest(_analysis(lra=4.0)))["measures"]
        row = next(r for r in rows if r["field"] == "lra")
        self.assertIn("dynamic", row["meaning"])

    def test_a_difference_below_the_threshold_is_not_reported(self):
        """Reporting every hundredth of a dB would bury the differences that
        are decisions under the ones that are noise."""
        rows = bm.compare(_analysis(lufs=-14.0),
                          bm.digest(_analysis(lufs=-14.4)))["measures"]
        self.assertEqual([r for r in rows if r["field"] == "integrated_lufs"], [])

    def test_identical_records_produce_nothing(self):
        result = bm.compare(_analysis(), bm.digest(_analysis()))
        self.assertEqual(result["measures"], [])
        self.assertEqual(result["bands"], [])

    def test_a_missing_field_is_skipped_rather_than_fatal(self):
        """An older benchmark may not carry every measurement. It must still
        compare on what it does have."""
        thin = bm.digest(_analysis())
        del thin["measures"]["lra"]
        rows = bm.compare(_analysis(lra=11.0), thin)["measures"]
        self.assertEqual([r for r in rows if r["field"] == "lra"], [])

    def test_the_note_travels_into_the_result(self):
        r = bm.compare(_analysis(), bm.digest(_analysis(), note="the reason"))
        self.assertEqual(r["note"], "the reason")


class TestRender(unittest.TestCase):
    def test_agreement_is_stated_rather_than_left_blank(self):
        """An empty result reads as a bug. Silence has to say it is silence."""
        text = bm.render(bm.compare(_analysis(), bm.digest(_analysis())))
        self.assertIn("Nothing notable differs", text)

    def test_both_numbers_appear(self):
        text = bm.render(bm.compare(_analysis(lufs=-18.0),
                                    bm.digest(_analysis(lufs=-12.0))))
        self.assertIn("-18", text)
        self.assertIn("-12", text)


class TestLibrary(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        patcher = unittest.mock.patch.object(bm, "library_dir",
                                             return_value=self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_save_then_load_round_trips(self):
        bm.save("aja", _analysis(lra=11.0), note="the dynamics reference")
        got = bm.load("aja")
        self.assertEqual(got["measures"]["lra"], 11.0)
        self.assertEqual(got["note"], "the dynamics reference")

    def test_an_unknown_name_names_the_alternatives(self):
        bm.save("aja", _analysis())
        with self.assertRaises(bm.BenchmarkError) as caught:
            bm.load("gaucho")
        self.assertIn("aja", str(caught.exception))

    def test_an_empty_library_is_not_an_error(self):
        self.assertEqual(bm.available(), {})

    def test_a_name_that_would_escape_the_directory_is_refused(self):
        with self.assertRaises(bm.BenchmarkError):
            bm.save("../../etc/passwd", _analysis())

    def test_unreadable_json_is_reported_rather_than_raised_raw(self):
        (self.tmp / "broken.json").write_text("{not json", encoding="utf-8")
        with self.assertRaises(bm.BenchmarkError) as caught:
            bm.load("broken")
        self.assertIn("broken", str(caught.exception))


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        patcher = unittest.mock.patch.object(bm, "library_dir",
                                             return_value=self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.analysis = self.tmp / "a.json"
        self.analysis.write_text(json.dumps(_analysis()), encoding="utf-8")

    def test_add_then_compare(self):
        self.assertEqual(bm.main(["--add", "ref", "--analysis", str(self.analysis)]), 0)
        self.assertEqual(bm.main(["--analysis", str(self.analysis),
                                  "--against", "ref"]), 0)

    def test_comparing_against_nothing_fails_readably(self):
        self.assertEqual(bm.main(["--analysis", str(self.analysis),
                                  "--against", "nope"]), 1)

    def test_a_missing_analysis_fails_rather_than_crashing(self):
        self.assertEqual(bm.main(["--analysis", str(self.tmp / "no.json"),
                                  "--against", "x"]), 1)

    def test_list_works_on_an_empty_library(self):
        self.assertEqual(bm.main(["--list"]), 0)


class TestCliGrouping(unittest.TestCase):
    """`music benchmark list` / `music benchmark add`.

    The libraries are grouped and the track verbs are not, deliberately:
    almost every command in this CLI takes a track, so a noun in front of
    `master` or `scope` would swallow the whole tool and distinguish nothing.
    A library has contents, so `list` and `add` mean something and the bare
    group is a question rather than an action.
    """

    def setUp(self):
        from typer.testing import CliRunner
        self.runner = CliRunner()
        self.tmp = Path(tempfile.mkdtemp())
        patcher = unittest.mock.patch.object(bm, "library_dir",
                                             return_value=self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _invoke(self, argv):
        from music_studio.cli import app
        return self.runner.invoke(app, argv)

    def test_the_bare_group_shows_its_subcommands(self):
        out = self._invoke(["benchmark"]).stdout
        self.assertIn("list", out)
        self.assertIn("add", out)

    def test_list_on_an_empty_library_says_how_to_add_one(self):
        """An empty library is the normal first state; a dead end there is a
        worse answer than a next step."""
        result = self._invoke(["benchmark", "list"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("benchmark add", result.stdout)

    def test_list_shows_what_was_added(self):
        bm.save("aja", _analysis(lra=11.0), note="the dynamics reference")
        out = self._invoke(["benchmark", "list"]).stdout
        self.assertIn("aja", out)
        self.assertIn("11", out)
        self.assertIn("dynamics reference", out)

    def test_add_requires_a_name(self):
        """--as is what --against later refers to, so it cannot be guessed."""
        result = self._invoke(["benchmark", "add", "some.wav"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("--as", result.stdout + (result.stderr or ""))

    def test_add_measures_the_file_and_saves_the_numbers(self):
        with unittest.mock.patch("music_studio.audio.analyze.analyze",
                                 return_value=_analysis(lra=11.0)) as analysed:
            wav = self.tmp / "ref.wav"
            wav.write_bytes(b"\0")
            result = self._invoke(["benchmark", "add", str(wav), "--as", "ref"])
        self.assertEqual(result.exit_code, 0, result.output)
        analysed.assert_called_once()
        self.assertEqual(bm.load("ref")["measures"]["lra"], 11.0)

    def test_the_track_verbs_stayed_flat(self):
        """The point of the grouping. If `master` ever needs a noun in front
        of it, this test should be the thing that argues about it."""
        from music_studio.cli import app
        names = {c.name or c.callback.__name__ for c in app.registered_commands}
        for verb in ("master", "scope", "compare", "video", "measure"):
            self.assertIn(verb, names, f"`music {verb}` should stay one word")


if __name__ == "__main__":
    unittest.main()
