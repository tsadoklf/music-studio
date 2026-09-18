"""A mastering bench: measure audio, master it, and see what you are doing.

The CLI is the authority. The browser page under `web/` is a control surface
for it and computes nothing the CLI cannot.

    from music_studio.audio import analyze, master
    from music_studio.insight import report

`paths` answers where the page, the song template and the .env live; nothing
else should work that out from its own location.
"""

__version__ = "1.0.0"
