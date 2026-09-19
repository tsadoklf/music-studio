#!/usr/bin/env python3
"""The package boundaries, enforced rather than documented.

`audio/` measures; `insight/` interprets; `serve/` transports. The rule that
makes those more than labels is the DIRECTION: audio must not import insight.

It is not an aesthetic preference. `insight/` is the only half that needs an
API key and a network, so the moment `audio/` depends on it, a missing key or
a dead endpoint stops the meters — and the meters are the part that has to
keep working when everything else is broken.

The rule was written into `audio/__init__.py` as prose and was false within a
day: `analyze.py` imported `insight.timeline` for its dated findings, because
those findings are pure arithmetic that happened to live on the wrong side of
the line. The fix was to move them (`audio/timeline.py`), and this file is so
that the next such import fails a test instead of a docstring.

Parsed with `ast` rather than imported: an import inside a function body is
still a dependency, and it is exactly where this one was hiding.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

import music_studio

PKG = Path(music_studio.__file__).resolve().parent


def _imports(path: Path) -> set[str]:
    """Every module this file imports, at any nesting depth."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                found.add(node.module)
    return found


def _files(sub: str) -> list[Path]:
    return sorted((PKG / sub).glob("*.py"))


class TestLayering(unittest.TestCase):
    def test_audio_does_not_import_insight(self):
        """The rule. See this module's docstring for why it matters."""
        for f in _files("audio"):
            for mod in _imports(f):
                self.assertFalse(
                    mod.startswith("music_studio.insight"),
                    f"{f.name} imports {mod} — audio/ must not depend on "
                    "insight/, or a missing API key stops the measurement")

    def test_audio_does_not_import_serve(self):
        """Measurement must not depend on a transport either: analyze.py has
        to work with no server running and no browser open."""
        for f in _files("audio"):
            for mod in _imports(f):
                self.assertFalse(mod.startswith("music_studio.serve"),
                                 f"{f.name} imports {mod}")

    def test_insight_does_not_import_serve(self):
        for f in _files("insight"):
            for mod in _imports(f):
                self.assertFalse(mod.startswith("music_studio.serve"),
                                 f"{f.name} imports {mod}")

    def test_the_layers_are_not_empty(self):
        """A guard against the guard: if a rename emptied a directory, every
        assertion above would pass by vacuum."""
        for sub in ("audio", "insight", "serve"):
            self.assertGreater(len(_files(sub)), 1, f"{sub}/ looks empty")


class TestNoNetworkInAudio(unittest.TestCase):
    """The same rule from the other side.

    A module in audio/ that reached the network directly would satisfy the
    import test while breaking what it protects, so the transports are checked
    by name too.
    """

    NETWORK = ("urllib.request", "http.client", "requests", "httpx", "socket")

    def test_audio_modules_do_not_reach_the_network(self):
        for f in _files("audio"):
            for mod in _imports(f):
                self.assertNotIn(
                    mod, self.NETWORK,
                    f"{f.name} imports {mod}: measurement must work offline")


class TestTimelineSplit(unittest.TestCase):
    """The specific split Phase 4 made, asserted rather than assumed."""

    def test_the_pure_half_needs_no_model(self):
        from music_studio.audio import timeline as pure
        for mod in _imports(PKG / "audio" / "timeline.py"):
            self.assertFalse(mod.startswith("music_studio.insight"), mod)
        self.assertTrue(hasattr(pure, "find_events"))

    def test_the_commenting_half_is_in_insight(self):
        from music_studio.insight import timeline as commented
        self.assertTrue(hasattr(commented, "add_comments"))

    def test_findings_are_reachable_from_both(self):
        """`insight.timeline` re-exports find_events so existing callers and
        the CLI keep working after the move."""
        from music_studio.audio import timeline as pure
        from music_studio.insight import timeline as commented
        self.assertIs(commented.find_events, pure.find_events)

    def test_analyze_embeds_a_timeline_without_insight(self):
        """The reason for the whole split: analyze.py attaches dated findings,
        and must do it without touching the half that needs a key."""
        for mod in _imports(PKG / "audio" / "analyze.py"):
            self.assertFalse(mod.startswith("music_studio.insight"), mod)


if __name__ == "__main__":
    unittest.main()
