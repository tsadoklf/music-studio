#!/usr/bin/env python3
"""Tests for eqchat.py.

No test calls a model. What is worth testing is the validator, because it is the
only thing standing between a model's output and the audio graph: a filter type
that does not exist, a 40 dB boost, or a frequency above Nyquist must never
reach a BiquadFilterNode, however confidently it was returned.

The prompt's domain knowledge is also pinned. The mapping from "hum" to a narrow
notch, and the rule that a codec cutoff cannot be EQ'd back, are the difference
between an equaliser that helps and one that confidently makes things worse.
"""

from __future__ import annotations

import unittest

import eqchat


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
        import advise
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


if __name__ == "__main__":
    unittest.main()
