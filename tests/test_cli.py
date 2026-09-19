#!/usr/bin/env python3
"""Tests for cli.py — the thirteen commands, through real argument parsing.

Everything here goes through Typer's `CliRunner`, not by calling the command
functions directly. The difference matters: most of what can break in a CLI is
the wiring — an option whose name drifts from the parameter it feeds, a float
that arrives as a string, a default that stops matching the help text. Calling
`scope(track=..., audio=...)` in Python exercises none of that.

Every worker the commands call is patched at its own module boundary, so no
test starts ffmpeg, reaches OpenRouter, or reads a real audio file. That is
also what lets the assertions be about delegation: `master --lufs -16` is
correct when `master_loudnorm` was called with `lufs=-16.0`, and there is no
other way to see that without either mocking or a render.

The failure paths get as much attention as the successes. `_fail()` is how
every command reports a problem, and a command that exits 0 with a blank
report is the failure mode this suite exists to catch.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import typer
from typer.testing import CliRunner

from music_studio import cli
from music_studio.cli import app

runner = CliRunner()


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

def analysis(**over) -> dict:
    """A clean analysis. Anything a test wants judged badly it says so."""
    base = {
        "targets": {"integrated_lufs": -14.0, "true_peak_dbtp": -1.0},
        "metadata": {"filename": "master.wav", "duration": 180.0,
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


class _Tmp(unittest.TestCase):
    """A tempdir per test. Nothing is written outside it."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def track(self, *, master=True, take=True, art=False, song=False) -> Path:
        """A track directory with as much of the usual furniture as asked for."""
        tdir = self.tmp / "tracks" / "ida-y-vuelta"
        (tdir / "masters" / "takes").mkdir(parents=True)
        if take:
            (tdir / "masters" / "takes" / "take-01.wav").write_bytes(b"RIFF")
        if master:
            (tdir / "masters" / "master.wav").write_bytes(b"RIFF")
        if art:
            (tdir / "artwork").mkdir()
            (tdir / "artwork" / "cover.png").write_bytes(b"\x89PNG")
        if song:
            (tdir / "song.md").write_text("---\nslug: ida-y-vuelta\n---\n",
                                          encoding="utf-8")
        return tdir


# --------------------------------------------------------------------------
# _audio_for — the shared resolution helper
# --------------------------------------------------------------------------

