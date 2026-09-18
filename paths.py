#!/usr/bin/env python3
"""Where things are, asked once.

Every module that needs an asset — the browser page, the song template, a
sibling script to run as a subprocess — used to work it out from its own
`__file__`. That is fine while every file sits in one directory and wrong the
moment any of them moves, which is exactly what packaging this will do. Five
call sites each carried their own copy of the same assumption.

So the questions are answered here instead, and the answers have one override
apiece. Nothing else in the codebase should write `Path(__file__)` to find an
asset; a module's own location is a detail of how it was installed, not a fact
about where the user's files are.

The environment variables exist for the case this module cannot reason about:
an installed copy whose data lives somewhere else entirely, and a test that
wants to point at a fixture. They are read at call time rather than at import,
so a test can set one without reloading the module.
"""

from __future__ import annotations

import os
from pathlib import Path

# The directory this package lives in. Every default below hangs off it.
_ROOT = Path(__file__).resolve().parent


def root() -> Path:
    """The installation root — where the code and its data sit together."""
    override = os.environ.get("MUSIC_STUDIO_ROOT")
    return Path(override).expanduser().resolve() if override else _ROOT


def web_dir() -> Path:
    """The browser bench: index.html, its CSS, and widgets/.

    Named `studio/` on disk. It is data, not code — no Python imports it, and
    it has to keep opening from `file://` with no build step — so it travels
    with the package rather than being generated.
    """
    override = os.environ.get("MUSIC_STUDIO_WEB")
    return Path(override).expanduser().resolve() if override else root() / "studio"


def page() -> Path:
    """The studio page itself, the file a browser opens."""
    return web_dir() / "index.html"


def song_template() -> Path | None:
    """The scaffold `music new` copies, or None when it is not installed.

    None rather than a missing path: the caller already degrades to a stub and
    warns, and handing back a path that does not exist only moves the check.
    """
    override = os.environ.get("MUSIC_STUDIO_TEMPLATE")
    candidate = (Path(override).expanduser() if override
                 else root() / "song-template.md")
    return candidate if candidate.is_file() else None


def script(name: str) -> Path:
    """A sibling module, as a path, for running in a subprocess.

    `serve.py` shells out to these rather than importing them, so that a
    command that crashes takes its own process down instead of the server.
    That means it needs real paths, and those paths have to survive the module
    moving into a package.
    """
    return root() / name


def env_file() -> Path:
    """The .env holding OPENROUTER_API_KEY. Git-ignored; see .env.example."""
    override = os.environ.get("MUSIC_STUDIO_ENV")
    return Path(override).expanduser() if override else root() / ".env"
