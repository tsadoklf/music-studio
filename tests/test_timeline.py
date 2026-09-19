#!/usr/bin/env python3
"""Tests for timeline.py.

The value of a timed list is that it stays short and stays informative. Both
failure modes are easy to hit: a track that runs hot in every chorus produces a
wall of identical rows, and an over-eager merge throws away distinct facts that
happen to share a second. Both are tested here.

No test reaches the network. The commentary layer at the bottom is exercised
with `urlopen` patched, and what is asserted about it is mostly what it does
when the model is unavailable: commentary is a bonus, and losing it must never
lose a finding.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import unittest.mock
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path

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


# --------------------------------------------------------------------------
# the commentary layer
# --------------------------------------------------------------------------

class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def _reply(content) -> _FakeResponse:
    if not isinstance(content, str):
        content = json.dumps(content)
    return _FakeResponse(json.dumps(
        {"choices": [{"message": {"content": content}}]}).encode("utf-8"))


def _items():
    """Two findings in the shape add_comments is given them."""
    return [
        {"time": "1:02", "time_s": 62.0, "severity": "warn",
         "title": "Runs hot for 8s"},
        {"time": "2:30", "time_s": 150.0, "severity": "bad",
         "title": "True peak +0.5 dBTP"},
    ]


class _Comments(unittest.TestCase):
    def setUp(self):
        from music_studio.insight import advise
        key = unittest.mock.patch.object(advise, "_load_env_key",
                                         return_value="sk-test")
        key.start()
        self.addCleanup(key.stop)
        quiet = unittest.mock.patch.object(timeline.log, "warning")
        quiet.start()
        self.addCleanup(quiet.stop)

    def comment(self, reply, items=None, context=None):
        items = _items() if items is None else items
        with unittest.mock.patch("urllib.request.urlopen",
                                 return_value=_reply(reply)) as opened:
            out = timeline.add_comments(items, context or {"filename": "x.wav",
                                                           "target_lufs": -14.0})
        self.opened = opened
        return out


class TestCommentaryAttachment(_Comments):
    def test_a_comment_lands_on_its_own_finding(self):
        """Matched by timestamp, not by position: the model reorders, and a
        positional match would put the peak's explanation on the hot section."""
        out = self.comment([{"time_s": 150.0, "comment": "the snare hit"},
                            {"time_s": 62.0, "comment": "the second chorus"}])
        self.assertEqual(out[0]["comment"], "the second chorus")
        self.assertEqual(out[1]["comment"], "the snare hit")

    def test_a_near_miss_timestamp_still_matches(self):
        """Times are rounded to a tenth on both sides, so a model echoing
        62.04 back still finds its finding."""
        out = self.comment([{"time_s": 62.04, "comment": "here"}])
        self.assertEqual(out[0]["comment"], "here")

    def test_a_finding_the_model_skipped_keeps_its_title(self):
        out = self.comment([{"time_s": 62.0, "comment": "only this one"}])
        self.assertNotIn("comment", out[1])
        self.assertEqual(out[1]["title"], "True peak +0.5 dBTP")

    def test_a_comment_for_a_time_that_has_no_finding_is_dropped(self):
        """An invented timestamp must not create a row nobody measured."""
        out = self.comment([{"time_s": 999.0, "comment": "invented"}])
        self.assertEqual(len(out), 2)
        self.assertNotIn("invented", json.dumps(out))

    def test_an_empty_comment_does_not_overwrite_anything(self):
        out = self.comment([{"time_s": 62.0, "comment": ""}])
        self.assertNotIn("comment", out[0])

    def test_a_fenced_reply_is_unwrapped(self):
        out = self.comment('```json\n[{"time_s": 62.0, "comment": "fenced"}]\n```')
        self.assertEqual(out[0]["comment"], "fenced")

    def test_the_findings_are_sent_to_the_model(self):
        """It is commenting on measurements it cannot otherwise see."""
        self.comment([])
        body = json.loads(self.opened.call_args[0][0].data.decode("utf-8"))
        user = body["messages"][1]["content"]
        self.assertIn("Runs hot for 8s", user)
        self.assertIn("1:02", user)

    def test_the_track_and_target_travel_with_them(self):
        self.comment([])
        user = json.loads(
            self.opened.call_args[0][0].data.decode("utf-8"))["messages"][1]["content"]
        self.assertIn("x.wav", user)
        self.assertIn("-14", user)

    def test_the_key_travels_in_the_header(self):
        self.comment([])
        self.assertEqual(self.opened.call_args[0][0].headers["Authorization"],
                         "Bearer sk-test")


