#!/usr/bin/env python3
"""Tests for advise.py and the targets contract.

No test here calls a model. What is worth testing is the part that is ours: that
the digest keeps the numbers a decision rests on and drops the megabytes that it
does not, and that the delivery targets travel with the analysis instead of
being copied into consumers.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
import unittest

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


if __name__ == "__main__":
    unittest.main()
