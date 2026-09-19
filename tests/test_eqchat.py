#!/usr/bin/env python3
"""Tests for eqchat.py.

No test calls a model. What is worth testing is the validator, because it is the
only thing standing between a model's output and the audio graph: a filter type
that does not exist, a 40 dB boost, or a frequency above Nyquist must never
reach a BiquadFilterNode, however confidently it was returned.

The prompt's domain knowledge is also pinned. The mapping from "hum" to a narrow
notch, and the rule that a codec cutoff cannot be EQ'd back, are the difference
between an equaliser that helps and one that confidently makes things worse.

The classes at the bottom do exercise interpret(), with `urlopen` patched — a
model that returns prose, a fenced code block, or nothing at all are all shapes
this has actually seen, and each has to end as a readable message rather than a
traceback in the studio panel.
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

from music_studio.insight import eqchat


class TestValidator(unittest.TestCase):
    def test_keeps_a_good_band(self):
        out = eqchat.validate([{"type": "peaking", "freq": 3500, "gain": 2.5, "q": 1.2}])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "peaking")
        self.assertEqual(out[0]["freq"], 3500.0)

    def test_drops_an_invented_filter_type(self):
        """A model can return a type WebAudio has never heard of."""
        out = eqchat.validate([{"type": "magic", "freq": 1000, "gain": 3, "q": 1}])
        self.assertEqual(out, [])

    def test_clamps_an_absurd_gain(self):
        out = eqchat.validate([{"type": "peaking", "freq": 1000, "gain": 40, "q": 1}])
        self.assertEqual(out[0]["gain"], eqchat.GAIN_LIMIT)

    def test_clamps_a_negative_absurd_gain(self):
        out = eqchat.validate([{"type": "peaking", "freq": 1000, "gain": -99, "q": 1}])
        self.assertEqual(out[0]["gain"], -eqchat.GAIN_LIMIT)

    def test_clamps_frequency_into_the_audible_range(self):
        low = eqchat.validate([{"type": "peaking", "freq": 2, "gain": 3, "q": 1}])
        high = eqchat.validate([{"type": "peaking", "freq": 48000, "gain": 3, "q": 1}])
        self.assertEqual(low[0]["freq"], eqchat.FREQ_MIN)
        self.assertEqual(high[0]["freq"], eqchat.FREQ_MAX)

    def test_clamps_q(self):
        out = eqchat.validate([{"type": "peaking", "freq": 1000, "gain": 3, "q": 500}])
        self.assertLessEqual(out[0]["q"], eqchat.Q_MAX)

    def test_rejects_nan_and_infinity(self):
        """max(lo, min(hi, nan)) returns hi — a NaN frequency would otherwise
        become a plausible-looking 20 kHz band nobody asked for."""
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(bad=bad):
                out = eqchat.validate(
                    [{"type": "peaking", "freq": bad, "gain": 3, "q": 1}])
                self.assertEqual(out, [], f"{bad} survived as a band")

    def test_nan_gain_falls_back_to_zero_and_is_dropped(self):
        out = eqchat.validate(
            [{"type": "peaking", "freq": 1000, "gain": float("nan"), "q": 1}])
        self.assertEqual(out, [])

    def test_drops_a_band_with_no_frequency(self):
        self.assertEqual(eqchat.validate([{"type": "peaking", "gain": 3}]), [])

    def test_drops_a_gain_band_parked_at_zero(self):
        """A 0 dB peaking band is a node that does nothing."""
        self.assertEqual(
            eqchat.validate([{"type": "peaking", "freq": 1000, "gain": 0, "q": 1}]), [])

    def test_keeps_a_gainless_type_at_zero(self):
        """A lowpass is defined by its corner, not its gain — it must survive."""
        out = eqchat.validate([{"type": "lowpass", "freq": 16000, "gain": 0, "q": 0.7}])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "lowpass")

    def test_caps_the_band_count(self):
        many = [{"type": "peaking", "freq": 100 + i * 100, "gain": 2, "q": 1}
                for i in range(40)]
        self.assertLessEqual(len(eqchat.validate(many)), eqchat.MAX_BANDS)

    def test_survives_junk(self):
        for junk in (None, [], [None], ["nonsense"], [{"nope": 1}], [[]]):
            with self.subTest(junk=junk):
                self.assertIsInstance(eqchat.validate(junk), list)

    def test_every_returned_type_is_a_real_webaudio_type(self):
        """The shape studio.js hands straight to BiquadFilterNode.type."""
        webaudio = {"lowpass", "highpass", "bandpass", "lowshelf", "highshelf",
                    "peaking", "notch", "allpass"}
        self.assertTrue(eqchat.VALID_TYPES.issubset(webaudio))

    def test_why_is_carried_but_bounded(self):
        out = eqchat.validate([{"type": "peaking", "freq": 1000, "gain": 3, "q": 1,
                                "why": "x" * 900}])
        self.assertIn("why", out[0])
        self.assertLessEqual(len(out[0]["why"]), 200)


class TestPromptKnowledge(unittest.TestCase):
    """The domain rules are the product here; a silent edit dropping one would
    restore a confident wrong answer."""

    def test_maps_hum_to_a_notch(self):
        self.assertIn("hum", eqchat.SYSTEM.lower())
        self.assertIn("notch", eqchat.SYSTEM.lower())

    def test_refuses_to_eq_back_a_codec_cutoff(self):
        self.assertIn("codec cutoff", eqchat.SYSTEM)

    def test_prefers_cutting_to_boosting(self):
        self.assertIn("CUT before you boost", eqchat.SYSTEM)

    def test_returns_data_not_commands(self):
        self.assertIn("DATA ONLY", eqchat.SYSTEM)

    def test_names_the_frequency_vocabulary(self):
        for word in ("boxy", "sibilance", "presence", "rumble", "air"):
            self.assertIn(word, eqchat.SYSTEM, f"{word} missing from the vocabulary")


class TestContext(unittest.TestCase):
    def test_flat_state_is_stated(self):
        self.assertIn("flat", eqchat._context([], None))

    def test_current_bands_are_listed(self):
        text = eqchat._context(
            [{"type": "peaking", "freq": 300, "gain": -3.0, "q": 1.2}], None)
        self.assertIn("300", text)
        self.assertIn("peaking", text)

    def test_codec_cutoff_is_flagged_to_the_model(self):
        text = eqchat._context([], {
            "codec": {"lossy_suspected": True, "cutoff_hz": 15100.0}})
        self.assertIn("15.1 kHz", text)
        self.assertIn("no EQ restores it", text)

    def test_missing_analysis_does_not_raise(self):
        self.assertIsInstance(eqchat._context(None, None), str)


class TestErrors(unittest.TestCase):
    def test_missing_key_is_readable(self):
        original = eqchat.__dict__.get("_load_env_key")
        from music_studio.insight import advise
        saved = advise._load_env_key
        advise._load_env_key = lambda: None
        try:
            with self.assertRaises(eqchat.EqChatError) as c:
                eqchat.interpret("brighter")
            self.assertIn("OPENROUTER_API_KEY", str(c.exception))
        finally:
            advise._load_env_key = saved
            if original is not None:
                eqchat.__dict__["_load_env_key"] = original


# --------------------------------------------------------------------------
# the call
# --------------------------------------------------------------------------

class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def _reply(content) -> _FakeResponse:
    """A model reply whose message content is `content` (a dict is serialised)."""
    if not isinstance(content, str):
        content = json.dumps(content)
    return _FakeResponse(json.dumps(
        {"choices": [{"message": {"content": content}}]}).encode("utf-8"))


class _Interpret(unittest.TestCase):
    def setUp(self):
        from music_studio.insight import advise
        key = unittest.mock.patch.object(advise, "_load_env_key",
                                         return_value="sk-test")
        key.start()
        self.addCleanup(key.stop)

    def interpret(self, content, ask="brighten it", **kw):
        with unittest.mock.patch("urllib.request.urlopen",
                                 return_value=_reply(content)) as opened:
            out = eqchat.interpret(ask, **kw)
        self.request = opened.call_args[0][0]
        self.body = json.loads(self.request.data.decode("utf-8"))
        return out


class TestRequestShape(_Interpret):
    def test_json_mode_is_requested(self):
        """The reply is parsed as JSON before it is validated. Asking for
        json_object is what keeps the model from wrapping it in an apology."""
        self.interpret({"bands": [], "summary": ""})
        self.assertEqual(self.body["response_format"], {"type": "json_object"})

    def test_the_temperature_is_near_zero(self):
        """"Brighten it" twice should move the same band the same way; an EQ
        that wanders between identical requests cannot be reasoned with."""
        self.interpret({"bands": [], "summary": ""})
        self.assertLessEqual(self.body["temperature"], 0.2)

    def test_the_current_bands_are_sent_so_more_can_mean_more(self):
        """Without the current state every request starts from flat, and
        "a bit more" undoes the move it was meant to extend."""
        self.interpret({"bands": [], "summary": ""},
                       bands=[{"type": "highshelf", "freq": 10000,
                               "gain": 2.0, "q": 0.7}])
        user = self.body["messages"][1]["content"]
        self.assertIn("highshelf", user)
        self.assertIn("10000", user)

    def test_the_request_is_carried_verbatim(self):
        self.interpret({"bands": [], "summary": ""}, ask="less boxy please")
        self.assertIn("less boxy please", self.body["messages"][1]["content"])

    def test_the_key_travels_in_the_header_not_the_body(self):
        self.interpret({"bands": [], "summary": ""})
        self.assertEqual(self.request.headers["Authorization"], "Bearer sk-test")
        self.assertNotIn("sk-test", self.request.data.decode("utf-8"))

    def test_a_timeout_is_set(self):
        """Without one a stalled connection hangs the EQ panel with no way to
        cancel from the page."""
        with unittest.mock.patch("urllib.request.urlopen",
                                 return_value=_reply({"bands": []})) as opened:
            eqchat.interpret("brighter")
        self.assertEqual(opened.call_args[1]["timeout"], eqchat.TIMEOUT)

    def test_the_model_can_be_overridden(self):
        self.interpret({"bands": []}, model="some/other-model")
        self.assertEqual(self.body["model"], "some/other-model")


class TestReplyParsing(_Interpret):
    """Everything between the model's text and the audio graph."""

    def test_a_clean_reply_comes_back_validated(self):
        out = self.interpret({
            "bands": [{"type": "highshelf", "freq": 11000, "gain": 2.0, "q": 0.7}],
            "summary": "a touch of air", "replace": False})
        self.assertEqual(len(out["bands"]), 1)
        self.assertEqual(out["summary"], "a touch of air")
        self.assertFalse(out["replace"])

    def test_a_fenced_block_is_unwrapped(self):
        """Models fence JSON even when told not to, and the fence would make
        json.loads fail on an otherwise perfect answer."""
        out = self.interpret(
            '```json\n{"bands": [{"type": "notch", "freq": 50, "q": 8}], '
            '"summary": "hum"}\n```')
        self.assertEqual(out["bands"][0]["freq"], 50.0)
        self.assertEqual(out["summary"], "hum")

    def test_a_bare_fence_is_unwrapped_too(self):
        out = self.interpret('```\n{"bands": [], "summary": "nothing to do"}\n```')
        self.assertEqual(out["summary"], "nothing to do")

    def test_the_validator_is_applied_to_whatever_came_back(self):
        """interpret() is the only path bands take into the studio, so the
        limits have to be enforced here rather than left to the caller."""
        out = self.interpret({"bands": [
            {"type": "peaking", "freq": 3000, "gain": 40, "q": 1},
            {"type": "telepathy", "freq": 3000, "gain": 3, "q": 1},
        ]})
        self.assertEqual(len(out["bands"]), 1)
        self.assertEqual(out["bands"][0]["gain"], eqchat.GAIN_LIMIT)

    def test_replace_is_coerced_to_a_real_boolean(self):
        """It decides whether the existing chain survives. A truthy string
        reaching the page as "false" would keep an EQ the user asked to clear."""
        out = self.interpret({"bands": [], "replace": "yes"})
        self.assertIs(out["replace"], True)

    def test_a_missing_replace_defaults_to_adding(self):
        """The safe direction: adding a band is undone by removing it;
        replacing has already thrown the previous chain away."""
        self.assertIs(self.interpret({"bands": []})["replace"], False)

    def test_a_runaway_summary_is_bounded(self):
        out = self.interpret({"bands": [], "summary": "x" * 5000})
        self.assertLessEqual(len(out["summary"]), 400)

    def test_prose_instead_of_json_is_a_readable_error(self):
        """The most common model failure, and it must not surface as a
        JSONDecodeError with no context."""
        with self.assertRaises(eqchat.EqChatError) as c:
            self.interpret("Sure! I'd be happy to help you brighten that up.")
        self.assertIn("did not return JSON", str(c.exception))

    def test_the_error_quotes_what_came_back(self):
        """Otherwise there is nothing to debug from: the whole failure is what
        the model said instead."""
        with self.assertRaises(eqchat.EqChatError) as c:
            self.interpret("I cannot do that")
        self.assertIn("I cannot do that", str(c.exception))

    def test_a_reply_with_no_choices_is_a_readable_error(self):
        body = _FakeResponse(json.dumps({"error": {"message": "bad model"}}).encode())
        with unittest.mock.patch("urllib.request.urlopen", return_value=body):
            with self.assertRaises(eqchat.EqChatError) as c:
                eqchat.interpret("brighter")
        self.assertIn("Unexpected response shape", str(c.exception))


