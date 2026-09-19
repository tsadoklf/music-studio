#!/usr/bin/env python3
"""Tests for advise.py and the targets contract.

No test here reaches the network. What is worth testing is the part that is
ours: that the digest keeps the numbers a decision rests on and drops the
megabytes that it does not, that the delivery targets travel with the analysis
instead of being copied into consumers, and — the classes at the bottom — that
the request we build and the replies we accept are the ones we meant.

`urllib.request.urlopen` is patched everywhere below. A test that hit OpenRouter
would cost money, need a key, and fail on a plane.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path

from music_studio.insight import advise
from music_studio.audio import master


def _analysis(**over) -> dict:
    base = {
        "schema": "audio-analysis/v1",
        "targets": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.0,
                    "source": "master.py"},
        "metadata": {"filename": "x.wav", "duration": 240.0, "sample_rate": 48000,
                     "channels": 2, "bit_depth": 24},
        "measures": {"integrated_lufs": -12.2, "true_peak_dbtp": 0.54, "lra": 5.5,
                     "rms": -15.0, "peak": -0.06, "crest_factor": 14.97,
                     "true_peak_is_estimate": False},
        "loudness": {"max_momentary": -7.9, "max_short_term": -8.8,
                     # the series are large and must not reach the prompt
                     "momentary": {"lufs": list(range(2000))}},
        "codec": {"cutoff_hz": 15084.0, "confidence": 0.871,
                  "verdict": "brick wall at 15.1 kHz"},
        "clipping": {"clipped_samples": 0, "runs": 0},
        "stereo": {"correlation": 0.65, "width": 0.46, "balance_db": -0.11},
        "spectrum": {"bands": {"sub": -28.4, "air": -68.7}},
        "spectrogram": {"db": list(range(50000)), "shape": [256, 1499]},
        "envelopes": {"channels": [{"peak": list(range(9000))}]},
    }
    base.update(over)
    return base


class TestDigest(unittest.TestCase):
    def test_keeps_the_decisive_numbers(self):
        d = advise.digest(_analysis())
        for key in ("integrated_lufs", "true_peak_dbtp", "codec_cutoff_hz",
                    "target_lufs", "target_true_peak_dbtp", "lra",
                    "clipped_samples", "stereo_correlation"):
            self.assertIn(key, d, f"digest dropped {key}")
        self.assertEqual(d["true_peak_dbtp"], 0.54)
        self.assertEqual(d["codec_cutoff_hz"], 15084.0)

    def test_drops_the_bulk(self):
        """The spectrogram and envelopes are for eyes, not for a prompt."""
        text = json.dumps(advise.digest(_analysis()))
        self.assertNotIn("spectrogram", text)
        self.assertNotIn("envelopes", text)
        self.assertLess(len(text), 4000, "digest is too big to be a prompt")

    def test_survives_a_sparse_analysis(self):
        """A partial analysis must not raise; missing numbers come back None."""
        d = advise.digest({"schema": "audio-analysis/v1"})
        self.assertIsNone(d["integrated_lufs"])
        self.assertIsNone(d["codec_cutoff_hz"])

    def test_carries_targets_into_the_prompt(self):
        d = advise.digest(_analysis())
        self.assertEqual(d["target_lufs"], -14.0)
        self.assertEqual(d["target_true_peak_dbtp"], -1.0)


class TestSystemPrompt(unittest.TestCase):
    """The prompt encodes findings that were measured; a silent edit that drops
    one of them would quietly restore a wrong answer."""

    def test_warns_against_eq_as_a_codec_fix(self):
        self.assertIn("cannot be restored by EQ", advise.SYSTEM)

    def test_states_that_eq_runs_before_loudness(self):
        self.assertIn("before the loudness stage", advise.SYSTEM)

    def test_guards_the_band_table_misreading(self):
        self.assertIn("absolute tonal judgement", advise.SYSTEM)

    def test_recommends_rather_than_runs(self):
        self.assertIn("music master", advise.SYSTEM)


class TestTargetsContract(unittest.TestCase):
    """analyze.py must publish master.py's real numbers, not a second copy."""

    def test_targets_come_from_master(self):
        from music_studio.audio import analyze
        t = analyze._delivery_targets()
        self.assertEqual(t["integrated_lufs"], master.DEFAULT_LUFS)
        self.assertEqual(t["true_peak_dbtp"], master.DEFAULT_TP)
        self.assertEqual(t["source"], "master.py")

    def test_targets_track_a_changed_default(self):
        """Change master.py's default and the analysis must follow it."""
        from music_studio.audio import analyze
        original = master.DEFAULT_LUFS
        try:
            master.DEFAULT_LUFS = -16.0
            self.assertEqual(analyze._delivery_targets()["integrated_lufs"], -16.0)
        finally:
            master.DEFAULT_LUFS = original


