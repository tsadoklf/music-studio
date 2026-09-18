#!/usr/bin/env python3
"""The browser panel's presets must match maximize.py's, field for field.

`widgets/maximizer.js` carries its own copy of `Settings`' defaults and of
`PRESETS`, because the page has to work from `file://` with no server to ask.
That copy is a promise: the panel emits `music maximize <track> --preset loud`
and the user expects the render to sound like the preview.

A slip in that transcription is invisible from both sides. The panel looks
right, the render runs, and the master is quietly built to different numbers
than the ones on screen — the exact failure mode the panel's approximation
notice exists to prevent, arriving through the back door.

So it is checked mechanically. The values are read out of the JavaScript with
node, which is already required to run the page.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from dataclasses import fields
from pathlib import Path

import maximize
from maximize import PRESETS, Settings

PANEL = Path(__file__).resolve().parent.parent / "studio/widgets/maximizer.js"
HAVE_NODE = shutil.which("node") is not None


def _js_literal(name: str, source: str):
    """Evaluate one top-level `const <name> = <literal>;` from the panel.

    A regex alone cannot read these — they hold comments, string concatenation
    and trailing commas — so the literal is handed to node, which is the same
    parser the browser will use on it.
    """
    # Non-greedy up to the first `];`/`};` at any indentation: a one-line
    # literal has no newline before its bracket, so requiring one found the
    # multi-line tables and silently missed SOFT_CLIP_TYPES.
    m = re.search(r"const %s = (\[.*?\]|\{.*?\});\s*$" % re.escape(name),
                  source, re.S | re.M)
    if not m:
        raise AssertionError(f"{name} not found in {PANEL.name}")
    out = subprocess.run(
        ["node", "-e", f"const V = {m.group(1)}; console.log(JSON.stringify(V));"],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"node could not parse {name}:\n{out.stderr}")
    return json.loads(out.stdout)


@unittest.skipUnless(PANEL.is_file(), "the studio panel is not present")
@unittest.skipUnless(HAVE_NODE, "node is not on PATH")
class TestPanelMatchesPython(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = PANEL.read_text()
        cls.defaults = _js_literal("RACK_DEFAULTS", src)
        cls.presets = {p["id"]: p for p in _js_literal("RACK_PRESETS", src)}

    def test_defaults_match_the_dataclass(self):
        """The panel diffs against these to decide which flags to emit, so a
        wrong default silently drops a flag from the command line."""
        for f in fields(Settings):
            with self.subTest(field=f.name):
                self.assertIn(f.name, self.defaults,
                              f"{f.name} missing from RACK_DEFAULTS")
                self.assertEqual(getattr(Settings(), f.name),
                                 self.defaults[f.name])

    def test_no_invented_fields(self):
        known = {f.name for f in fields(Settings)}
        self.assertEqual(set(self.defaults) - known, set(),
                         "RACK_DEFAULTS has fields maximize.py does not")

    def test_every_preset_is_present(self):
        self.assertEqual(set(self.presets), set(PRESETS))

    def test_preset_values_match(self):
        """Resolved the way each side resolves it: the panel overlays its
        preset onto its defaults, Settings(...) fills the rest of the
        dataclass. Both must land on the same numbers."""
        for name, (settings, _) in PRESETS.items():
            effective = dict(self.defaults)
            effective.update(self.presets[name]["set"])
            for f in fields(Settings):
                with self.subTest(preset=name, field=f.name):
                    self.assertEqual(getattr(settings, f.name),
                                     effective[f.name])

    def test_preset_descriptions_match(self):
        """The prose is the advice. A panel that recommends one thing while
        the CLI's --list recommends another is two products."""
        for name, (_, why) in PRESETS.items():
            with self.subTest(preset=name):
                self.assertEqual(" ".join(why.split()),
                                 " ".join(self.presets[name]["why"].split()))

    def test_soft_clip_curves_match(self):
        src = PANEL.read_text()
        curves = _js_literal("SOFT_CLIP_TYPES", src)
        self.assertEqual(list(maximize.SOFT_CLIP_TYPES), curves)


if __name__ == "__main__":
    unittest.main()