class TestTransportFailures(_Interpret):
    def test_an_http_error_reports_the_code(self):
        err = urllib.error.HTTPError("https://openrouter.ai", 402, "nope", {},
                                     io.BytesIO(b"insufficient credits"))
        with unittest.mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(eqchat.EqChatError) as c:
                eqchat.interpret("brighter")
        self.assertIn("402", str(c.exception))
        self.assertIn("insufficient credits", str(c.exception))

    def test_offline_says_so(self):
        with unittest.mock.patch("urllib.request.urlopen",
                                 side_effect=urllib.error.URLError("no route")):
            with self.assertRaises(eqchat.EqChatError) as c:
                eqchat.interpret("brighter")
        self.assertIn("Could not reach OpenRouter", str(c.exception))


class TestContextExtras(unittest.TestCase):
    """_context is everything the model knows about the file. Each line either
    changes the answer or should not be there."""

    def test_loudness_is_stated_when_measured(self):
        out = eqchat._context(None, {"measures": {"integrated_lufs": -12.2,
                                                  "true_peak_dbtp": 0.54}})
        self.assertIn("-12.2 LUFS", out)
        self.assertIn("+0.54 dBTP", out)

    def test_the_band_table_is_labelled_as_relative(self):
        """Unlabelled, "air -68" reads as a verdict that the track is dull, and
        the model reliably prescribes a shelf for it."""
        out = eqchat._context(None, {"spectrum": {"bands": {"sub": -28.4,
                                                            "air": -68.7}}})
        self.assertIn("not a reference", out)
        self.assertIn("air", out)

    def test_an_analysis_with_no_measurements_adds_no_lines(self):
        self.assertEqual(eqchat._context(None, {}), eqchat._context(None, None))


