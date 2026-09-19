#!/usr/bin/env python3
"""Tests for studio_run.py — the one sequence three callers share.

`music studio`, the studio page's button and the server's command table all
reach this module. Before it existed the CLI held its own copy of the order,
and two copies of an ordering are two chances to get it wrong. So what is
tested here is the contract the other three rely on:

    run()   writes every artefact, returns the summary, raises on failure
    main()  prints exactly one JSON object on stdout, success or failure alike

The stdout rule is not cosmetic. `serve.http` parses that line, so a stray
`print()` anywhere in the call chain breaks the server with no error message
anyone would connect to the cause.

Nothing here touches ffmpeg, the network or a real audio file: `analyze` and
`advise` are patched at the module boundary, which is also what makes the
`--no-advice` and advice-failure cases assertable at all.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from music_studio.audio.analyze import AnalyzeError
from music_studio.insight import studio_run


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

def analysis(**over) -> dict:
    """An analysis shaped like the real one, with every value clean.

    A clean file is the useful default: it makes any `bad` verdict in a test
    come from what that test changed rather than from the fixture.
    """
    base = {
        "targets": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.0},
        "metadata": {"filename": "take.wav", "duration": 180.0,
                     "sample_rate": 48000, "channels": 2, "bit_depth": 24},
        "measures": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.5,
                     "lra": 7.0, "crest_factor": 15.0, "peak": -2.0},
        "codec": {"cutoff_hz": 20000.0, "confidence": 0.0,
                  "lossy_suspected": False},
        "clipping": {"clipped_samples": 0, "runs": 0,
                     "clipping_suspected": False},
        "stereo": {"correlation": 0.6, "width": 0.4, "balance_db": 0.0},
        "spectrum": {"bands": {"sub": -28.0, "air": -68.0}},
    }
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = {**base[key], **value}
        else:
            base[key] = value
    return base


class _Run(unittest.TestCase):
    """A tempdir, a stand-in audio file, and analyze/advise held offline."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        # run() only checks is_file() before handing the path to analyze(),
        # which is patched — so the bytes never matter.
        self.src = self.tmp / "take.wav"
        self.src.write_bytes(b"RIFF....WAVEfmt ")
        self.data = analysis()

        patcher = patch("music_studio.audio.analyze.analyze",
                        return_value=self.data)
        self.analyze = patcher.start()
        self.addCleanup(patcher.stop)

        patcher = patch("music_studio.insight.advise.advise",
                        return_value="Ship it.")
        self.advise = patcher.start()
        self.addCleanup(patcher.stop)


# --------------------------------------------------------------------------
# run()
# --------------------------------------------------------------------------

class TestArtefacts(_Run):
    def test_writes_all_four_files(self):
        """The module's docstring promises four files. A caller that gets three
        and a summary claiming four has no way to notice."""
        studio_run.run(self.src, self.tmp)
        for name in ("analysis.json", "timeline.json", "REPORT.md",
                     "report.ai.md"):
            with self.subTest(file=name):
                self.assertTrue((self.tmp / name).is_file(), name)

    def test_analysis_json_holds_the_analysis(self):
        """Not just that the file exists — that it is the measurement data and
        not, say, the summary that wraps it."""
        studio_run.run(self.src, self.tmp)
        written = json.loads((self.tmp / "analysis.json").read_text("utf-8"))
        self.assertEqual(written["measures"]["integrated_lufs"], -14.0)
        self.assertEqual(written["metadata"]["filename"], "take.wav")

    def test_out_dir_is_created_when_absent(self):
        """The page passes a directory that may not exist yet; without the
        mkdir this is a FileNotFoundError deep inside a write."""
        dest = self.tmp / "nested" / "out"
        self.assertFalse(dest.exists())
        studio_run.run(self.src, dest)
        self.assertTrue((dest / "analysis.json").is_file())

    def test_default_out_dir_is_beside_the_audio(self):
        audio_dir = self.tmp / "masters"
        audio_dir.mkdir()
        src = audio_dir / "master.wav"
        src.write_bytes(b"RIFF")
        studio_run.run(src)
        self.assertTrue((audio_dir / "analysis.json").is_file())
        self.assertFalse((self.tmp / "analysis.json").exists())


class TestSummary(_Run):
    def test_returns_the_documented_keys(self):
        """`run()` returning the summary is the whole reason it is separate
        from `main()` — a caller must not have to parse stdout for it."""
        result = studio_run.run(self.src, self.tmp)
        self.assertEqual(
            set(result),
            {"ok", "headline", "verdicts", "timeline", "advice", "files"})
        self.assertIs(result["ok"], True)

    def test_every_file_path_in_the_summary_exists(self):
        """A path in the summary is a promise to the page, which links to it."""
        result = studio_run.run(self.src, self.tmp)
        self.assertEqual(set(result["files"]),
                         {"analysis", "human", "ai", "timeline"})
        for key, value in result["files"].items():
            with self.subTest(file=key):
                self.assertTrue(Path(value).is_file(), value)

    def test_headline_reflects_the_verdicts(self):
        """A clean file must not be reported as needing work; the headline is
        the one line a person reads."""
        result = studio_run.run(self.src, self.tmp)
        self.assertEqual(result["headline"], "Ready to upload")
        self.assertTrue(all(v["severity"] == "ok" for v in result["verdicts"]))

    def test_a_bad_file_is_reported_as_not_ready(self):
        """The counterpart: the same call on a lossy file must say so, or the
        headline is decoration rather than a verdict."""
        self.analyze.return_value = analysis(
            codec={"cutoff_hz": 15100.0, "confidence": 0.9,
                   "lossy_suspected": True})
        result = studio_run.run(self.src, self.tmp)
        self.assertTrue(result["headline"].startswith("Not ready"),
                        result["headline"])
        self.assertIn("bad", [v["severity"] for v in result["verdicts"]])

    def test_advice_is_carried_into_the_summary(self):
        result = studio_run.run(self.src, self.tmp)
        self.assertEqual(result["advice"], "Ship it.")
        self.advise.assert_called_once()