class TestCommentaryIsOptional(_Comments):
    """The point of the whole split. A model that is missing, broken, slow or
    lying must cost you the sentence and nothing else — the findings are
    arithmetic and were already correct before the call."""

    def test_nothing_is_requested_when_there_is_nothing_to_comment_on(self):
        with unittest.mock.patch("urllib.request.urlopen") as opened:
            self.assertEqual(timeline.add_comments([], {}), [])
        opened.assert_not_called()

    def test_no_key_leaves_every_finding_intact(self):
        from music_studio.insight import advise
        items = _items()
        with unittest.mock.patch.object(advise, "_load_env_key", return_value=None), \
                unittest.mock.patch("urllib.request.urlopen") as opened:
            out = timeline.add_comments(items, {})
        opened.assert_not_called()
        self.assertEqual(len(out), 2)
        self.assertNotIn("comment", out[0])

    def test_an_http_error_leaves_every_finding_intact(self):
        err = urllib.error.HTTPError("https://openrouter.ai", 429, "no", {},
                                     io.BytesIO(b"rate limited"))
        items = _items()
        with unittest.mock.patch("urllib.request.urlopen", side_effect=err):
            out = timeline.add_comments(items, {})
        self.assertEqual([i["title"] for i in out],
                         ["Runs hot for 8s", "True peak +0.5 dBTP"])

    def test_being_offline_leaves_every_finding_intact(self):
        items = _items()
        with unittest.mock.patch("urllib.request.urlopen",
                                 side_effect=urllib.error.URLError("no route")):
            self.assertEqual(len(timeline.add_comments(items, {})), 2)

    def test_prose_instead_of_json_leaves_every_finding_intact(self):
        out = self.comment("Sure, here are my thoughts on your track!")
        self.assertEqual(len(out), 2)
        self.assertNotIn("comment", out[0])

    def test_a_reply_with_no_choices_leaves_every_finding_intact(self):
        body = _FakeResponse(json.dumps({"error": {"message": "bad model"}}).encode())
        items = _items()
        with unittest.mock.patch("urllib.request.urlopen", return_value=body):
            self.assertEqual(len(timeline.add_comments(items, {})), 2)

    def test_junk_inside_a_valid_list_is_skipped_rather_than_fatal(self):
        """One malformed entry must not cost the comments on either side."""
        out = self.comment([None, "nonsense", {"time_s": 62.0, "comment": "kept"}])
        self.assertEqual(out[0]["comment"], "kept")


class TestBuild(unittest.TestCase):
    """build() is find_events plus an optional model call. The optional part
    has to be genuinely optional — this is the call that needs a key."""

    def test_no_model_is_called_by_default(self):
        with unittest.mock.patch.object(timeline, "add_comments") as called:
            timeline.build(analysis())
        called.assert_not_called()

    def test_comment_true_passes_the_track_context_through(self):
        with unittest.mock.patch.object(timeline, "add_comments") as called:
            timeline.build(analysis(), comment=True)
        context = called.call_args[0][1]
        self.assertEqual(context["filename"], "x.wav")
        self.assertEqual(context["target_lufs"], -14.0)

    def test_the_findings_are_the_same_either_way(self):
        """Commentary annotates; it must not add, drop or reorder anything."""
        with unittest.mock.patch.object(timeline, "add_comments",
                                        side_effect=lambda items, ctx: items):
            commented = timeline.build(analysis(), comment=True)
        self.assertEqual([i["title"] for i in timeline.build(analysis())],
                         [i["title"] for i in commented])


class TestMain(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        quiet = unittest.mock.patch.object(timeline.log, "error")
        quiet.start()
        self.addCleanup(quiet.stop)

    def _file(self, data=None) -> Path:
        p = self.tmp / "analysis.json"
        p.write_text(json.dumps(data if data is not None else analysis()))
        return p

    def test_prints_a_timeline_object(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = timeline.main(["--analysis", str(self._file())])
        self.assertEqual(rc, 0)
        self.assertIsInstance(json.loads(buf.getvalue())["timeline"], list)

    def test_out_writes_the_file_and_prints_only_its_path(self):
        """The caller reads the path off stdout; the JSON going there too
        would make it unusable as a path."""
        out = self.tmp / "timeline.json"
        buf = io.StringIO()
        with redirect_stdout(buf):
            timeline.main(["--analysis", str(self._file()), "--out", str(out)])
        self.assertEqual(buf.getvalue().strip(), str(out))
        self.assertIsInstance(json.loads(out.read_text())["timeline"], list)

    def test_no_model_is_called_without_comment(self):
        with unittest.mock.patch.object(timeline, "add_comments") as called, \
                redirect_stdout(io.StringIO()):
            timeline.main(["--analysis", str(self._file())])
        called.assert_not_called()

    def test_comment_reaches_build(self):
        with unittest.mock.patch.object(timeline, "add_comments",
                                        side_effect=lambda i, c: i) as called, \
                redirect_stdout(io.StringIO()):
            timeline.main(["--analysis", str(self._file()), "--comment"])
        called.assert_called_once()

    def test_a_missing_analysis_is_an_exit_code_not_a_traceback(self):
        rc = timeline.main(["--analysis", str(self.tmp / "nope.json")])
        self.assertEqual(rc, 1)


class TestReExports(unittest.TestCase):
    """The split moved find_events into audio/. __all__ is what keeps the old
    import path working for callers that were never told."""

    def test_everything_named_in_all_is_actually_there(self):
        for name in timeline.__all__:
            self.assertTrue(hasattr(timeline, name), name)

    def test_the_thresholds_are_the_same_objects_not_copies(self):
        """Two copies of ST_TOLERANCE would drift, and the timeline and the
        report would then disagree about what "hot" means."""
        self.assertIs(timeline.ST_TOLERANCE, pure.ST_TOLERANCE)
        self.assertIs(timeline.MERGE_WINDOW, pure.MERGE_WINDOW)
        self.assertIs(timeline.MAX_FINDINGS, pure.MAX_FINDINGS)
        self.assertIs(timeline.TimelineError, pure.TimelineError)


if __name__ == "__main__":
    unittest.main()
