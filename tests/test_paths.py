#!/usr/bin/env python3
"""Tests for paths.py.

This module exists because five call sites each computed an asset location
from their own `__file__`, and every one of them breaks when a module moves.
So what is worth testing is not that a path is correct today — it is that the
answers all hang off one root, and that the root can be moved.

If these pass with `MUSIC_STUDIO_ROOT` pointing somewhere else, the package can
be relocated without anything going looking for a file beside itself.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from music_studio import paths


class _Env(unittest.TestCase):
    """Each test gets a clean set of overrides and puts them back."""

    VARS = ("MUSIC_STUDIO_ROOT", "MUSIC_STUDIO_WEB",
            "MUSIC_STUDIO_TEMPLATE", "MUSIC_STUDIO_ENV")

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in self.VARS}
        for k in self.VARS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class TestDefaults(_Env):
    def test_root_is_where_the_code_is(self):
        self.assertEqual(paths.root(), Path(paths.__file__).resolve().parent)

    def test_the_web_directory_exists(self):
        """Not just a plausible path — the page has to actually be there."""
        self.assertTrue(paths.web_dir().is_dir(), paths.web_dir())

    def test_the_page_exists(self):
        self.assertTrue(paths.page().is_file(), paths.page())
        self.assertEqual(paths.page().name, "index.html")

    def test_scripts_resolve_to_real_modules(self):
        """serve.py runs these as subprocesses; a wrong path is a 500 at
        request time rather than an import error at startup."""
        for name in ("analyze.py", "master.py", "maximize.py", "advise.py"):
            with self.subTest(script=name):
                self.assertTrue(paths.script(name).is_file(), name)

    def test_env_file_is_named_dot_env(self):
        self.assertEqual(paths.env_file().name, ".env")

    def test_song_template_is_none_when_absent(self):
        """The contract that `music new` relies on to degrade gracefully.
        A path that does not exist would only move the check to the caller."""
        os.environ["MUSIC_STUDIO_TEMPLATE"] = "/nonexistent/nowhere.md"
        self.assertIsNone(paths.song_template())

    def test_song_template_is_returned_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            tpl = Path(tmp) / "song-template.md"
            tpl.write_text("# template\n")
            os.environ["MUSIC_STUDIO_TEMPLATE"] = str(tpl)
            self.assertEqual(paths.song_template(), tpl)


class TestRelocation(_Env):
    """The property that matters: everything follows one root."""

    def test_every_answer_moves_with_the_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["MUSIC_STUDIO_ROOT"] = tmp
            root = Path(tmp).resolve()
            self.assertEqual(paths.root(), root)
            self.assertEqual(paths.web_dir(), root / "web")
            self.assertEqual(paths.page(), root / "web" / "index.html")
            self.assertEqual(paths.env_file(), root / ".env")
            self.assertEqual(paths.script("analyze.py"), root / "audio" / "analyze.py")

    def test_web_override_beats_the_root(self):
        """A packaged copy may keep its data somewhere the root cannot reach."""
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["MUSIC_STUDIO_ROOT"] = "/somewhere"
            os.environ["MUSIC_STUDIO_WEB"] = tmp
            self.assertEqual(paths.web_dir(), Path(tmp).resolve())
            self.assertEqual(paths.page().parent, Path(tmp).resolve())

    def test_overrides_are_read_at_call_time(self):
        """Read on each call, not captured at import — otherwise a test (or a
        caller that sets one late) would be silently ignored."""
        first = paths.root()
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["MUSIC_STUDIO_ROOT"] = tmp
            self.assertNotEqual(paths.root(), first)
        os.environ.pop("MUSIC_STUDIO_ROOT")
        self.assertEqual(paths.root(), first)

    def test_a_user_path_is_expanded(self):
        os.environ["MUSIC_STUDIO_ENV"] = "~/some.env"
        self.assertNotIn("~", str(paths.env_file()))


class TestProjectRoot(_Env):
    """The .env is USER configuration, not package data.

    Conflating "where the code is" with "where the checkout is" broke the key
    lookup twice: once when this code moved to its own repository, and again
    when it moved into src/. The package root is src/music_studio/; a person
    puts their .env beside pyproject.toml.
    """

    def test_project_root_is_above_the_package(self):
        self.assertNotEqual(paths.project_root(), paths.root())
        self.assertIn(paths.project_root(), paths.root().parents)

    def test_project_root_holds_pyproject(self):
        self.assertTrue((paths.project_root() / "pyproject.toml").is_file())

    def test_env_file_sits_at_the_project_root(self):
        self.assertEqual(paths.env_file().parent, paths.project_root())

    def test_env_file_is_findable(self):
        """Not just well-named: the file the AI features need must resolve.

        This is the assertion that would have caught both regressions."""
        self.assertTrue(paths.env_file().is_file()
                        or os.environ.get("OPENROUTER_API_KEY"),
                        f"no key reachable: {paths.env_file()} missing and "
                        "OPENROUTER_API_KEY unset")


class TestCallersUseIt(unittest.TestCase):
    """The point of the module is that nothing else hardcodes these."""

    def test_serve_takes_its_web_directory_from_paths(self):
        from music_studio.serve import http
        self.assertEqual(http.STUDIO, paths.web_dir())

    def test_advise_env_path_delegates(self):
        from music_studio.insight import advise
        self.assertEqual(advise.env_path(), paths.env_file())


if __name__ == "__main__":
    unittest.main()