class TestAudioFor(_Tmp):
    """`studio` and `scope` both accept three kinds of target.

    They each used to work it out inline, with wording that had already
    drifted apart. These cases pin the three shapes and the failure, so a
    future divergence shows up here rather than as two commands disagreeing
    about the same path.
    """

    def test_an_audio_file_is_itself(self):
        f = self.tmp / "take.wav"
        f.write_bytes(b"RIFF")
        self.assertEqual(cli._audio_for(f, None), f)

    def test_a_track_directory_resolves_to_its_master(self):
        tdir = self.track()
        self.assertEqual(cli._audio_for(tdir, None),
                         tdir / "masters" / "master.wav")

    def test_a_song_md_resolves_to_the_master_beside_it(self):
        """A .md is metadata, never the audio — the suffix check is what stops
        the analyser being handed a text file."""
        tdir = self.track(song=True)
        self.assertEqual(cli._audio_for(tdir / "song.md", None),
                         tdir / "masters" / "master.wav")

    def test_an_explicit_audio_override_wins_over_the_default(self):
        tdir = self.track()
        other = self.tmp / "alternate.wav"
        other.write_bytes(b"RIFF")
        self.assertEqual(cli._audio_for(tdir, other), other)

    def test_nothing_resolvable_exits_with_a_readable_message(self):
        """The common mistake — pointing at a track that has not been mastered
        yet. It must name the path it looked at and the way out."""
        empty = self.tmp / "empty"
        empty.mkdir()
        result = runner.invoke(app, ["scope", str(empty)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("No audio at", result.output)
        self.assertIn("--audio", result.output)

    def test_a_json_target_is_not_mistaken_for_audio(self):
        """`.json` joins `.md` in the excluded suffixes: an analysis.json
        passed by mistake must fail, not be fed to the analyser."""
        j = self.tmp / "analysis.json"
        j.write_text("{}", encoding="utf-8")
        with self.assertRaises(typer.Exit):
            cli._audio_for(j, None)


# --------------------------------------------------------------------------
# _print_verdicts — severity chooses the colour, once
# --------------------------------------------------------------------------

class TestPrintVerdicts(unittest.TestCase):
    """Colour selection lives here rather than in each command that shows a
    verdict block. These cases pin that the worst severity present drives the
    headline, which is the rule that gets lost when it is reimplemented."""

    def _render(self, severities, line="Headline"):
        vs = [{"id": f"v{i}", "severity": s, "title": f"finding {i}"}
              for i, s in enumerate(severities)]
        with patch("typer.secho") as secho, patch("typer.echo"):
            cli._print_verdicts(vs, line)
        return secho.call_args_list

    def test_one_bad_finding_makes_the_headline_red(self):
        calls = self._render(["ok", "warn", "bad"])
        self.assertEqual(calls[0].kwargs["fg"], "red")

    def test_warnings_without_a_bad_make_it_yellow(self):
        calls = self._render(["ok", "warn"])
        self.assertEqual(calls[0].kwargs["fg"], "yellow")

    def test_all_clear_is_green(self):
        calls = self._render(["ok", "ok"])
        self.assertEqual(calls[0].kwargs["fg"], "green")

    def test_each_finding_gets_its_own_mark_and_colour(self):
        """The headline colour is the worst; each line keeps its own, or a
        green 'ok' in a failing report reads as part of the failure."""
        calls = self._render(["bad", "warn", "ok"])
        marks = [c.args[0].strip().split()[0] for c in calls[1:]]
        self.assertEqual(marks, ["✗", "!", "✓"])
        self.assertEqual([c.kwargs["fg"] for c in calls[1:]],
                         ["red", "yellow", "green"])


# --------------------------------------------------------------------------
# scope
# --------------------------------------------------------------------------

class TestScope(_Tmp):
    def setUp(self):
        super().setUp()
        self.data = analysis()
        patcher = patch("music_studio.audio.analyze.analyze",
                        return_value=self.data)
        self.analyze = patcher.start()
        self.addCleanup(patcher.stop)

    def test_writes_the_json_the_page_reads(self):
        tdir = self.track()
        result = runner.invoke(app, ["scope", str(tdir)])
        self.assertEqual(result.exit_code, 0, result.output)
        written = json.loads((tdir / "analysis.json").read_text("utf-8"))
        self.assertEqual(written["measures"]["integrated_lufs"], -14.0)

    def test_analyses_the_master_of_the_directory_it_was_given(self):
        tdir = self.track()
        runner.invoke(app, ["scope", str(tdir)])
        self.analyze.assert_called_once_with(tdir / "masters" / "master.wav")

    def test_out_redirects_the_json(self):
        tdir = self.track()
        dst = self.tmp / "elsewhere" / "report.json"
        result = runner.invoke(app, ["scope", str(tdir), "--out", str(dst)])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertTrue(dst.is_file())          # the parent is created for us
        self.assertFalse((tdir / "analysis.json").exists())

    def test_prints_the_headline_numbers(self):
        """The terminal has to be useful without opening the page."""
        tdir = self.track()
        result = runner.invoke(app, ["scope", str(tdir)])
        self.assertIn("-14.0 LUFS", result.output)
        self.assertIn("-1.5 dBTP", result.output)
        self.assertIn("LRA 7.0", result.output)

    def test_a_peak_over_the_ceiling_is_called_out(self):
        """+0.2 dBTP will distort on lossy playback, and the number alone does
        not say so to anyone who has not memorised the ceiling."""
        self.analyze.return_value = analysis(
            measures={"true_peak_dbtp": 0.2})
        result = runner.invoke(app, ["scope", str(self.track())])
        self.assertIn("above the", result.output)
        self.assertIn("-1.0 ceiling", result.output)

    def test_a_lossy_source_is_called_out(self):
        self.analyze.return_value = analysis(
            codec={"cutoff_hz": 15100.0, "lossy_suspected": True,
                   "verdict": "Lossy source — energy stops at 15.1 kHz"})
        result = runner.invoke(app, ["scope", str(self.track())])
        self.assertIn("15.1 kHz", result.output)

    def test_clipping_is_called_out_with_its_counts(self):
        self.analyze.return_value = analysis(
            clipping={"clipped_samples": 412, "runs": 9,
                      "clipping_suspected": True})
        result = runner.invoke(app, ["scope", str(self.track())])
        self.assertIn("412 clipped samples", result.output)
        self.assertIn("9 runs", result.output)

    def test_advise_flag_asks_and_shows_the_answer(self):
        tdir = self.track()
        with patch("music_studio.insight.advise.advise",
                   return_value="Lower the ceiling.") as advise:
            result = runner.invoke(app, ["scope", str(tdir), "--advise"])
        self.assertEqual(result.exit_code, 0, result.output)
        advise.assert_called_once()
        self.assertEqual(advise.call_args.args[0], self.data)
        self.assertIn("Lower the ceiling.", result.output)

    def test_no_advise_flag_makes_no_model_call(self):
        with patch("music_studio.insight.advise.advise") as advise:
            runner.invoke(app, ["scope", str(self.track())])
        advise.assert_not_called()

    def test_failed_advice_is_not_fatal_and_keeps_the_analysis(self):
        """Advice is a bonus; a missing key must not lose the measurement.
        Exiting non-zero here would also stop any script that chains on it."""
        from music_studio.insight.advise import AdviseError

        tdir = self.track()
        with patch("music_studio.insight.advise.advise",
                   side_effect=AdviseError("No OPENROUTER_API_KEY.")):
            result = runner.invoke(app, ["scope", str(tdir), "--advise"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("no advice", result.output)
        self.assertTrue((tdir / "analysis.json").is_file())

    def test_an_unreadable_file_exits_with_the_analyser_message(self):
        from music_studio.audio.analyze import AnalyzeError

        self.analyze.side_effect = AnalyzeError("Not an audio file: junk.wav")
        result = runner.invoke(app, ["scope", str(self.track())])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("Not an audio file", result.output)

    def test_open_writes_a_launcher_and_names_it(self):
        tdir = self.track()
        web = self.tmp / "web"
        web.mkdir()
        (web / "index.html").write_text(
            '<html><script src="studio.js"></script></html>', encoding="utf-8")
        with patch("music_studio.paths.web_dir", return_value=web), \
                patch("webbrowser.open") as browser:
            result = runner.invoke(app, ["scope", str(tdir), "--open"])
        self.assertEqual(result.exit_code, 0, result.output)
        browser.assert_called_once()
        self.assertTrue((web / "scope.html").is_file())
        self.assertIn("opened scope.html", result.output)

    def test_open_without_an_installed_page_exits_rather_than_launching(self):
        tdir = self.track()
        with patch("music_studio.paths.web_dir",
                   return_value=self.tmp / "gone"), \
                patch("webbrowser.open") as browser:
            result = runner.invoke(app, ["scope", str(tdir), "--open"])
        self.assertEqual(result.exit_code, 1)
        browser.assert_not_called()
        self.assertIn("No studio page", result.output)

    def test_without_open_it_says_where_the_page_is(self):
        """Not opening anything is the default, so the terminal has to say
        what to do next or the JSON is written and nothing points at it."""
        tdir = self.track()
        result = runner.invoke(app, ["scope", str(tdir)])
        self.assertIn("index.html", result.output)
        self.assertIn("analysis.json", result.output)

    def test_an_audio_file_argument_writes_beside_the_audio(self):
        """The third accepted shape: point it straight at a wav."""
        f = self.tmp / "loose.wav"
        f.write_bytes(b"RIFF")
        result = runner.invoke(app, ["scope", str(f)])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertTrue((self.tmp / "analysis.json").is_file())


# --------------------------------------------------------------------------
# studio — delegation, which is the point of the refactor
# --------------------------------------------------------------------------

class TestStudio(_Tmp):
    """`music studio` holds no sequence of its own any more.

    It used to reimplement studio_run's order inline, and the CLI and the
    page drifted into writing different things from the same click. So what
    is tested is that the command delegates, with the flags translated — not
    what the sequence does, which test_studio_run.py owns.
    """

    SUMMARY = {
        "ok": True,
        "headline": "Ready to upload",
        "verdicts": [{"id": "codec", "severity": "ok", "title": "Full band"}],
        "timeline": [],
        "advice": None,
        "files": {},
    }

    def summary(self, dest: Path) -> dict:
        out = dict(self.SUMMARY)
        (dest / "analysis.json").write_text('{"measures":{}}', encoding="utf-8")
        for name in ("REPORT.md", "report.ai.md", "timeline.json"):
            (dest / name).write_text("x", encoding="utf-8")
        out["files"] = {"analysis": str(dest / "analysis.json"),
                        "human": str(dest / "REPORT.md"),
                        "ai": str(dest / "report.ai.md"),
                        "timeline": str(dest / "timeline.json")}
        return out

    def test_delegates_to_studio_run_with_the_resolved_audio(self):
        tdir = self.track()
        with patch("music_studio.insight.studio_run.run") as run:
            run.return_value = self.summary(tdir / "masters")
            result = runner.invoke(app, ["studio", str(tdir)])
        self.assertEqual(result.exit_code, 0, result.output)
        run.assert_called_once_with(tdir / "masters" / "master.wav",
                                    tdir / "masters", advice=True)

    def test_out_dir_is_passed_through(self):
        tdir = self.track()
        dest = self.tmp / "out"
        dest.mkdir()
        with patch("music_studio.insight.studio_run.run") as run:
            run.return_value = self.summary(dest)
            result = runner.invoke(app, ["studio", str(tdir),
                                         "--out-dir", str(dest)])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(run.call_args.args[1], dest)

    def test_no_advice_becomes_advice_false(self):
        """The flag is inverted on the way through; getting the sense wrong
        would silently call the model on every run."""
        tdir = self.track()
        with patch("music_studio.insight.studio_run.run") as run:
            run.return_value = self.summary(tdir / "masters")
            runner.invoke(app, ["studio", str(tdir), "--no-advice"])
        self.assertIs(run.call_args.kwargs["advice"], False)

    def test_prints_the_verdicts_and_the_files(self):
        tdir = self.track()
        with patch("music_studio.insight.studio_run.run") as run:
            run.return_value = self.summary(tdir / "masters")
            result = runner.invoke(app, ["studio", str(tdir)])
        self.assertIn("Ready to upload", result.output)
        self.assertIn("Full band", result.output)
        self.assertIn("REPORT.md", result.output)

    def test_an_analysis_failure_exits_non_zero(self):
        from music_studio.audio.analyze import AnalyzeError

        tdir = self.track()
        with patch("music_studio.insight.studio_run.run",
                   side_effect=AnalyzeError("No audio at nowhere.wav")):
            result = runner.invoke(app, ["studio", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("No audio at", result.output)

    def test_open_writes_a_launcher_and_hands_it_to_the_browser(self):
        """The `--open` path reads analysis.json back only here — `--serve`
        returns before it, because the analysis runs to megabytes and only the
        launcher needs it in memory."""
        tdir = self.track()
        page = self.tmp / "web" / "index.html"
        page.parent.mkdir()
        page.write_text('<html><script src="studio.js"></script></html>',
                        encoding="utf-8")
        with patch("music_studio.insight.studio_run.run") as run, \
                patch("music_studio.paths.page", return_value=page), \
                patch("webbrowser.open") as browser:
            run.return_value = self.summary(tdir / "masters")
            result = runner.invoke(app, ["studio", str(tdir), "--open"])
        self.assertEqual(result.exit_code, 0, result.output)
        browser.assert_called_once()
        launcher = page.parent / "scope.html"
        self.assertTrue(launcher.is_file())
        self.assertIn(launcher.as_uri(), browser.call_args.args[0])

    def test_open_without_an_installed_page_exits_rather_than_launching(self):
        """Opening a browser on a path that is not there shows a file-not-found
        page, which reads as the analysis having failed."""
        tdir = self.track()
        with patch("music_studio.insight.studio_run.run") as run, \
                patch("music_studio.paths.page",
                      return_value=self.tmp / "gone" / "index.html"), \
                patch("webbrowser.open") as browser:
            run.return_value = self.summary(tdir / "masters")
            result = runner.invoke(app, ["studio", str(tdir), "--open"])
        self.assertEqual(result.exit_code, 1)
        browser.assert_not_called()
        self.assertIn("No studio page", result.output)

    def test_serve_hands_the_output_directory_to_the_server(self):
        tdir = self.track()
        with patch("music_studio.insight.studio_run.run") as run, \
                patch("music_studio.serve.http.serve") as serve:
            run.return_value = self.summary(tdir / "masters")
            result = runner.invoke(app, ["studio", str(tdir),
                                         "--serve", "--port", "9111"])
        self.assertEqual(result.exit_code, 0, result.output)
        serve.assert_called_once()
        self.assertEqual(serve.call_args.args[1], 9111)
        self.assertIs(serve.call_args.args[2], False)

    def test_a_busy_port_under_serve_exits_non_zero(self):
        from music_studio.serve.http import ServeError

        tdir = self.track()
        with patch("music_studio.insight.studio_run.run") as run, \
                patch("music_studio.serve.http.serve",
                      side_effect=ServeError("port 8770 is in use")):
            run.return_value = self.summary(tdir / "masters")
            result = runner.invoke(app, ["studio", str(tdir), "--serve"])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("in use", result.output)


# --------------------------------------------------------------------------
# measure
# --------------------------------------------------------------------------

class TestMeasure(_Tmp):
    def test_prints_the_three_numbers(self):
        from music_studio.audio.master import Loudness

        f = self.tmp / "a.wav"
        f.write_bytes(b"RIFF")
        with patch("music_studio.audio.master.measure",
                   return_value=Loudness(-14.2, -1.1, 6.5, -24.0)) as measure:
            result = runner.invoke(app, ["measure", str(f)])
        self.assertEqual(result.exit_code, 0, result.output)
        measure.assert_called_once_with(f)
        self.assertIn("-14.2 LUFS", result.output)
        self.assertIn("-1.1 dBTP", result.output)
        self.assertIn("LRA 6.5", result.output)

    def test_a_missing_file_exits_with_the_measurer_message(self):
        from music_studio.audio.master import MasterError

        with patch("music_studio.audio.master.measure",
                   side_effect=MasterError("File not found: gone.wav")):
            result = runner.invoke(app, ["measure", str(self.tmp / "gone.wav")])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("gone.wav", result.output)


# --------------------------------------------------------------------------
# master
# --------------------------------------------------------------------------

class TestMaster(_Tmp):
    def test_the_targets_reach_loudnorm_as_numbers(self):
        """`--lufs -16` arriving as the string "-16" is the kind of wiring bug
        only a parsed invocation catches."""
        tdir = self.track(master=False)
        with patch("music_studio.audio.master.master_loudnorm") as ml:
            result = runner.invoke(app, ["master", str(tdir),
                                         "--lufs", "-16", "--tp", "-0.5",
                                         "--bit-depth", "16"])
        self.assertEqual(result.exit_code, 0, result.output)
        kwargs = ml.call_args.kwargs
        self.assertEqual(kwargs["lufs"], -16.0)
        self.assertEqual(kwargs["tp"], -0.5)
        self.assertEqual(kwargs["bit_depth"], 16)

    def test_the_single_take_is_found_and_the_master_lands_in_masters(self):
        tdir = self.track(master=False)
        with patch("music_studio.audio.master.master_loudnorm") as ml:
            runner.invoke(app, ["master", str(tdir)])
        self.assertEqual(ml.call_args.args[0],
                         tdir / "masters" / "takes" / "take-01.wav")
        self.assertEqual(ml.call_args.args[1], tdir / "masters" / "master.wav")

    def test_a_reference_takes_the_other_route(self):
        """--reference must not fall through to loudnorm with the reference
        silently ignored."""
        tdir = self.track(master=False)
        ref = self.tmp / "ref.wav"
        ref.write_bytes(b"RIFF")
        with patch("music_studio.audio.master.master_reference") as mr, \
                patch("music_studio.audio.master.master_loudnorm") as ml:
            result = runner.invoke(app, ["master", str(tdir),
                                         "--reference", str(ref)])
        self.assertEqual(result.exit_code, 0, result.output)
        ml.assert_not_called()
        self.assertEqual(mr.call_args.args[2], ref)

    def test_several_takes_refuses_and_lists_them(self):
        """Picking one for the user would be a coin flip over which render is
        the good one."""
        tdir = self.track(master=False)
        (tdir / "masters" / "takes" / "take-02.wav").write_bytes(b"RIFF")
        result = runner.invoke(app, ["master", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("--take", result.output)
        self.assertIn("take-02.wav", result.output)

    def test_no_takes_directory_says_where_to_put_the_export(self):
        tdir = self.tmp / "bare"
        tdir.mkdir()
        result = runner.invoke(app, ["master", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("masters/takes", result.output)

    def test_an_empty_takes_directory_is_refused(self):
        tdir = self.track(master=False, take=False)
        result = runner.invoke(app, ["master", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("No audio files", result.output)

    def test_refuses_to_write_the_master_over_the_take(self):
        """Masters and takes stay separate — the take is the only copy of what
        came out of the generator, and overwriting it is unrecoverable."""
        tdir = self.track(master=False)
        take = tdir / "masters" / "takes" / "take-01.wav"
        with patch("music_studio.audio.master.master_loudnorm") as ml:
            result = runner.invoke(app, ["master", str(tdir),
                                         "--out", str(take)])
        self.assertEqual(result.exit_code, 1)
        ml.assert_not_called()
        self.assertIn("Refusing to overwrite", result.output)

    def test_a_mastering_failure_exits_non_zero(self):
        from music_studio.audio.master import MasterError

        tdir = self.track(master=False)
        with patch("music_studio.audio.master.master_loudnorm",
                   side_effect=MasterError("ffmpeg failed during normalise")):
            result = runner.invoke(app, ["master", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("ffmpeg failed", result.output)


# --------------------------------------------------------------------------
# compare
# --------------------------------------------------------------------------

class TestCompare(_Tmp):
    def test_defaults_to_the_take_against_the_master(self):
        """The question the command exists to answer: what did mastering do."""
        tdir = self.track()
        with patch("music_studio.audio.compare.compare") as cmp_:
            result = runner.invoke(app, ["compare", str(tdir)])
        self.assertEqual(result.exit_code, 0, result.output)
        args = cmp_.call_args.args
        self.assertEqual(args[0], tdir / "masters" / "takes" / "take-01.wav")
        self.assertEqual(args[1], tdir / "masters" / "master.wav")

    def test_explicit_a_and_b_bypass_the_track_layout(self):
        a = self.tmp / "one.wav"
        b = self.tmp / "two.wav"
        for p in (a, b):
            p.write_bytes(b"RIFF")
        null = self.tmp / "diff.wav"
        with patch("music_studio.audio.compare.compare") as cmp_:
            result = runner.invoke(app, ["compare", str(self.tmp),
                                         "--a", str(a), "--b", str(b),
                                         "--null", str(null),
                                         "--amplify", "12"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(cmp_.call_args.args, (a, b, null, 12.0))

    def test_a_missing_master_says_to_run_master_first(self):
        tdir = self.track(master=False)
        result = runner.invoke(app, ["compare", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("music master", result.output)

    def test_a_comparison_failure_exits_non_zero(self):
        from music_studio.audio.compare import CompareError

        tdir = self.track()
        with patch("music_studio.audio.compare.compare",
                   side_effect=CompareError("lengths differ by 4 s")):
            result = runner.invoke(app, ["compare", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("lengths differ", result.output)


# --------------------------------------------------------------------------
# maximize
# --------------------------------------------------------------------------

class TestMaximize(_Tmp):
    def test_a_preset_reaches_the_worker_as_settings(self):
        f = self.tmp / "a.wav"
        f.write_bytes(b"RIFF")
        with patch("music_studio.audio.maximize.run") as run:
            result = runner.invoke(app, ["maximize", str(f), "--preset", "loud"])
        self.assertEqual(result.exit_code, 0, result.output)
        src, dst, settings = run.call_args.args
        self.assertEqual(src, f)
        self.assertEqual(dst, self.tmp / "a-max.wav")
        self.assertTrue(settings.maximize)

    def test_out_overrides_the_derived_name(self):
        f = self.tmp / "a.wav"
        f.write_bytes(b"RIFF")
        dst = self.tmp / "chosen.wav"
        with patch("music_studio.audio.maximize.run") as run:
            runner.invoke(app, ["maximize", str(f), "--preset", "gentle",
                                "--out", str(dst)])
        self.assertEqual(run.call_args.args[1], dst)

    def test_it_points_at_master_next(self):
        """The limiter here cannot set the true-peak ceiling and must never be
        the last word; the reminder is the only thing that says so."""
        f = self.tmp / "a.wav"
        f.write_bytes(b"RIFF")
        with patch("music_studio.audio.maximize.run"):
            result = runner.invoke(app, ["maximize", str(f), "--preset", "loud"])
        self.assertIn("music master", result.output)

    def test_an_unknown_preset_is_refused_and_lists_the_known_ones(self):
        f = self.tmp / "a.wav"
        f.write_bytes(b"RIFF")
        with patch("music_studio.audio.maximize.run") as run:
            result = runner.invoke(app, ["maximize", str(f),
                                         "--preset", "sparkly"])
        self.assertEqual(result.exit_code, 1)
        run.assert_not_called()
        self.assertIn("gentle", result.output)

    def test_chain_prints_the_filter_and_renders_nothing(self):
        f = self.tmp / "a.wav"
        f.write_bytes(b"RIFF")
        with patch("music_studio.audio.maximize.run") as run:
            result = runner.invoke(app, ["maximize", str(f),
                                         "--preset", "loud", "--chain"])
        self.assertEqual(result.exit_code, 0, result.output)
        run.assert_not_called()
        self.assertIn("acompressor", result.output)

    def test_list_describes_the_presets_and_renders_nothing(self):
        with patch("music_studio.audio.maximize.run") as run:
            result = runner.invoke(app, ["maximize", str(self.tmp), "--list"])
        run.assert_not_called()
        self.assertIn("gentle", result.output)

    def test_a_track_directory_with_no_master_is_refused(self):
        tdir = self.track(master=False)
        with patch("music_studio.audio.maximize.run") as run:
            result = runner.invoke(app, ["maximize", str(tdir),
                                         "--preset", "loud"])
        self.assertEqual(result.exit_code, 1)
        run.assert_not_called()
        self.assertIn("No audio at", result.output)

    def test_a_render_failure_exits_non_zero(self):
        from music_studio.audio.maximize import MaximizeError

        f = self.tmp / "a.wav"
        f.write_bytes(b"RIFF")
        with patch("music_studio.audio.maximize.run",
                   side_effect=MaximizeError("ffmpeg failed")):
            result = runner.invoke(app, ["maximize", str(f),
                                         "--preset", "loud"])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("ffmpeg failed", result.output)


# --------------------------------------------------------------------------
# video
# --------------------------------------------------------------------------

class TestVideo(_Tmp):
    def test_the_flags_reach_build(self):
        tdir = self.track(art=True)
        with patch("music_studio.audio.trackvideo.build",
                   return_value=[]) as build:
            result = runner.invoke(app, ["video", str(tdir), "--zoom",
                                         "--short", "--pad-colour", "white"])
        self.assertEqual(result.exit_code, 0, result.output)
        args, kwargs = build.call_args.args, build.call_args.kwargs
        self.assertEqual(args[0], tdir / "masters" / "master.wav")
        self.assertEqual(args[1], tdir / "artwork" / "cover.png")
        self.assertEqual(args[2], tdir / "video")
        self.assertIs(kwargs["zoom"], True)
        self.assertIs(kwargs["short"], True)
        self.assertEqual(kwargs["pad_colour"], "white")

    def test_several_images_picks_one_and_says_which(self):
        """Silently choosing among artwork is how the wrong cover ships."""
        tdir = self.track(art=True)
        (tdir / "artwork" / "alternate.png").write_bytes(b"\x89PNG")
        with patch("music_studio.audio.trackvideo.build",
                   return_value=[]) as build:
            result = runner.invoke(app, ["video", str(tdir)])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(build.call_args.args[1].name, "alternate.png")
        self.assertIn("of 2 images", result.output)

    def test_the_written_files_are_listed_with_their_sizes(self):
        """The one number that says whether the render actually produced a
        video rather than a 0 MB stub."""
        tdir = self.track(art=True)
        out = tdir / "video" / "video.mp4"
        out.parent.mkdir(parents=True)
        out.write_bytes(b"0" * 2_500_000)
        with patch("music_studio.audio.trackvideo.build", return_value=[out]):
            result = runner.invoke(app, ["video", str(tdir)])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("2.5 MB", result.output)
        self.assertIn("Rendered.", result.output)

    def test_an_audio_override_is_used_instead_of_the_master(self):
        tdir = self.track(art=True)
        other = self.tmp / "alternate.wav"
        other.write_bytes(b"RIFF")
        with patch("music_studio.audio.trackvideo.build",
                   return_value=[]) as build:
            result = runner.invoke(app, ["video", str(tdir),
                                         "--audio", str(other)])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(build.call_args.args[0], other)

    def test_an_explicit_art_path_skips_the_glob(self):
        tdir = self.track(art=True)
        chosen = self.tmp / "poster.jpg"
        chosen.write_bytes(b"\xff\xd8")
        with patch("music_studio.audio.trackvideo.build",
                   return_value=[]) as build:
            runner.invoke(app, ["video", str(tdir), "--art", str(chosen)])
        self.assertEqual(build.call_args.args[1], chosen)

    def test_no_artwork_is_refused(self):
        tdir = self.track(art=True)
        (tdir / "artwork" / "cover.png").unlink()
        with patch("music_studio.audio.trackvideo.build") as build:
            result = runner.invoke(app, ["video", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        build.assert_not_called()
        self.assertIn("--art", result.output)

    def test_no_master_says_to_run_master_first(self):
        tdir = self.track(master=False, art=True)
        result = runner.invoke(app, ["video", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("music master", result.output)

    def test_a_render_failure_exits_non_zero(self):
        from music_studio.audio.trackvideo import TrackVideoError

        tdir = self.track(art=True)
        with patch("music_studio.audio.trackvideo.build",
                   side_effect=TrackVideoError("ffmpeg not on PATH")):
            result = runner.invoke(app, ["video", str(tdir)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("ffmpeg not on PATH", result.output)


# --------------------------------------------------------------------------
# advise
# --------------------------------------------------------------------------

class TestAdvise(_Tmp):
    def test_an_analysis_json_is_read_and_the_question_passed_on(self):
        j = self.tmp / "analysis.json"
        j.write_text(json.dumps(analysis()), encoding="utf-8")
        with patch("music_studio.insight.advise.advise",
                   return_value="Lower the input gain.") as advise:
            result = runner.invoke(app, ["advise", str(j),
                                         "--ask", "is the low end ok?",
                                         "--model", "vendor/model-1"])
        self.assertEqual(result.exit_code, 0, result.output)
        args = advise.call_args.args
        self.assertEqual(args[0]["measures"]["lra"], 7.0)
        self.assertEqual(args[1], "is the low end ok?")
        self.assertEqual(args[2], "vendor/model-1")
        self.assertIn("Lower the input gain.", result.output)

    def test_a_track_directory_finds_its_analysis(self):
        tdir = self.track()
        (tdir / "analysis.json").write_text(json.dumps(analysis()),
                                            encoding="utf-8")
        with patch("music_studio.insight.advise.advise",
                   return_value="Fine.") as advise:
            result = runner.invoke(app, ["advise", str(tdir)])
        self.assertEqual(result.exit_code, 0, result.output)
        advise.assert_called_once()

    def test_no_analysis_says_to_run_scope_first(self):
        """It reads an analysis, never the audio — so the fix is `music scope`,
        not a louder error about a missing file."""
        result = runner.invoke(app, ["advise", str(self.track())])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("music scope", result.output)

    def test_a_missing_key_exits_non_zero_with_the_reason(self):
        from music_studio.insight.advise import AdviseError

        j = self.tmp / "analysis.json"
        j.write_text("{}", encoding="utf-8")
        with patch("music_studio.insight.advise.advise",
                   side_effect=AdviseError("No OPENROUTER_API_KEY.")):
            result = runner.invoke(app, ["advise", str(j)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("OPENROUTER_API_KEY", result.output)


# --------------------------------------------------------------------------
# serve
# --------------------------------------------------------------------------

class TestServe(_Tmp):
    def test_the_root_is_resolved_before_the_server_sees_it(self):
        """The server's path containment compares against this root; handing
        it a relative path would defeat every one of those checks."""
        with patch("music_studio.serve.http.serve") as serve:
            result = runner.invoke(app, ["serve", str(self.tmp),
                                         "--port", "9123", "--read-only"])
        self.assertEqual(result.exit_code, 0, result.output)
        root, port, read_only = serve.call_args.args
        self.assertEqual(root, self.tmp.resolve())
        self.assertTrue(root.is_absolute())
        self.assertEqual(port, 9123)
        self.assertIs(read_only, True)

    def test_read_only_defaults_to_off(self):
        with patch("music_studio.serve.http.serve") as serve:
            runner.invoke(app, ["serve", str(self.tmp)])
        self.assertIs(serve.call_args.args[2], False)

    def test_a_busy_port_exits_non_zero(self):
        from music_studio.serve.http import ServeError

        with patch("music_studio.serve.http.serve",
                   side_effect=ServeError("port 8770 is in use")):
            result = runner.invoke(app, ["serve", str(self.tmp)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("in use", result.output)


# --------------------------------------------------------------------------
# new
# --------------------------------------------------------------------------

class TestNew(_Tmp):
    """The template is not installed in this checkout — `paths.song_template()`
    returns None — so the degraded path is the one that actually runs here, and
    it is the one worth pinning: a stub with real front matter, plus a warning
    saying what happened."""

    def setUp(self):
        super().setUp()
        saved = os.environ.get("MUSIC_STUDIO_TEMPLATE")
        os.environ["MUSIC_STUDIO_TEMPLATE"] = "/nonexistent/song-template.md"

        def restore():
            if saved is None:
                os.environ.pop("MUSIC_STUDIO_TEMPLATE", None)
            else:
                os.environ["MUSIC_STUDIO_TEMPLATE"] = saved
        self.addCleanup(restore)

    def test_the_folders_the_rest_of_the_pipeline_expects_are_made(self):
        result = runner.invoke(app, ["new", "ida-y-vuelta",
                                     "--channel", "camille-marceau",
                                     "--root", str(self.tmp)])
        self.assertEqual(result.exit_code, 0, result.output)
        tdir = self.tmp / "tracks" / "ida-y-vuelta"
        for sub in ("masters/takes", "artwork", "video"):
            with self.subTest(sub=sub):
                self.assertTrue((tdir / sub).is_dir(), sub)

    def test_without_a_template_it_writes_a_usable_stub_and_warns(self):
        result = runner.invoke(app, ["new", "ida-y-vuelta",
                                     "--channel", "camille-marceau",
                                     "--root", str(self.tmp)])
        self.assertEqual(result.exit_code, 0, result.output)
        song = (self.tmp / "tracks" / "ida-y-vuelta" / "song.md").read_text("utf-8")
        self.assertIn("slug: ida-y-vuelta", song)
        self.assertIn("channel: camille-marceau", song)
        self.assertIn("status: sketch", song)
        self.assertIn("no template", result.output)

    def test_a_template_when_present_has_its_placeholders_filled(self):
        """The path that runs on an installed copy. The placeholders are a
        contract with song-template.md; leaving one in place ships a track
        whose front matter says '<kebab-case-folder-name>'."""
        tpl = self.tmp / "song-template.md"
        tpl.write_text("slug: <kebab-case-folder-name>\n"
                       "title: <Display title, accents and all>\n"
                       "channel: <channel-slug>\n"
                       "created: <YYYY-MM-DD>\n", encoding="utf-8")
        result = runner.invoke(app, ["new", "le-vieux-port",
                                     "--channel", "le-bal-musette",
                                     "--title", "Le Vieux Port",
                                     "--root", str(self.tmp),
                                     "--template", str(tpl)])
        self.assertEqual(result.exit_code, 0, result.output)
        song = (self.tmp / "tracks" / "le-vieux-port" / "song.md").read_text("utf-8")
        self.assertIn("slug: le-vieux-port", song)
        self.assertIn("title: Le Vieux Port", song)
        self.assertIn("channel: le-bal-musette", song)
        self.assertNotIn("<", song)

    def test_a_non_kebab_slug_is_refused_before_anything_is_created(self):
        """The slug becomes a folder name, a file stem and a URL; catching it
        after the directories exist would leave a half-made track behind."""
        result = runner.invoke(app, ["new", "Ida_Y_Vuelta",
                                     "--channel", "camille-marceau",
                                     "--root", str(self.tmp)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("kebab-case", result.output)
        self.assertFalse((self.tmp / "tracks").exists())

    def test_an_existing_track_is_not_overwritten(self):
        args = ["new", "ida-y-vuelta", "--channel", "camille-marceau",
                "--root", str(self.tmp)]
        runner.invoke(app, args)
        song = self.tmp / "tracks" / "ida-y-vuelta" / "song.md"
        song.write_text("edited by hand\n", encoding="utf-8")
        result = runner.invoke(app, args)
        self.assertEqual(result.exit_code, 1)
        self.assertIn("already exists", result.output)
        self.assertEqual(song.read_text("utf-8"), "edited by hand\n")

    def test_the_channel_is_required(self):
        result = runner.invoke(app, ["new", "ida-y-vuelta",
                                     "--root", str(self.tmp)])
        self.assertNotEqual(result.exit_code, 0)


# --------------------------------------------------------------------------
# doctor
# --------------------------------------------------------------------------

class TestDoctor(unittest.TestCase):
    def test_missing_ffmpeg_is_reported_and_exits_non_zero(self):
        """A missing ffmpeg makes half the commands fail with an ffmpeg error
        at render time; doctor is what turns that into an answer up front."""
        with patch("shutil.which", return_value=None):
            result = runner.invoke(app, ["doctor"])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("ffmpeg", result.output)
        self.assertIn("brew install ffmpeg", result.output)
        self.assertIn("missing", result.output)

    def test_a_present_tool_carries_no_hint(self):
        """The hint column is the instruction; showing it beside a ✓ would
        read as something still to do."""
        with patch("shutil.which", return_value="/opt/homebrew/bin/ffmpeg"):
            result = runner.invoke(app, ["doctor"])
        ffmpeg_line = next(ln for ln in result.output.splitlines()
                           if " ffmpeg" in ln)
        self.assertIn("✓", ffmpeg_line)
        self.assertNotIn("brew install", ffmpeg_line)

    def test_an_importable_library_is_reported_present(self):
        """numpy is a hard dependency of the analyser, so it must be here; if
        this fails the environment is broken, not the test."""
        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            result = runner.invoke(app, ["doctor"])
        numpy_line = next(ln for ln in result.output.splitlines()
                          if " numpy" in ln)
        self.assertIn("✓", numpy_line)


# --------------------------------------------------------------------------
# _write_launcher
# --------------------------------------------------------------------------

class TestWriteLauncher(_Tmp):
    """A file:// page may not fetch a sibling JSON — every local file is its
    own origin — so the analysis is inlined into a wrapper instead."""

    PAGE = ('<html><body><div id="app"></div>'
            '<script src="studio.js"></script></body></html>')

    def page(self) -> Path:
        p = self.tmp / "index.html"
        p.write_text(self.PAGE, encoding="utf-8")
        return p

    def test_the_analysis_is_inlined_ahead_of_the_page_script(self):
        """Ahead of it, not after: the page reads window.PRELOADED_ANALYSIS as
        it loads, and data arriving later is data the page never sees."""
        out = cli._write_launcher(self.page(), {"measures": {"lra": 7.0}},
                                  "master.wav")
        html = out.read_text("utf-8")
        self.assertEqual(out.name, "scope.html")
        self.assertLess(html.index("PRELOADED_ANALYSIS"),
                        html.index('<script src="studio.js"'))
        self.assertIn('"lra":7.0', html)
        self.assertIn('window.PRELOADED_NAME = "master.wav"', html)

    def test_a_closing_script_tag_in_the_data_is_escaped(self):
        """`</script>` inside the JSON would end the block early and leave the
        rest of the payload rendering as text on the page."""
        out = cli._write_launcher(self.page(),
                                  {"note": "</script><b>hi</b>"}, "x.wav")
        html = out.read_text("utf-8")
        self.assertNotIn("</script><b>", html)
        self.assertIn("<\\/script>", html)

    def test_advice_and_path_are_inlined_only_when_given(self):
        """The page asks follow-up questions about PRELOADED_PATH; defining it
        as undefined would be worse than leaving it absent."""
        bare = cli._write_launcher(self.page(), {}, "x.wav").read_text("utf-8")
        self.assertNotIn("PRELOADED_ADVICE", bare)
        self.assertNotIn("PRELOADED_PATH", bare)

        full = cli._write_launcher(self.page(), {}, "x.wav", "Ship it.",
                                   self.tmp / "analysis.json").read_text("utf-8")
        self.assertIn('window.PRELOADED_ADVICE = "Ship it."', full)
        self.assertIn("analysis.json", full)

    def test_a_page_that_no_longer_loads_studio_js_is_refused(self):
        """Silently writing a launcher with no injection point produces a page
        that opens empty, which looks like a broken analysis."""
        page = self.tmp / "index.html"
        page.write_text("<html><body>rebuilt</body></html>", encoding="utf-8")
        with self.assertRaises(typer.Exit):
            cli._write_launcher(page, {}, "x.wav")
        self.assertFalse((self.tmp / "scope.html").exists())


# --------------------------------------------------------------------------
# check / publish — currently broken, pinned as such
# --------------------------------------------------------------------------

class TestYouTubeCommandsAreMissing(_Tmp):
    """KNOWN HOLE, not a passing feature.

    `check` and `publish` both need a `ytpublish` module that has never been
    written, so neither command can work. These tests pin that — and pin the
    SHAPE of the failure, which is the part that was worth fixing.

    Until recently the ImportError escaped `_fail()` and a user got a raw
    traceback: a stack trace is the wrong answer to "why did this not work",
    because it reads as a broken install rather than a feature that does not
    exist. Now both commands exit non-zero with a sentence saying so, and
    saying which commands DO work.

    When ytpublish is written (or the commands are removed), these should
    fail. That is the point of them.
    """

    def _expect_missing(self, argv):
        result = runner.invoke(app, argv)
        self.assertNotEqual(result.exit_code, 0)
        # A readable sentence, not a traceback.
        self.assertIsNone(result.exception if isinstance(
            result.exception, ModuleNotFoundError) else None,
            "a bare ModuleNotFoundError reached the user")
        out = result.stdout + (result.stderr or "")
        self.assertIn("ytpublish", out)
        self.assertIn("not available", out)
        return out

    def test_check_fails_readably_because_ytpublish_is_absent(self):
        song = self.tmp / "song.md"
        song.write_text("---\nslug: x\n---\n", encoding="utf-8")
        out = self._expect_missing(["check", str(song)])
        # It must also say what still works, or the message reads as "broken".
        self.assertIn("master", out)

    def test_publish_fails_readably_because_ytpublish_is_absent(self):
        song = self.tmp / "song.md"
        song.write_text("---\nslug: x\n---\n", encoding="utf-8")
        self._expect_missing(["publish", str(song), "--dry-run"])

    def test_song_file_resolution_still_rejects_a_directory_without_song_md(self):
        """The one part of `check` that does not depend on ytpublish: a bare
        directory has nothing to validate. It is a BadParameter, so Typer
        reports it as a usage error rather than a crash."""
        with self.assertRaises(Exception) as caught:
            cli._song_file(self.tmp)
        self.assertIn("No song.md", str(caught.exception))

    def test_song_file_accepts_a_directory_holding_one(self):
        song = self.tmp / "song.md"
        song.write_text("---\n---\n", encoding="utf-8")
        self.assertEqual(cli._song_file(self.tmp), song)
        self.assertEqual(cli._song_file(song), song)


# --------------------------------------------------------------------------
# argument parsing itself
# --------------------------------------------------------------------------

class TestArgumentParsing(_Tmp):
    def test_no_arguments_shows_the_help_rather_than_doing_nothing(self):
        result = runner.invoke(app, [])
        self.assertIn("Usage", result.output)

    def test_an_unknown_command_is_a_usage_error(self):
        result = runner.invoke(app, ["remaster", "x"])
        self.assertNotEqual(result.exit_code, 0)

    def test_a_missing_required_argument_is_a_usage_error(self):
        result = runner.invoke(app, ["measure"])
        self.assertNotEqual(result.exit_code, 0)

    def test_a_non_numeric_lufs_is_refused_before_any_render(self):
        """Typer converts it, so a bad value never reaches ffmpeg as a string."""
        tdir = self.track(master=False)
        with patch("music_studio.audio.master.master_loudnorm") as ml:
            result = runner.invoke(app, ["master", str(tdir),
                                         "--lufs", "quiet"])
        self.assertNotEqual(result.exit_code, 0)
        ml.assert_not_called()

    def test_every_documented_command_is_registered(self):
        """The module docstring advertises these; one missing means a command
        was renamed without the help following it."""
        result = runner.invoke(app, ["--help"])
        for name in ("new", "check", "measure", "studio", "maximize", "serve",
                     "advise", "scope", "master", "compare", "video",
                     "publish", "doctor"):
            with self.subTest(command=name):
                self.assertIn(name, result.output)


if __name__ == "__main__":
    unittest.main()