class TestKeyHandling(unittest.TestCase):
    def test_missing_key_is_a_readable_error(self):
        """With no key anywhere, the failure names the variable and the file."""
        original = advise._load_env_key
        advise._load_env_key = lambda: None
        try:
            with self.assertRaises(advise.AdviseError) as ctx:
                advise.advise(_analysis())
        finally:
            advise._load_env_key = original
        message = str(ctx.exception)
        self.assertIn("OPENROUTER_API_KEY", message)
        self.assertIn(".env", message)


class TestKeyLookup(unittest.TestCase):
    """Where the key is read FROM.

    A lookup that resolves outside the project is the failure mode here: it
    once did, nothing noticed, and every AI feature went keyless in silence
    because a missing key is a warning rather than an error.

    The other tests in this file all stub `_load_env_key` out, so none of them
    exercises the lookup. These do.
    """

    def setUp(self):
        self._saved = {k: os.environ.get(k)
                       for k in ("OPENROUTER_API_KEY", "MUSIC_STUDIO_ENV")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_env_file_lives_inside_the_project(self):
        """The regression itself: no path may climb out of the project.

        The .env is the USER's configuration, so it sits at the project root
        beside pyproject.toml — not inside the package, and certainly not in
        a sibling checkout, which is what broke it the first time. See
        paths.project_root() for why those are different questions.
        """
        from music_studio import paths
        self.assertEqual(advise.env_path().parent, paths.project_root())

    def test_env_file_is_dot_env(self):
        self.assertEqual(advise.env_path().name, ".env")

    def test_override_redirects_the_lookup(self):
        os.environ["MUSIC_STUDIO_ENV"] = "/tmp/somewhere/else.env"
        self.assertEqual(advise.env_path(), Path("/tmp/somewhere/else.env"))

    def test_environment_beats_the_file(self):
        """An exported key must win, so CI never needs a file on disk."""
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env"
            env.write_text("OPENROUTER_API_KEY=from-the-file\n")
            os.environ["MUSIC_STUDIO_ENV"] = str(env)
            os.environ["OPENROUTER_API_KEY"] = "from-the-environment"
            self.assertEqual(advise._load_env_key(), "from-the-environment")

    def test_reads_the_file_when_the_environment_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env"
            env.write_text("# a comment\nOTHER=1\nOPENROUTER_API_KEY=sk-or-v1-xyz\n")
            os.environ["MUSIC_STUDIO_ENV"] = str(env)
            self.assertEqual(advise._load_env_key(), "sk-or-v1-xyz")

    def test_quotes_are_stripped(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env"
            env.write_text('OPENROUTER_API_KEY="sk-or-v1-quoted"\n')
            os.environ["MUSIC_STUDIO_ENV"] = str(env)
            self.assertEqual(advise._load_env_key(), "sk-or-v1-quoted")

    def test_missing_file_is_not_an_error(self):
        os.environ["MUSIC_STUDIO_ENV"] = "/nonexistent/nowhere/.env"
        self.assertIsNone(advise._load_env_key())

    def test_a_env_file_without_the_key_reads_as_no_key(self):
        """A .env holding only the Etsy credentials is a real state. Returning
        the file's first line, or raising, would both be worse than None — the
        caller's job is to say "no OPENROUTER_API_KEY", and it can only do that
        if it is told none was found."""
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env"
            env.write_text("SOMETHING_ELSE=1\n# OPENROUTER_API_KEY=commented-out\n")
            os.environ["MUSIC_STUDIO_ENV"] = str(env)
            self.assertIsNone(advise._load_env_key())


# --------------------------------------------------------------------------
# the call itself
# --------------------------------------------------------------------------

class _FakeResponse(io.BytesIO):
    """What urlopen returns: a context manager over bytes."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def _reply(content: str) -> _FakeResponse:
    return _FakeResponse(json.dumps(
        {"choices": [{"message": {"content": content}}]}).encode("utf-8"))


def _http_error(code: int, body: bytes = b"over quota") -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://openrouter.ai", code, "nope", {},
                                  io.BytesIO(body))


class _Called(unittest.TestCase):
    """Base for tests that inspect the request advise() builds."""

    def setUp(self):
        key = unittest.mock.patch.object(advise, "_load_env_key",
                                         return_value="sk-test")
        key.start()
        self.addCleanup(key.stop)

    def call(self, analysis, question=None, reply="looks fine", **kw):
        """Run advise() against a canned reply and keep the Request object."""
        with unittest.mock.patch("urllib.request.urlopen",
                                 return_value=_reply(reply)) as opened:
            answer = advise.advise(analysis, question, **kw)
        self.request = opened.call_args[0][0]
        self.body = json.loads(self.request.data.decode("utf-8"))
        return answer


class TestRequestShape(_Called):
    """What actually goes on the wire."""

    def test_the_answer_is_returned_stripped(self):
        self.assertEqual(self.call(_analysis(), reply="  fine  \n"), "fine")

    def test_the_key_travels_as_a_bearer_header(self):
        self.call(_analysis())
        self.assertEqual(self.request.headers["Authorization"], "Bearer sk-test")

    def test_the_key_is_never_put_in_the_body(self):
        """A key in the JSON would be logged by every proxy in between and
        echoed back in the 'unexpected response shape' error."""
        self.call(_analysis())
        self.assertNotIn("sk-test", self.request.data.decode("utf-8"))

    def test_it_posts_to_openrouter_over_https(self):
        self.call(_analysis())
        self.assertEqual(self.request.full_url, advise.OPENROUTER_CHAT_URL)
        self.assertTrue(self.request.full_url.startswith("https://"))

    def test_the_system_prompt_is_sent_as_the_system_role(self):
        """Folding it into the user turn loses the priority a system message
        carries, and the rules in it are the reason the answers are usable."""
        self.call(_analysis())
        system = self.body["messages"][0]
        self.assertEqual(system["role"], "system")
        self.assertEqual(system["content"], advise.SYSTEM)

    def test_the_temperature_is_low(self):
        """This is a report reading, not a brainstorm. The same measurements
        should produce the same advice twice."""
        self.call(_analysis())
        self.assertLessEqual(self.body["temperature"], 0.3)

    def test_the_model_can_be_overridden(self):
        self.call(_analysis(), model="some/other-model")
        self.assertEqual(self.body["model"], "some/other-model")

    def test_an_explicit_key_beats_the_lookup(self):
        """So a caller holding a key does not need it written to disk first."""
        with unittest.mock.patch("urllib.request.urlopen",
                                 return_value=_reply("ok")) as opened:
            advise.advise(_analysis(), api_key="sk-passed-in")
        self.assertEqual(opened.call_args[0][0].headers["Authorization"],
                         "Bearer sk-passed-in")

    def test_a_timeout_is_set(self):
        """Without one, a stalled connection hangs the studio panel forever
        with no way to cancel from the page."""
        with unittest.mock.patch("urllib.request.urlopen",
                                 return_value=_reply("ok")) as opened:
            advise.advise(_analysis())
        self.assertEqual(opened.call_args[1]["timeout"], advise.TIMEOUT)


class TestUserMessage(_Called):
    """The user turn is where the measurements live. The system prompt tells
    the model to quote numbers; this is where the numbers have to be."""

    def test_the_measurements_are_sent_as_json(self):
        self.call(_analysis())
        user = self.body["messages"][1]["content"]
        self.assertIn('"integrated_lufs": -12.2', user)
        self.assertIn('"true_peak_dbtp": 0.54', user)

    def test_the_bulk_never_reaches_the_prompt(self):
        """The spectrogram is most of a 2.5 MB analysis and none of the
        argument. Sending it costs tokens and buys nothing."""
        self.call(_analysis())
        user = self.body["messages"][1]["content"]
        self.assertNotIn("spectrogram", user)
        self.assertLess(len(user), 4000, "the digest let the bulk through")

    def test_the_question_is_carried_verbatim(self):
        self.call(_analysis(), "why does this sound dull?")
        self.assertIn("why does this sound dull?", self.body["messages"][1]["content"])

    def test_a_default_question_is_asked_when_none_is_given(self):
        self.call(_analysis())
        self.assertIn("Question:", self.body["messages"][1]["content"])

    def test_no_analysis_says_so_instead_of_sending_nulls(self):
        """The regression this branch exists for: saying Hi with nothing
        loaded used to send a block of nulls to a model instructed to quote
        numbers, which got either a refusal or an invention."""
        self.call({}, "hi")
        user = self.body["messages"][1]["content"]
        self.assertIn("No file is loaded", user)
        self.assertNotIn("null", user)

    def test_an_analysis_with_no_measurements_counts_as_none(self):
        """A half-written analysis.json — schema present, nothing measured —
        is the same situation as no file at all."""
        self.call({"schema": "audio-analysis/v1", "spectrum": {}}, "hi")
        self.assertIn("No file is loaded", self.body["messages"][1]["content"])

    def test_metadata_alone_is_enough_to_count_as_loaded(self):
        """A file that failed measurement still has a name and a duration, and
        a question about it is about that file, not a general one."""
        self.call({"metadata": {"filename": "x.wav", "duration": 12.0}}, "what is this?")
        self.assertNotIn("No file is loaded", self.body["messages"][1]["content"])


class TestFailures(unittest.TestCase):
    """Every one of these reaches a person as a line in a panel, so it has to
    say what went wrong rather than raise a urllib traceback."""

    def setUp(self):
        key = unittest.mock.patch.object(advise, "_load_env_key",
                                         return_value="sk-test")
        key.start()
        self.addCleanup(key.stop)

    def test_an_http_error_reports_the_code_and_the_body(self):
        """401 and 429 need different reactions from a person, and the body is
        where OpenRouter says which."""
        with unittest.mock.patch("urllib.request.urlopen",
                                 side_effect=_http_error(429, b"rate limited")):
            with self.assertRaises(advise.AdviseError) as c:
                advise.advise(_analysis())
        self.assertIn("429", str(c.exception))
        self.assertIn("rate limited", str(c.exception))

    def test_a_giant_error_body_is_truncated(self):
        """Some gateways return an HTML page. Putting all of it in a log line
        buries everything else on screen."""
        with unittest.mock.patch("urllib.request.urlopen",
                                 side_effect=_http_error(500, b"x" * 10000)):
            with self.assertRaises(advise.AdviseError) as c:
                advise.advise(_analysis())
        self.assertLess(len(str(c.exception)), 500)

    def test_an_unreachable_host_says_so(self):
        """Offline is the most common failure by far and must not look like a
        bug in the tool."""
        with unittest.mock.patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError("nodename nor servname provided")):
            with self.assertRaises(advise.AdviseError) as c:
                advise.advise(_analysis())
        self.assertIn("Could not reach OpenRouter", str(c.exception))

    def test_a_reply_with_no_choices_is_a_readable_error(self):
        """OpenRouter returns {"error": ...} with a 200 when a model is
        unavailable, so this is a real shape, not a hypothetical."""
        body = _FakeResponse(json.dumps({"error": {"message": "no such model"}}).encode())
        with unittest.mock.patch("urllib.request.urlopen", return_value=body):
            with self.assertRaises(advise.AdviseError) as c:
                advise.advise(_analysis())
        self.assertIn("Unexpected response shape", str(c.exception))

    def test_an_empty_choices_list_is_a_readable_error(self):
        body = _FakeResponse(json.dumps({"choices": []}).encode())
        with unittest.mock.patch("urllib.request.urlopen", return_value=body):
            with self.assertRaises(advise.AdviseError):
                advise.advise(_analysis())


class TestMain(unittest.TestCase):
    """The CLI. serve.py runs this as a subprocess and reads stdout, so what
    lands on stdout is an interface, not a convenience."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        quiet = unittest.mock.patch.object(advise.log, "error")
        quiet.start()
        self.addCleanup(quiet.stop)

    def _analysis_file(self, data=None) -> Path:
        p = self.tmp / "analysis.json"
        p.write_text(json.dumps(data if data is not None else _analysis()))
        return p

    def _run(self, argv, answer="looks fine"):
        buf = io.StringIO()
        with unittest.mock.patch.object(advise, "advise", return_value=answer), \
                redirect_stdout(buf):
            rc = advise.main(argv)
        return rc, buf.getvalue()

    def test_prints_the_answer(self):
        rc, out = self._run(["--analysis", str(self._analysis_file())])
        self.assertEqual(rc, 0)
        self.assertIn("looks fine", out)

    def test_json_mode_emits_one_parseable_object(self):
        """The studio panel parses this. A stray log line on stdout would make
        it unparseable, which is why logging goes to stderr."""
        rc, out = self._run(["--analysis", str(self._analysis_file()), "--json"])
        payload = json.loads(out)
        self.assertEqual(payload["answer"], "looks fine")
        self.assertEqual(payload["facts"]["integrated_lufs"], -12.2)

    def test_facts_only_never_calls_a_model(self):
        """The panel uses it to fill its numbers without spending a token."""
        buf = io.StringIO()
        with unittest.mock.patch.object(advise, "advise") as called, \
                redirect_stdout(buf):
            rc = advise.main(["--analysis", str(self._analysis_file()),
                              "--facts-only"])
        self.assertEqual(rc, 0)
        called.assert_not_called()
        self.assertEqual(json.loads(buf.getvalue())["integrated_lufs"], -12.2)

    def test_no_analysis_is_allowed_and_asks_anyway(self):
        """"Say Hi, get a usage error" is the behaviour this prevents."""
        buf = io.StringIO()
        with unittest.mock.patch.object(advise, "advise",
                                        return_value="hello") as called, \
                redirect_stdout(buf):
            rc = advise.main(["--ask", "hi"])
        self.assertEqual(rc, 0)
        self.assertEqual(called.call_args[0][0], {})
        self.assertIn("hello", buf.getvalue())

    def test_a_named_analysis_that_is_missing_is_an_error(self):
        """Different from giving none: naming a file that is not there is a
        typo, and silently answering from general knowledge would hide it."""
        rc, _ = self._run(["--analysis", str(self.tmp / "nope.json")])
        self.assertEqual(rc, 1)

    def test_the_question_reaches_advise(self):
        with unittest.mock.patch.object(advise, "advise",
                                        return_value="x") as called, \
                redirect_stdout(io.StringIO()):
            advise.main(["--analysis", str(self._analysis_file()),
                         "--ask", "is the low end right?"])
        self.assertEqual(called.call_args[0][1], "is the low end right?")

    def test_a_model_failure_is_an_exit_code_not_a_traceback(self):
        with unittest.mock.patch.object(
                advise, "advise", side_effect=advise.AdviseError("no key")), \
                redirect_stdout(io.StringIO()):
            rc = advise.main(["--analysis", str(self._analysis_file())])
        self.assertEqual(rc, 1)

    def test_ctrl_c_is_130(self):
        with unittest.mock.patch.object(advise, "advise",
                                        side_effect=KeyboardInterrupt), \
                redirect_stdout(io.StringIO()):
            rc = advise.main(["--analysis", str(self._analysis_file())])
        self.assertEqual(rc, 130)


if __name__ == "__main__":
    unittest.main()
