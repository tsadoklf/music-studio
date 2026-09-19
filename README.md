# music-studio

A mastering bench for a small music imprint: a Python CLI that measures and
masters audio, and a browser control surface for it.

This repository is code only. Audio, artwork and video stay wherever you keep
them and are reached through `--root` and the file arguments — nothing here
hardcodes a path to your music, so one checkout serves any number of projects
and stays small enough to clone in a second.

## Start here

**[`STATUS.md`](STATUS.md)** is the whole-system view: what exists, what is
proven, what is known-broken, and the invariants that will bite you. Read it
before changing anything. [`SKILL.md`](SKILL.md) is the song-production
workflow; [`studio/widgets/README.md`](studio/widgets/README.md) covers the
browser widget load order.

## Run it

```sh
python3.12 -m venv .venv && ./.venv/bin/pip install -e .
./.venv/bin/music scope <file.wav>            # measure, one JSON out
./.venv/bin/music studio <file.wav>           # measure + report
./.venv/bin/music serve <audio-dir>           # the page, 127.0.0.1:8770
./.venv/bin/python -m unittest discover -s tests -t .   # 816 tests
```

`pip install -e .` puts `music` on the PATH, so with the venv activated the
commands are just `music scope …` from any directory.

Python **3.12** or newer, with ffmpeg and ffprobe on PATH. The page also opens
by double-clicking `studio/index.html` — it just cannot run commands then,
which it says on screen.

### The one secret

Three features call OpenRouter: the advice pane, the EQ chat, and the
timeline commentary. Everything else — measurement, mastering, the maximizer,
the meters — is ffmpeg and arithmetic and needs no key at all, so the studio
is fully usable without one.

```sh
cp .env.example .env        # then paste your key in; .env is git-ignored
```

The environment wins over the file, so `export OPENROUTER_API_KEY=...` works
instead and CI never needs a file on disk. `MUSIC_STUDIO_ENV` points at the
file if it lives somewhere else.

### Pointing it at the music

Nothing here hardcodes a path to the audio; `--root` and the file arguments
are how it finds anything:

```sh
music new <slug> --channel <channel>   # scaffold a track from a template
music new --list-templates             # what is installed
music benchmark <a record you trust>.wav --add aja
music scope <your take>.wav --against aja   # how do you sit beside it
music serve /path/to/your/audio
music scope "/path/to/your/audio/<artist>/tracks/<slug>/masters/<take>.wav"
```

`--root` is a containment boundary as well as a convenience: the server will
not read or write outside it, and a path argument that escapes is refused.

## What is in it

```
src/music_studio/
  cli.py        the `music` command; thin wrappers over the modules below
  paths.py      where the page, the .env and the scripts are — asked once
  audio/        samples in, numbers out
                analyze  master  maximize  tempo  compare  trackvideo
  insight/      numbers into words — the only half that needs an API key
                report  timeline  advise  eqchat  studio_run
  serve/        the two front doors
                http (the page, for a person)  mcp (typed tools, for an agent)
  templates/    scaffolds `music new` copies; drop a .md in to add one
  insight/benchmark.py  compare against records you trust
  web/          the browser bench — 8 panels, two cascading EQs, the live suite
```

`audio/` never imports `insight/`: measurement does not depend on
interpretation, and that direction is what keeps a model failure from taking
the meters down with it.

## Working here

Run the tests before opening a PR. The CLI is the authority: if the page and
the CLI disagree, the page is wrong. Measure rather than assume — most bugs
found here were invisible to the test that was supposed to catch them.
