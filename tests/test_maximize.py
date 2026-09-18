#!/usr/bin/env python3
"""Tests for maximize.py.

Two things here are worth guarding. The first is the preset/override contract:
a preset that cannot be edited is a mode, not a preset, and the whole point of
this design is that every knob stays reachable.

The second is the safety rule that made this module depart from MClass at all:
ffmpeg's `alimiter` cannot hold a true-peak ceiling, so a chain that ENDS in a
limiter is a chain whose output nobody has checked. Measured: asked for
-1.0 dBFS it still let +0.4 dBTP through.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from music_studio.audio import maximize
from music_studio.audio.maximize import PRESETS, Settings, build_chain, chain_string, resolve

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
needs_ffmpeg = unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not on PATH")


class TestPresets(unittest.TestCase):
    def test_every_preset_has_an_explanation(self):
        for name, (_, why) in PRESETS.items():
            self.assertTrue(why.strip(), f"{name} has no description")

    def test_every_preset_builds_a_chain(self):
        for name, (settings, _) in PRESETS.items():
            self.assertTrue(chain_string(settings), f"{name} built nothing")

    def test_every_preset_validates(self):
        for name, (settings, _) in PRESETS.items():
            settings.validate()          # raises if a preset ships a bad value

    def test_unknown_preset_names_the_known_ones(self):
        with self.assertRaises(maximize.MaximizeError) as c:
            resolve("nonsense", {})
        self.assertIn("gentle", str(c.exception))


class TestOverrides(unittest.TestCase):
    """A preset is a starting point. If a knob cannot override it, it is a
    mode wearing a preset's name."""

    def test_a_knob_overrides_its_preset(self):
        s = resolve("loud", {"comp_ratio": 6.0})
        self.assertEqual(s.comp_ratio, 6.0)
        self.assertNotEqual(s.comp_ratio, PRESETS["loud"][0].comp_ratio)

    def test_unnamed_knobs_keep_the_preset_value(self):
        s = resolve("loud", {"comp_ratio": 6.0})
        self.assertEqual(s.comp_attack, PRESETS["loud"][0].comp_attack)

    def test_every_setting_is_reachable_by_hand(self):
        """No preset may hold a value the command line cannot also set."""
        from dataclasses import fields
        names = {f.name for f in fields(Settings)}
        for name, (settings, _) in PRESETS.items():
            for f in fields(Settings):
                s = resolve(None, {f.name: getattr(settings, f.name)})
                self.assertEqual(getattr(s, f.name), getattr(settings, f.name),
                                 f"{f.name} not settable by hand")

    def test_naming_a_knob_enables_its_device(self):
        """--comp-ratio without --comp should not silently do nothing."""
        self.assertTrue(resolve(None, {"comp_ratio": 4.0}).comp)
        self.assertTrue(resolve(None, {"xover": 800.0}).imager)
        self.assertTrue(resolve(None, {"input_gain": 3.0}).maximize)

    def test_no_preset_means_everything_bypassed(self):
        self.assertEqual(chain_string(Settings()), "")


class TestSafety(unittest.TestCase):
    """The rule that made this depart from MClass's own device order."""

    def test_the_limiter_is_set_below_the_asked_for_ceiling(self):
        """alimiter overshoots, so it must aim lower than the real ceiling."""
        import re
        chain = chain_string(Settings(maximize=True, limit=-1.0))
        m = re.search(r"alimiter=limit=([0-9.]+)", chain)
        self.assertIsNotNone(m)
        asked = 10 ** (-1.0 / 20)
        self.assertLess(float(m.group(1)), asked,
                        "limiter set at or above the ceiling leaves no room "
                        "for its own overshoot")

    def test_limit_default_is_below_full_scale(self):
        self.assertLess(Settings().limit, 0.0)

    def test_look_ahead_is_on_by_default(self):
        """MClass's 4 ms look-ahead is what makes brickwall limiting clean."""
        self.assertTrue(Settings().look_ahead)

    def test_look_ahead_emits_latency_compensation(self):
        chain = chain_string(Settings(maximize=True, look_ahead=True))
        self.assertIn("latency=1", chain)

    def test_auto_release_uses_asc(self):
        """MClass's Auto adapts to the material; alimiter's asc is that idea."""
        chain = chain_string(Settings(maximize=True, limit_release="auto"))
        self.assertIn("asc=1", chain)


class TestValidation(unittest.TestCase):
    def test_ratio_beyond_ffmpegs_ceiling_is_refused(self):
        with self.assertRaises(maximize.MaximizeError):
            Settings(comp_ratio=99.0).validate()

    def test_threshold_outside_mclass_range_is_refused(self):
        with self.assertRaises(maximize.MaximizeError):
            Settings(comp_threshold=10.0).validate()

    def test_input_gain_beyond_12_db_is_refused(self):
        with self.assertRaises(maximize.MaximizeError):
            Settings(input_gain=30.0).validate()

    def test_unknown_soft_clip_curve_is_refused(self):
        with self.assertRaises(maximize.MaximizeError):
            Settings(soft_clip="sparkle").validate()

    def test_unknown_limit_attack_is_refused(self):
        with self.assertRaises(maximize.MaximizeError):
            Settings(limit_attack="instant").validate()

    def test_crossover_outside_mclass_range_is_refused(self):
        with self.assertRaises(maximize.MaximizeError):
            Settings(xover=20.0).validate()


class TestChainShape(unittest.TestCase):
    def test_devices_run_in_mclass_order(self):
        """Compress before widening: a compressor reacts to the mid signal, so
        widening first changes what it hears."""
        s = Settings(comp=True, imager=True, maximize=True, soft_clip="tanh")
        names = [n for n, _ in build_chain(s)]
        self.assertLess(names.index("compressor"), names.index("stereo imager"))
        self.assertLess(names.index("stereo imager"), names.index("maximizer"))
        self.assertLess(names.index("maximizer"), names.index("soft clip"))

    def test_bypassed_devices_contribute_nothing(self):
        s = Settings(comp=True, comp_ratio=2.0)
        self.assertNotIn("alimiter", chain_string(s))
        self.assertNotIn("stereotools", chain_string(s))

    def test_threshold_is_emitted_as_amplitude_not_db(self):
        """ffmpeg wants a linear threshold; MClass speaks dB."""
        chain = chain_string(Settings(comp=True, comp_threshold=-18.0))
        self.assertIn("threshold=0.125", chain)


@needs_ffmpeg
class TestAgainstFfmpeg(unittest.TestCase):
    """Every preset must produce a chain ffmpeg actually accepts. A chain that
    reads well and fails at run time is worse than no chain."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.src = self.tmp / "t.wav"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
             "-i", "sine=frequency=440:duration=2:sample_rate=48000",
             "-ac", "2", "-c:a", "pcm_s24le", str(self.src)],
            check=True, capture_output=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_every_preset_runs(self):
        for name, (settings, _) in PRESETS.items():
            with self.subTest(preset=name):
                out = self.tmp / f"{name}.wav"
                maximize.run(self.src, out, settings)
                self.assertTrue(out.is_file() and out.stat().st_size > 1000)

    def test_refuses_to_overwrite_the_source(self):
        with self.assertRaises(maximize.MaximizeError):
            maximize.run(self.src, self.src, PRESETS["gentle"][0])

    def test_refuses_an_empty_chain(self):
        with self.assertRaises(maximize.MaximizeError):
            maximize.run(self.src, self.tmp / "o.wav", Settings())


if __name__ == "__main__":
    unittest.main()
