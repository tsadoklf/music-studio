#!/usr/bin/env python3
"""Tests for report.py.

The verdicts are the judgement the whole studio rests on, so the tests pin the
thresholds and the ordering rather than the wording. The agent report is tested
for the constraints it must carry: without them a model reliably recommends EQ
for a codec-limited file, which is the wrong answer stated confidently.
"""

from __future__ import annotations

import unittest

import report


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


if __name__ == "__main__":
    unittest.main()
