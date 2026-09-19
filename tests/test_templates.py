#!/usr/bin/env python3
"""The template library.

`music new` scaffolds a track from a template. For most of this project's life
the template was not installed at all — it lived in a sibling repository the
package could not reach, so `new` silently degraded to a five-line stub and
warned. That is the failure these guard against: not that the code runs, but
that a template is actually THERE and actually gets filled in.

The library is a directory, so adding a template is dropping a `.md` in it.
There is no registry, which means there is also nothing to forget to update —
and nothing here asserts a hardcoded list of names.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from typer.testing import CliRunner

from music_studio import paths
from music_studio.cli import app

runner = CliRunner()

SUBSTITUTED = ("<kebab-case-folder-name>", "<channel-slug>")


class _Env(unittest.TestCase):
    VARS = ("MUSIC_STUDIO_TEMPLATE", "MUSIC_STUDIO_TEMPLATES")

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


class TestTheLibraryIsInstalled(_Env):
    """The bug itself: for a long time, none of this existed on disk."""

    def test_the_directory_ships_with_the_package(self):
        self.assertTrue(paths.templates_dir().is_dir(), paths.templates_dir())

    def test_at_least_one_template_is_installed(self):
        self.assertTrue(paths.templates(),
                        "no templates: `music new` degrades to a stub")

    def test_the_default_is_called_song(self):
        """`music new` with no --template asks for this name."""
        self.assertIn("song", paths.templates())
        self.assertIsNotNone(paths.song_template())

    def test_the_readme_is_not_offered_as_a_template(self):
        """templates/README.md documents the directory; it is not a scaffold,
        and offering it would put its prose into somebody's song.md."""
        self.assertNotIn("readme", {k.lower() for k in paths.templates()})

    def test_an_unknown_name_is_none_rather_than_a_bad_path(self):
        """None is the contract `music new` branches on. A path that does not
        exist would only move the check to the caller."""
        self.assertIsNone(paths.song_template("definitely-not-a-template"))


class TestTemplateContent(_Env):
    """A template nobody can fill in is no better than the stub."""

    def test_the_default_carries_the_placeholders_new_substitutes(self):
        text = paths.song_template().read_text(encoding="utf-8")
        for token in SUBSTITUTED:
            self.assertIn(token, text, f"{token} missing: `new` would fill nothing")

    def test_every_template_has_a_summary_line(self):
        """--list-templates shows it. Without one the listing reads
        `slug: <kebab-case-folder-name>`, which describes nothing."""
        from music_studio.cli import _template_summary
        for name, path in paths.templates().items():
            with self.subTest(template=name):
                self.assertNotEqual(_template_summary(path), "(no summary)")

    def test_no_template_names_a_particular_artist(self):
        """The examples inside a placeholder teach what kind of answer a field
        wants, and should stay specific. But a template is not the place for
        one user's channel names — this package was extracted precisely to
        stop that coupling."""
        for name, path in paths.templates().items():
            text = path.read_text(encoding="utf-8").lower()
            with self.subTest(template=name):
                self.assertNotIn("camille-marceau", text)
                self.assertNotIn("<le-bal-musette |", text)


class TestListTemplates(_Env):
    def test_it_lists_what_is_installed(self):
        result = runner.invoke(app, ["new", "--list-templates"])
        self.assertEqual(result.exit_code, 0, result.output)
        for name in paths.templates():
            self.assertIn(name, result.stdout)

    def test_it_shows_a_description_not_frontmatter(self):
        result = runner.invoke(app, ["new", "--list-templates"])
        self.assertNotIn("slug: <kebab", result.stdout)

    def test_it_does_not_need_a_slug_or_a_channel(self):
        """Both are otherwise required; listing must not demand them."""
        result = runner.invoke(app, ["new", "--list-templates"])
        self.assertEqual(result.exit_code, 0)
        self.assertNotIn("Missing", result.stdout)


class TestNewUsesTheLibrary(_Env):
    def setUp(self):
        super().setUp()
        self.tmp = Path(tempfile.mkdtemp())

    def _song(self, *extra):
        result = runner.invoke(app, ["new", "a-track", "--channel", "a-channel",
                                     "--root", str(self.tmp), *extra])
        return result, self.tmp / "tracks" / "a-track" / "song.md"

    def test_the_default_template_is_used_and_filled(self):
        result, song = self._song()
        self.assertEqual(result.exit_code, 0, result.output)
        text = song.read_text(encoding="utf-8")
        self.assertIn("slug: a-track", text)
        self.assertIn("channel: a-channel", text)
        for token in SUBSTITUTED:
            self.assertNotIn(token, text, "a placeholder survived substitution")

    def test_it_is_the_real_template_not_the_stub(self):
        """The stub is five lines of frontmatter. The point of this work is
        that `new` no longer falls back to it."""
        _, song = self._song()
        self.assertGreater(len(song.read_text(encoding="utf-8").splitlines()), 50)

    def test_a_template_can_be_chosen_by_name(self):
        result, song = self._song("--template", "song")
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("slug: a-track", song.read_text(encoding="utf-8"))

    def test_an_unknown_name_fails_and_names_the_alternatives(self):
        result, _ = self._song("--template", "nonsense")
        self.assertNotEqual(result.exit_code, 0)
        out = result.stdout + (result.stderr or "")
        self.assertIn("nonsense", out)
        self.assertIn("song", out, "the error should say what IS available")

    def test_a_path_still_works(self):
        """An ad-hoc template outside the package must not need installing."""
        mine = self.tmp / "mine.md"
        mine.write_text("---\nslug: <kebab-case-folder-name>\n---\n> mine\n",
                        encoding="utf-8")
        result, song = self._song("--template", str(mine))
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("slug: a-track", song.read_text(encoding="utf-8"))

    def test_a_missing_path_fails_readably(self):
        result, _ = self._song("--template", str(self.tmp / "nope.md"))
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("No template at", result.stdout + (result.stderr or ""))

    def test_the_date_is_filled_once_not_everywhere(self):
        """`created` takes today; `published` keeps its placeholder, because a
        track being scaffolded has not been published."""
        _, song = self._song()
        text = song.read_text(encoding="utf-8")
        self.assertIn("created: 20", text)
        self.assertIn("published: <YYYY-MM-DD", text)


if __name__ == "__main__":
    unittest.main()
