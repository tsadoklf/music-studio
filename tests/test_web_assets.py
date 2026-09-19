#!/usr/bin/env python3
"""The browser bench, checked from Python.

There is no JavaScript test runner here, and adding one would mean a build step
for a page whose whole point is that it opens from `file://` by double-clicking
it. So the properties that can be checked by reading the files are checked
here, where they run in the same suite as everything else.

These guard one specific failure: the page is a set of classic `<script>` tags
sharing ONE global scope, so a top-level `const clamp` in two files is
`Identifier 'clamp' has already been declared` — and the second script then
never runs. The symptom is a blank panel and one line in a console nobody is
looking at. Splitting this page has failed three times on exactly that; see
`web/widgets/README.md`.

A brace-depth scan, not a regex on indentation: `studio.js` writes function
bodies UNINDENTED, so `const s = ...` at column 0 is usually a local. A
line-based count reports 228 top-level declarations where there are 75.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from music_studio import paths

WEB = paths.web_dir()


def top_level_names(src: str) -> set[str]:
    """Names declared at brace depth 0, skipping strings and comments."""
    names: set[str] = set()
    depth = 0
    quote: str | None = None
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "\"'`":
            quote = c
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = (j + 1) if j > 0 else n
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i)
            i = (j + 2) if j > 0 else n
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif depth == 0 and (i == 0 or src[i - 1] == "\n"):
            m = re.match(r"(?:const|let|var|class|function)\s+(\w+)", src[i:])
            if m:
                names.add(m.group(1))
        i += 1
    return names


def scripts_in_order() -> list[Path]:
    """The page's own load order, read from index.html rather than guessed."""
    html = (WEB / "index.html").read_text(encoding="utf-8")
    out = []
    for src in re.findall(r'<script src="([^"]+)"', html):
        p = WEB / src
        if p.is_file():
            out.append(p)
    return out


class TestNoGlobalCollisions(unittest.TestCase):
    """The failure that killed three attempts at splitting this page."""

    def test_the_page_lists_some_scripts(self):
        """A guard against the guard: if the parse returns nothing, every
        other assertion here passes by vacuum."""
        self.assertGreater(len(scripts_in_order()), 3)

    def test_no_two_scripts_declare_the_same_top_level_name(self):
        seen: dict[str, Path] = {}
        clashes: list[str] = []
        for path in scripts_in_order():
            for name in top_level_names(path.read_text(encoding="utf-8")):
                if name in seen and seen[name] != path:
                    clashes.append(
                        f"{name!r} declared in both {seen[name].name} and {path.name}")
                else:
                    seen[name] = path
        self.assertEqual(clashes, [],
                         "classic scripts share one scope: the second "
                         "declaration throws and that whole file never runs")

    def test_widgets_stay_inside_their_iife(self):
        """Every widget file wraps itself, which is what keeps its helpers out
        of the shared scope. A file that forgets is invisible until its names
        happen to collide with someone else's."""
        for path in sorted((WEB / "widgets").glob("*.js")):
            src = path.read_text(encoding="utf-8")
            self.assertIn("(function (__W)", src,
                          f"{path.name} is not wrapped in the namespace IIFE")
            self.assertIn("window.__studioWidgets", src, path.name)


class TestLoadOrder(unittest.TestCase):
    """`tray.js` names every widget factory, so it has to run last."""

    def test_tray_is_the_last_widget(self):
        widgets = [p.name for p in scripts_in_order() if "widgets/" in str(p)]
        self.assertTrue(widgets, "no widget scripts found in index.html")
        self.assertEqual(widgets[-1], "tray.js")

    def test_core_is_the_first_widget(self):
        widgets = [p.name for p in scripts_in_order() if "widgets/" in str(p)]
        self.assertEqual(widgets[0], "core.js")

    def test_every_script_the_page_names_exists(self):
        """A renamed file that index.html still points at is a 404 and a dead
        panel — and the page carries on loading, so nothing announces it."""
        html = (WEB / "index.html").read_text(encoding="utf-8")
        for src in re.findall(r'<script src="([^"]+)"', html):
            if src.startswith(("http://", "https://", "//")):
                continue
            self.assertTrue((WEB / src).is_file(), f"index.html names {src}")

    def test_every_stylesheet_the_page_names_exists(self):
        html = (WEB / "index.html").read_text(encoding="utf-8")
        for href in re.findall(r'<link[^>]+href="([^"]+)"', html):
            if href.startswith(("http://", "https://", "//")):
                continue
            self.assertTrue((WEB / href).is_file(), f"index.html names {href}")


class TestNoModules(unittest.TestCase):
    """The page must keep opening from file:// with no build step.

    Under file:// every file is an opaque origin, so `import` is blocked by
    CORS and a `<script type="module">` page loads nothing at all. This is the
    constraint that forces the IIFE-and-namespace arrangement; a stray ES
    module would work on a server and fail silently on a double-click.
    """

    def test_no_script_tag_is_a_module(self):
        html = (WEB / "index.html").read_text(encoding="utf-8")
        self.assertNotIn('type="module"', html)

    def test_no_file_uses_import_or_export(self):
        for path in scripts_in_order():
            src = path.read_text(encoding="utf-8")
            for line in src.splitlines():
                stripped = line.strip()
                self.assertFalse(
                    re.match(r"^(import|export)\s", stripped),
                    f"{path.name}: {stripped[:60]!r} — blocked under file://")


if __name__ == "__main__":
    unittest.main()
