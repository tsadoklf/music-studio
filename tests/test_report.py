#!/usr/bin/env python3
"""Tests for report.py.

The verdicts are the judgement the whole studio rests on, so the tests pin the
thresholds and the ordering rather than the wording. The agent report is tested
for the constraints it must carry: without them a model reliably recommends EQ
for a codec-limited file, which is the wrong answer stated confidently.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

from music_studio.insight import report


def analysis(**over) -> dict:
    base = {
        "targets": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.0},
        "metadata": {"filename": "x.wav", "duration": 240.0, "sample_rate": 48000,
                     "channels": 2, "bit_depth": 24},
        "measures": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.5, "lra": 7.0,
                     "crest_factor": 15.0, "peak": -2.0},
        "codec": {"cutoff_hz": 20000.0, "confidence": 0.0, "lossy_suspected": False},
        "clipping": {"clipped_samples": 0, "runs": 0, "clipping_suspected": False},
        "stereo": {"correlation": 0.6, "width": 0.4, "balance_db": 0.0},
        "spectrum": {"bands": {"sub": -28.0, "air": -68.0}},
    }
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = {**base[key], **value}
        else:
            base[key] = value
    return base


def find(vs, vid):
    return next((v for v in vs if v["id"] == vid), None)


class TestCodecVerdict(unittest.TestCase):
    def test_low_bitrate_cutoff_is_bad(self):
        vs = report.verdicts(analysis(
            codec={"cutoff_hz": 15100.0, "confidence": 0.87, "lossy_suspected": True}))
        v = find(vs, "codec")
        self.assertEqual(v["severity"], "bad")
        self.assertIn("WAV", v["action"])

    def test_never_recommends_eq_for_a_codec_cutoff(self):
        """The wrong answer a model reaches on its own; it must not come from us."""
        vs = report.verdicts(analysis(
            codec={"cutoff_hz": 15100.0, "confidence": 0.87, "lossy_suspected": True}))
        v = find(vs, "codec")
        self.assertNotIn("--eq", (v["action"] or ""))
        self.assertIn("no EQ restores it", v["detail"])

    def test_full_band_is_ok(self):
        self.assertEqual(find(report.verdicts(analysis()), "codec")["severity"], "ok")


class TestTruePeakVerdict(unittest.TestCase):
    def test_over_full_scale_is_bad(self):
        vs = report.verdicts(analysis(measures={"true_peak_dbtp": 0.54}))
        self.assertEqual(find(vs, "true_peak")["severity"], "bad")

    def test_over_ceiling_but_under_zero_is_a_warning(self):
        vs = report.verdicts(analysis(measures={"true_peak_dbtp": -0.5}))
        self.assertEqual(find(vs, "true_peak")["severity"], "warn")

    def test_inside_the_ceiling_is_ok(self):
        self.assertEqual(find(report.verdicts(analysis()), "true_peak")["severity"], "ok")

    def test_ceiling_comes_from_the_targets_block(self):
        """A shop that retargets must not be judged against a hardcoded -1."""
        vs = report.verdicts(analysis(
            targets={"integrated_lufs": -14.0, "true_peak_dbtp": -2.0},
            measures={"true_peak_dbtp": -1.5}))
        self.assertEqual(find(vs, "true_peak")["severity"], "warn")


class TestLoudnessVerdict(unittest.TestCase):
    def test_too_loud_warns(self):
        vs = report.verdicts(analysis(measures={"integrated_lufs": -12.2}))
        self.assertEqual(find(vs, "loudness")["severity"], "warn")
        self.assertIn("--lufs", find(vs, "loudness")["action"])

    def test_on_target_is_ok(self):
        self.assertEqual(find(report.verdicts(analysis()), "loudness")["severity"], "ok")

    def test_slightly_quiet_is_still_ok(self):
        """Quieter than target costs nothing; only a big gap is worth flagging."""
        vs = report.verdicts(analysis(measures={"integrated_lufs": -15.5}))
        self.assertEqual(find(vs, "loudness")["severity"], "ok")

    def test_much_too_quiet_warns(self):
        vs = report.verdicts(analysis(measures={"integrated_lufs": -20.0}))
        self.assertEqual(find(vs, "loudness")["severity"], "warn")


class TestStereoVerdict(unittest.TestCase):
    def test_negative_correlation_is_bad(self):
        vs = report.verdicts(analysis(stereo={"correlation": -0.3}))
        self.assertEqual(find(vs, "stereo")["severity"], "bad")

    def test_normal_correlation_is_ok(self):
        self.assertEqual(find(report.verdicts(analysis()), "stereo")["severity"], "ok")


class TestOrderingAndHeadline(unittest.TestCase):
    def test_worst_first(self):
        vs = report.verdicts(analysis(
            codec={"cutoff_hz": 15100.0, "confidence": 0.9, "lossy_suspected": True},
            measures={"integrated_lufs": -12.0}))
        self.assertEqual(vs[0]["severity"], "bad")
        self.assertEqual(vs[-1]["severity"], "ok")

    def test_headline_says_not_ready_when_anything_is_bad(self):
        vs = report.verdicts(analysis(measures={"true_peak_dbtp": 0.5}))
        self.assertIn("Not ready", report.headline(vs))

    def test_headline_is_clean_when_everything_passes(self):
        self.assertEqual(report.headline(report.verdicts(analysis())), "Ready to upload")


class TestHumanReport(unittest.TestCase):
    def test_leads_with_the_verdict(self):
        text = report.human_report(analysis(measures={"true_peak_dbtp": 0.54}))
        self.assertIn("Not ready", text.split("\n")[2])

    def test_says_nothing_to_do_when_clean(self):
        self.assertIn("Nothing.", report.human_report(analysis()))

    def test_spans_are_unsigned(self):
        """A loudness range of +5.5 LU reads as though it could be negative."""
        text = report.human_report(analysis())
        self.assertIn("7.0 LU", text)
        self.assertNotIn("+7.0 LU", text)

    def test_levels_keep_their_sign(self):
        text = report.human_report(analysis(measures={"true_peak_dbtp": 0.54}))
        self.assertIn("+0.54 dBTP", text)


class TestAiReport(unittest.TestCase):
    """The constraints are the point; a silent edit dropping one would restore
    a confident wrong answer."""

    def test_carries_the_codec_rule(self):
        self.assertIn("not fixable", report.ai_report(analysis()))

    def test_carries_the_band_table_rule(self):
        self.assertIn("relative to this file only", report.ai_report(analysis()))

    def test_carries_the_loudness_rule(self):
        self.assertIn("normalise to", report.ai_report(analysis()))

    def test_carries_the_lra_caveat(self):
        self.assertIn("cannot diagnose over-compression", report.ai_report(analysis()))

    def test_facts_are_valid_json(self):
        import json
        text = report.ai_report(analysis())
        block = text.split("```json")[1].split("```")[0]
        data = json.loads(block)
        self.assertEqual(data["target_lufs"], -14.0)

    def test_findings_table_lists_every_verdict(self):
        a = analysis(measures={"true_peak_dbtp": 0.5, "integrated_lufs": -12.0})
        text = report.ai_report(a)
        for v in report.verdicts(a):
            self.assertIn(v["id"], text)


class TestSparseInput(unittest.TestCase):
    def test_empty_analysis_does_not_raise(self):
        vs = report.verdicts({})
        self.assertIsInstance(vs, list)
        report.human_report({})
        report.ai_report({})


class TestClippingVerdict(unittest.TestCase):
    """Clipping is reported only when it was actually detected. A count with
    no detection flag is a measurement artefact, not a finding."""

    def test_detected_clipping_is_a_warning_that_counts_it(self):
        v = find(report.verdicts(analysis(
            clipping={"clipping_suspected": True, "clipped_samples": 412,
                      "runs": 7})), "clipping")
        self.assertEqual(v["severity"], "warn")
        self.assertIn("412", v["title"])
        self.assertIn("7", v["title"])

    def test_no_clipping_produces_no_finding(self):
        """Silence is the right output. A green "no clipping" row is noise in
        a list whose job is to be short."""
        self.assertIsNone(find(report.verdicts(analysis()), "clipping"))

    def test_a_count_without_the_detection_flag_is_not_reported(self):
        v = find(report.verdicts(analysis(
            clipping={"clipping_suspected": False, "clipped_samples": 3})),
            "clipping")
        self.assertIsNone(v)

    def test_the_flag_without_a_count_is_not_reported_either(self):
        v = find(report.verdicts(analysis(
            clipping={"clipping_suspected": True, "clipped_samples": 0})),
            "clipping")
        self.assertIsNone(v)


class TestDynamicsVerdict(unittest.TestCase):
    """The one verdict that deliberately refuses to decide.

    A low loudness range means over-compression on a dense mix and nothing at
    all on a sparse one, and no number distinguishes them. Saying so is the
    honest output; picking one would be wrong half the time."""

    def test_a_narrow_range_warns(self):
        v = find(report.verdicts(analysis(measures={"lra": 3.0})), "dynamics")
        self.assertEqual(v["severity"], "warn")
        self.assertIn("narrow", v["title"])

    def test_it_declines_to_say_which_cause_it_is(self):
        v = find(report.verdicts(analysis(measures={"lra": 3.0})), "dynamics")
        self.assertIn("sparse", v["detail"])
        self.assertIn("Listen", v["action"])

    def test_a_healthy_range_is_ok(self):
        v = find(report.verdicts(analysis(measures={"lra": 7.0})), "dynamics")
        self.assertEqual(v["severity"], "ok")

    def test_four_lu_is_the_boundary_and_reads_as_healthy(self):
        self.assertEqual(
            find(report.verdicts(analysis(measures={"lra": 4.0})),
                 "dynamics")["severity"], "ok")

    def test_the_crest_factor_is_quoted_when_it_is_known(self):
        """It is the second number an engineer looks at, and the LRA alone
        does not distinguish a limited master from a quiet one."""
        v = find(report.verdicts(analysis(
            measures={"lra": 3.0, "crest_factor": 6.2})), "dynamics")
        self.assertIn("6.2", v["detail"])

    def test_a_missing_crest_factor_does_not_break_the_sentence(self):
        a = analysis()
        a["measures"] = {"lra": 3.0}
        v = find(report.verdicts(a), "dynamics")
        self.assertNotIn("None", v["detail"])

    def test_no_lra_produces_no_finding(self):
        a = analysis()
        a["measures"] = {"integrated_lufs": -14.0}
        self.assertIsNone(find(report.verdicts(a), "dynamics"))


class TestWideStereoVerdict(unittest.TestCase):
    def test_a_very_wide_image_warns_without_calling_it_broken(self):
        """Between 0 and 0.3 is wide, not out of phase. Calling it bad would
        send someone hunting for an inverted channel that is not there."""
        v = find(report.verdicts(analysis(stereo={"correlation": 0.1})), "stereo")
        self.assertEqual(v["severity"], "warn")
        self.assertIn("wide", v["title"])

    def test_the_boundary_at_point_three_reads_as_normal(self):
        self.assertEqual(
            find(report.verdicts(analysis(stereo={"correlation": 0.3})),
                 "stereo")["severity"], "ok")

    def test_no_correlation_produces_no_finding(self):
        a = analysis()
        a["stereo"] = {}
        self.assertIsNone(find(report.verdicts(a), "stereo"))


class TestFormatting(unittest.TestCase):
    """The number formatter. Levels keep their sign because the sign is the
    information; spans are magnitudes and a leading plus on them is noise."""

    def test_a_level_keeps_its_sign(self):
        self.assertEqual(report._n(-12.2), "-12.2")
        self.assertEqual(report._n(0.54, places=2), "+0.54")

    def test_a_span_is_printed_unsigned(self):
        self.assertEqual(report._n(6.4, signed=False), "6.4")

    def test_a_missing_number_is_a_dash_not_a_zero(self):
        """0.0 dBTP is a real and alarming measurement; "not measured" must
        not be able to look like it."""
        self.assertEqual(report._n(None), "—")

    def test_a_non_numeric_value_is_passed_through_as_text(self):
        """Some fields carry a verdict string where a number is expected;
        formatting it with %f would raise mid-report."""
        self.assertEqual(report._n("n/a"), "n/a")

    def test_a_duration_is_minutes_and_seconds(self):
        self.assertEqual(report._dur(245), "4:05")

    def test_duration_seconds_are_always_two_digits(self):
        self.assertEqual(report._dur(244.6), "4:05")

    def test_a_missing_duration_is_a_dash(self):
        self.assertEqual(report._dur(None), "—")
        self.assertEqual(report._dur(0), "—")


class TestWriteReports(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_both_reports_are_written(self):
        out = report.write_reports(analysis(), self.tmp)
        self.assertTrue(out["human"].is_file())
        self.assertTrue(out["ai"].is_file())
        self.assertEqual(out["human"].name, "REPORT.md")
        self.assertEqual(out["ai"].name, "report.ai.md")

    def test_the_directory_is_created(self):
        deep = self.tmp / "a" / "b"
        report.write_reports(analysis(), deep)
        self.assertTrue(deep.is_dir())

    def test_a_stem_prefixes_both_names(self):
        """Two takes analysed into one directory would otherwise overwrite
        each other's reports."""
        out = report.write_reports(analysis(), self.tmp, stem="take-01")
        self.assertEqual(out["human"].name, "take-01.REPORT.md")
        self.assertEqual(out["ai"].name, "take-01.report.ai.md")

    def test_the_files_hold_the_reports_themselves(self):
        out = report.write_reports(analysis(), self.tmp)
        self.assertEqual(out["human"].read_text(encoding="utf-8"),
                         report.human_report(analysis()))

    def test_advice_is_folded_into_both(self):
        out = report.write_reports(analysis(), self.tmp,
                                   advice="Lower the ceiling to -1.5.")
        self.assertIn("Lower the ceiling", out["human"].read_text(encoding="utf-8"))