class TestAdviceIsOptional(_Run):
    def test_no_advice_makes_no_model_call(self):
        """`advice=False` is what makes this usable with no API key. Testing
        the returned None is not enough: the call could still have been made
        and its result discarded, which costs money and needs a network."""
        result = studio_run.run(self.src, self.tmp, advice=False)
        self.advise.assert_not_called()
        self.assertIsNone(result["advice"])
        self.assertTrue((self.tmp / "analysis.json").is_file())

    def test_a_failing_advice_call_does_not_lose_the_analysis(self):
        """The documented guarantee: advice is a bonus, and the analysis is
        the part that cost real time to compute. A missing key must not throw
        away a measurement that already succeeded."""
        from music_studio.insight.advise import AdviseError

        self.advise.side_effect = AdviseError("No OPENROUTER_API_KEY.")
        result = studio_run.run(self.src, self.tmp)

        self.assertIs(result["ok"], True)
        self.assertIsNone(result["advice"])
        self.assertTrue((self.tmp / "analysis.json").is_file())
        self.assertTrue((self.tmp / "REPORT.md").is_file())


class TestTimelineIsOptional(_Run):
    def test_timeline_is_built_by_default(self):
        studio_run.run(self.src, self.tmp)
        written = json.loads((self.tmp / "timeline.json").read_text("utf-8"))
        self.assertIn("timeline", written)

    def test_timeline_false_writes_no_timeline_file(self):
        """The flag has to actually skip the work, not just drop the result:
        `build()` is the other step that can call a model."""
        with patch("music_studio.insight.timeline.build") as build:
            result = studio_run.run(self.src, self.tmp, timeline=False)
        build.assert_not_called()
        self.assertEqual(result["timeline"], [])
        self.assertFalse((self.tmp / "timeline.json").exists())


class TestFailure(_Run):
    def test_a_missing_file_raises(self):
        """It raises rather than returning {"ok": False}. A boolean a caller
        forgets to check is how a failure becomes a blank report."""
        missing = self.tmp / "nope.wav"
        with self.assertRaises(AnalyzeError) as caught:
            studio_run.run(missing, self.tmp)
        self.assertIn(str(missing), str(caught.exception))
        self.analyze.assert_not_called()

    def test_a_failing_analysis_propagates(self):
        """An unreadable file must stop the run, not produce a half-written
        set of artefacts describing nothing."""
        self.analyze.side_effect = AnalyzeError("Could not read take.wav")
        with self.assertRaises(AnalyzeError):
            studio_run.run(self.src, self.tmp)
        self.assertFalse((self.tmp / "analysis.json").exists())


# --------------------------------------------------------------------------
# main()
# --------------------------------------------------------------------------

class TestMain(_Run):
    """Stdout is a protocol channel — `serve.http` parses it."""

    def _main(self, argv) -> tuple[int, str]:
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = studio_run.main(argv)
        return code, buf.getvalue()

    def test_success_returns_zero_and_one_json_object(self):
        code, out = self._main(["--in", str(self.src),
                                "--out-dir", str(self.tmp)])
        self.assertEqual(code, 0)
        payload = json.loads(out)          # the whole of stdout, not a slice
        self.assertIs(payload["ok"], True)
        self.assertEqual(out.strip().count("\n"), 0,
                         "more than one line reached stdout")

    def test_failure_returns_one_and_still_prints_json(self):
        """The server parses stdout on failure too. Printing a bare traceback
        there — or nothing — leaves it with an unexplained parse error."""
        code, out = self._main(["--in", str(self.tmp / "nope.wav")])
        self.assertEqual(code, 1)
        payload = json.loads(out)
        self.assertIs(payload["ok"], False)
        self.assertIn("nope.wav", payload["error"])
        self.assertEqual(out.strip().count("\n"), 0,
                         "more than one line reached stdout")

    def test_the_summary_on_stdout_names_the_files_written(self):
        """What the caller reads instead of re-walking the directory."""
        code, out = self._main(["--in", str(self.src),
                                "--out-dir", str(self.tmp)])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(Path(payload["files"]["analysis"]).is_file())
        self.assertEqual(Path(payload["files"]["human"]).name, "REPORT.md")

    def test_no_advice_flag_reaches_run(self):
        """The flag exists so the command line works with no key; if argparse
        and run() disagree about its name it silently calls the model."""
        code, out = self._main(["--in", str(self.src),
                                "--out-dir", str(self.tmp), "--no-advice"])
        self.assertEqual(code, 0)
        self.advise.assert_not_called()
        self.assertIsNone(json.loads(out)["advice"])

    def test_verbose_is_accepted(self):
        """-v goes to logging, which is stderr; stdout must stay one object."""
        code, out = self._main(["--in", str(self.src),
                                "--out-dir", str(self.tmp), "-v"])
        self.assertEqual(code, 0)
        json.loads(out)

    def test_out_dir_defaults_to_beside_the_audio(self):
        code, out = self._main(["--in", str(self.src)])
        self.assertEqual(code, 0)
        self.assertEqual(Path(json.loads(out)["files"]["analysis"]).parent,
                         self.src.parent)


if __name__ == "__main__":
    unittest.main()