class TestMain(unittest.TestCase):
    """The CLI. serve.py runs it as a subprocess and parses stdout, so even a
    failure has to print one JSON object."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        quiet = unittest.mock.patch.object(eqchat.log, "error")
        quiet.start()
        self.addCleanup(quiet.stop)

    def _run(self, argv, result=None):
        buf = io.StringIO()
        with unittest.mock.patch.object(
                eqchat, "interpret",
                return_value=result or {"bands": [], "summary": "ok",
                                        "replace": False}) as called, \
                redirect_stdout(buf):
            rc = eqchat.main(argv)
        self.called = called
        return rc, buf.getvalue()

    def test_prints_one_json_object(self):
        rc, out = self._run(["--ask", "brighter"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["summary"], "ok")

    def test_inline_bands_are_parsed_and_passed_on(self):
        """The page holds its bands in memory, not on disk; --bands-json is the
        only way they reach the model, and without them "more" means nothing."""
        self._run(["--ask", "more", "--bands-json",
                   '[{"type": "peaking", "freq": 3000, "gain": 2, "q": 1}]'])
        self.assertEqual(self.called.call_args[0][1][0]["freq"], 3000)

    def test_malformed_inline_bands_are_refused_with_json_on_stdout(self):
        """A parse failure still has to be readable by the caller that is
        parsing stdout, so it goes out as JSON rather than a traceback."""
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = eqchat.main(["--ask", "more", "--bands-json", "{not json"])
        self.assertEqual(rc, 1)
        payload = json.loads(buf.getvalue())
        self.assertIn("not valid JSON", payload["error"])
        self.assertEqual(payload["bands"], [])

    def test_bands_are_read_from_a_file_when_given(self):
        f = self.tmp / "bands.json"
        f.write_text('[{"type": "lowshelf", "freq": 90, "gain": 1.5, "q": 0.7}]')
        self._run(["--ask", "warmer", "--bands", str(f)])
        self.assertEqual(self.called.call_args[0][1][0]["type"], "lowshelf")

    def test_inline_bands_win_over_a_file(self):
        """Both can be present — the page passes --bands-json while a stale
        file sits beside the track. The live state is the correct one."""
        f = self.tmp / "bands.json"
        f.write_text('[{"type": "lowshelf", "freq": 90, "gain": 1.5, "q": 0.7}]')
        self._run(["--ask", "x", "--bands", str(f), "--bands-json",
                   '[{"type": "notch", "freq": 50, "gain": 0, "q": 8}]'])
        self.assertEqual(self.called.call_args[0][1][0]["type"], "notch")

    def test_a_missing_bands_file_is_not_an_error(self):
        """A flat EQ has no file yet, and flat is the starting state."""
        rc, _ = self._run(["--ask", "x", "--bands", str(self.tmp / "nope.json")])
        self.assertEqual(rc, 0)
        self.assertIsNone(self.called.call_args[0][1])

    def test_an_analysis_is_loaded_for_context(self):
        f = self.tmp / "analysis.json"
        f.write_text(json.dumps({"codec": {"lossy_suspected": True,
                                           "cutoff_hz": 15084.0}}))
        self._run(["--ask", "brighter", "--analysis", str(f)])
        self.assertTrue(self.called.call_args[0][2]["codec"]["lossy_suspected"])

    def test_a_missing_analysis_is_not_an_error(self):
        rc, _ = self._run(["--ask", "x", "--analysis", str(self.tmp / "nope.json")])
        self.assertEqual(rc, 0)
        self.assertIsNone(self.called.call_args[0][2])

    def test_a_model_failure_still_prints_a_parseable_object(self):
        buf = io.StringIO()
        with unittest.mock.patch.object(
                eqchat, "interpret",
                side_effect=eqchat.EqChatError("OpenRouter returned 402")), \
                redirect_stdout(buf):
            rc = eqchat.main(["--ask", "brighter"])
        self.assertEqual(rc, 1)
        payload = json.loads(buf.getvalue())
        self.assertIn("402", payload["error"])
        self.assertEqual(payload["bands"], [])


if __name__ == "__main__":
    unittest.main()