class TestMain(unittest.TestCase):
    """The CLI. studio_run.py calls it, and the browser reads what it writes."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        quiet = unittest.mock.patch.object(report.log, "error")
        quiet.start()
        self.addCleanup(quiet.stop)

    def _file(self, data=None) -> Path:
        p = self.tmp / "analysis.json"
        p.write_text(json.dumps(data if data is not None else analysis()))
        return p

    def test_both_kinds_are_written_by_default(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = report.main(["--analysis", str(self._file())])
        self.assertEqual(rc, 0)
        self.assertTrue((self.tmp / "REPORT.md").is_file())
        self.assertTrue((self.tmp / "report.ai.md").is_file())

    def test_they_land_beside_the_analysis_by_default(self):
        """So `music studio` leaves one directory holding everything about
        one take."""
        with redirect_stdout(io.StringIO()):
            report.main(["--analysis", str(self._file())])
        self.assertTrue((self.tmp / "REPORT.md").is_file())

    def test_an_out_dir_overrides_that(self):
        elsewhere = self.tmp / "reports"
        with redirect_stdout(io.StringIO()):
            report.main(["--analysis", str(self._file()),
                         "--out-dir", str(elsewhere)])
        self.assertTrue((elsewhere / "REPORT.md").is_file())

    def test_kind_human_prints_and_writes_nothing(self):
        """The inspection path: reading a report should not leave files
        behind in the take directory."""
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = report.main(["--analysis", str(self._file()), "--kind", "human"])
        self.assertEqual(rc, 0)
        self.assertIn("#", buf.getvalue())
        self.assertFalse((self.tmp / "REPORT.md").exists())

    def test_kind_ai_prints_the_agent_report(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            report.main(["--analysis", str(self._file()), "--kind", "ai"])
        self.assertIn("codec", buf.getvalue().lower())
        self.assertFalse((self.tmp / "report.ai.md").exists())

    def test_the_stem_reaches_the_filenames(self):
        with redirect_stdout(io.StringIO()):
            report.main(["--analysis", str(self._file()), "--stem", "take-02"])
        self.assertTrue((self.tmp / "take-02.REPORT.md").is_file())

    def test_advice_is_folded_in(self):
        with redirect_stdout(io.StringIO()):
            report.main(["--analysis", str(self._file()),
                         "--advice", "Re-master at -16."])
        self.assertIn("Re-master at -16.",
                      (self.tmp / "REPORT.md").read_text(encoding="utf-8"))

    def test_it_prints_where_each_file_went(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            report.main(["--analysis", str(self._file())])
        self.assertIn("REPORT.md", buf.getvalue())
        self.assertIn("report.ai.md", buf.getvalue())

    def test_a_missing_analysis_is_an_exit_code_not_a_traceback(self):
        self.assertEqual(report.main(["--analysis", str(self.tmp / "no.json")]), 1)


if __name__ == "__main__":
    unittest.main()
