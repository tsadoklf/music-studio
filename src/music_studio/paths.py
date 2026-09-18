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

    `web/` inside the package. It is data, not code — no Python imports it,
    and it has to keep opening from `file://` with no build step — so it ships
    as package data rather than being generated.
    """
    override = os.environ.get("MUSIC_STUDIO_WEB")
    return Path(override).expanduser().resolve() if override else root() / "web"


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


# Where each runnable module lives, now that they are in sub-packages.
# `serve.http` names its commands by file name — "analyze.py" — because that
# is what a person types and what the MCP tool list shows. This table is the
# one place that knows the file is actually at audio/analyze.py.
_SCRIPT_PKG = {
    "analyze.py": "audio", "master.py": "audio", "maximize.py": "audio",
    "tempo.py": "audio", "compare.py": "audio", "trackvideo.py": "audio",
    "report.py": "insight", "timeline.py": "insight", "advise.py": "insight",
    "eqchat.py": "insight", "studio_run.py": "insight",
}


def script(name: str) -> Path:
    """A runnable module, as a path, for launching in a subprocess.

    `serve.http` shells out to these rather than importing them, so a command
    that crashes takes its own process down instead of the server's. That
    means real paths, and those paths have to survive the modules having moved
    into packages — which is what _SCRIPT_PKG records.

    An unknown name resolves beside the package rather than raising: the
    caller is a server handling a request, and a missing file already produces
    a readable error when the subprocess fails to start.
    """
    pkg = _SCRIPT_PKG.get(name)
    return root() / pkg / name if pkg else root() / name


def project_root() -> Path:
    """The checkout, one level above the package — NOT where the code lives.

    These are different questions and conflating them is how the key went
    missing once already. `root()` answers "where is the code and its data",
    which moves into src/music_studio/ under a src layout. A .env is the
    USER's configuration: it belongs beside pyproject.toml, where a person
    would think to put it and where .gitignore already covers it.

    Falls back to the package root when the layout is not recognisable — an
    installed wheel in site-packages has no checkout above it, and there the
    environment variable is the only sensible way to supply a key anyway.
    """
    here = root()
    for parent in (here, *here.parents):
        if (parent / "pyproject.toml").is_file():
            return parent
    return here


def env_file() -> Path:
    """The .env holding OPENROUTER_API_KEY. Git-ignored; see .env.example.

    At the PROJECT root, beside pyproject.toml — not inside the package. The
    environment still wins over it; see advise._load_env_key.
    """
    override = os.environ.get("MUSIC_STUDIO_ENV")
    return Path(override).expanduser() if override else project_root() / ".env"
