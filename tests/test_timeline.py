#!/usr/bin/env python3
"""Tests for timeline.py.

The value of a timed list is that it stays short and stays informative. Both
failure modes are easy to hit: a track that runs hot in every chorus produces a
wall of identical rows, and an over-eager merge throws away distinct facts that
happen to share a second. Both are tested here.

No test calls a model; commentary is a bonus layer and its absence must never
remove a finding.
"""

from __future__ import annotations

import unittest

from music_studio.audio import timeline as pure
from music_studio.insight import timeline


def series(values, step=0.5):
    return {"times": [i * step for i in range(len(values))], "lufs": list(values)}


def analysis(short_term=None, **over):
    base = {
        "targets": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.0},
        "metadata": {"filename": "x.wav", "duration": 60.0},
        "measures": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.5},
        "loudness": {"short_term": short_term or series([-14.0] * 120)},
        "clipping": {"worst": []},
        "envelopes": {"points_per_second": 10, "channels": [{"peak": [0.5] * 600}]},
    }
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    return base


def titles(items):
    return " | ".join(i["title"] for i in items)


class TestBasicShape(unittest.TestCase):
    def test_every_item_has_a_time_and_a_label(self):
        for item in timeline.build(analysis()):
            self.assertIn("time_s", item)
            self.assertIn("time", item)
            self.assertIn(item["severity"], ("bad", "warn", "ok"))
            self.assertTrue(item["title"])
            self.assertTrue(item["detail"])

    def test_sorted_by_time(self):
        items = timeline.build(analysis())
        self.assertEqual([i["time_s"] for i in items],
                         sorted(i["time_s"] for i in items))

    def test_timestamps_are_formatted_as_minutes_and_seconds(self):
        self.assertEqual(pure._fmt(0), "0:00")
        self.assertEqual(pure._fmt(67.4), "1:07")
        self.assertEqual(pure._fmt(404.4), "6:44")


class TestEmptyAndSparse(unittest.TestCase):
    def test_empty_analysis_does_not_raise(self):
        self.assertEqual(timeline.build({}), [])

    def test_missing_loudness_series_does_not_raise(self):
        self.assertIsInstance(timeline.build({"metadata": {"duration": 10}}), list)


class TestBreaches(unittest.TestCase):
    def test_a_sustained_hot_section_is_found(self):
        vals = [-14.0] * 40 + [-9.0] * 40 + [-14.0] * 40
        items = timeline.build(analysis(series(vals)))
        self.assertIn("above target", titles(items))

    def test_a_brief_excursion_is_ignored(self):
        """Two seconds off target is a transient, not a section."""
        vals = [-14.0] * 60 + [-9.0] * 3 + [-14.0] * 60
        items = timeline.build(analysis(series(vals)))
        self.assertNotIn("above target", titles(items))

    def test_repeated_breaches_collapse_into_a_summary(self):
        """Eight hot choruses are one fact, not eight rows."""
        block = [-14.0] * 30 + [-9.0] * 30
        items = timeline.build(analysis(series(block * 8)))
        breaches = [i for i in items if "above target" in i["title"]]
        summary = [i for i in items if "sections run off target" in i["title"]]
        self.assertLessEqual(len(breaches), pure.MAX_PER_KIND)
        self.assertEqual(len(summary), 1)

    def test_the_kept_breaches_are_the_furthest_from_target(self):
        """Ranking on bare LUFS magnitude gets this backwards on a hot track."""
        vals = ([-14.0] * 30 + [-11.0] * 30) * 3 + [-14.0] * 30 + [-7.0] * 30
        items = timeline.build(analysis(series(vals)))
        kept = [i for i in items if "above target" in i["title"]]
        self.assertTrue(any("-7.0" in i["title"] for i in kept),
                        "the worst section was dropped in favour of a milder one")


class TestMerging(unittest.TestCase):
    def test_different_kinds_at_the_same_second_both_survive(self):
        """A fade-in puts the opening and the quietest passage both at 0:00."""
        vals = [-40.0] + [-14.0] * 119
        items = timeline.build(analysis(series(vals)))
        at_zero = [i for i in items if i["time_s"] < 1.0]
        self.assertGreaterEqual(len(at_zero), 2, titles(items))
        self.assertIn("Opens at", titles(at_zero))
        self.assertIn("Quietest", titles(at_zero))

    def test_list_stays_short(self):
        vals = ([-14.0] * 20 + [-8.0] * 20) * 20
        self.assertLessEqual(len(timeline.build(analysis(series(vals)))),
                             timeline.MAX_FINDINGS)


class TestTruePeak(unittest.TestCase):
    def test_peak_over_the_ceiling_is_dated(self):
        items = timeline.build(analysis(measures={"true_peak_dbtp": 0.54}))
        peaks = [i for i in items if "Peak reaches" in i["title"]]
        self.assertEqual(len(peaks), 1)
        self.assertEqual(peaks[0]["severity"], "bad")

    def test_peak_inside_the_ceiling_is_not_reported(self):
        self.assertNotIn("Peak reaches", titles(timeline.build(analysis())))

    def test_over_ceiling_but_under_zero_is_a_warning(self):
        items = timeline.build(analysis(measures={"true_peak_dbtp": -0.4}))
        peaks = [i for i in items if "Peak reaches" in i["title"]]
        self.assertEqual(peaks[0]["severity"], "warn")


class TestClipping(unittest.TestCase):
    def test_clipping_events_become_findings(self):
        items = timeline.build(analysis(
            clipping={"worst": [{"time_s": 12.5, "samples": 9}]}))
        clips = [i for i in items if "Clipping" in i["title"]]
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0]["severity"], "bad")
        self.assertEqual(clips[0]["time"], "0:12")


class TestEnding(unittest.TestCase):
    def test_a_fade_is_recognised(self):
        vals = [-12.0] * 100 + [-30.0] * 20
        self.assertIn("Fades out", titles(timeline.build(analysis(series(vals)))))

    def test_a_hard_ending_is_recognised(self):
        self.assertIn("Ends at full level", titles(timeline.build(analysis())))


if __name__ == "__main__":
    unittest.main()
