# Componentization plan

**Status:** in progress, 2026-09-18. Phases 0 and 1 are done.

> **This document is temporary and refers to history the code no longer does.**
> It is the only place in this repository that mentions where this code came
> from, because a plan has to explain why its phases exist. Everything else
> reads as a standalone project. Delete this file once the last phase lands —
> the status table below says when that is.

This is a plan with a live status table at the bottom. Update it in the same
change that does the work, so the plan never describes a repo that no longer
exists.

---

## What the survey found

Before proposing anything, the dependency graph was measured rather than
assumed. It is in better shape than a flat directory of 14 modules suggests:

```
advise        —
compare       —
master        —
maximize      —
report        —
serve         —
tempo         —
trackvideo    —
timeline      advise
mcp_server    serve
eqchat        advise
studio_run    advise, analyze, report, timeline
analyze       compare, master, tempo, timeline
music         advise, analyze, compare, master, maximize, report, serve, trackvideo
```

**No cycles.** Eight of the fourteen modules import nothing local at all.
`music.py` is the only broad importer, which is what a CLI entry point is
supposed to look like.

So this is not a rescue. The code is already well factored; it is only flat,
and it is missing the packaging that would make it installable. That is why
the plan below is deliberately conservative: **move files, do not rewrite
them.**

### Three couplings that look worse than they are

`analyze → master`, `analyze → compare` and `timeline → advise` are all
FUNCTION-LEVEL imports of constants or one helper:

| Edge | What is actually imported | Real dependency? |
|---|---|---|
| `analyze → master` | `DEFAULT_LUFS`, `DEFAULT_TP`, `measure` | shared constants |
| `analyze → compare` | `BANDS` | a shared table |
| `timeline → advise` | `_load_env_key`, `DEFAULT_MODEL` | the key loader |

None of them justifies restructuring around. Phase 4 tidies them; nothing
before Phase 4 depends on that happening.

---

## The target layout

```
music-studio/
├── pyproject.toml            the package, its deps, and the `music` entry point
├── README.md  STATUS.md  SKILL.md  MASTERING-RESEARCH.md
├── docs/
│   └── componentization-plan.md      this file
├── src/
│   └── music_studio/
│       ├── __init__.py
│       ├── cli.py            was music.py — commands only, no logic
│       ├── paths.py          NEW: where assets live, asked once (see Phase 1)
│       ├── audio/            the measuring and processing half
│       │   ├── analyze.py  master.py  maximize.py
│       │   ├── tempo.py    compare.py trackvideo.py
│       ├── insight/          what the numbers MEAN — the half a model touches
│       │   ├── report.py   timeline.py  advise.py  eqchat.py
│       │   └── studio_run.py
│       ├── serve/            the two front doors
│       │   ├── http.py       was serve.py
│       │   └── mcp.py        was mcp_server.py
│       └── web/              the browser bench, shipped as package data
│           ├── index.html  studio.js  *.css
│           └── widgets/
└── tests/                    unchanged in shape; one import line changes
```

### Why these four groups

They are the seams the code already has, not new ones:

- **`audio/`** touches samples. Every module in it is pure measurement or
  pure ffmpeg, takes a file path, and returns numbers or writes a file.
  Nothing in it calls a model or knows what a "verdict" is.
- **`insight/`** turns numbers into words. `report` writes verdicts,
  `timeline` dates findings, `advise` and `eqchat` ask a model. This is the
  only group that needs an API key, and isolating it makes that obvious.
- **`serve/`** is transport. Both front doors, one command table — `mcp.py`
  already generates its tools from `http.py`'s `COMMANDS`, so they belong
  together and that relationship becomes visible in the tree.
- **`web/`** is the browser bench. It is data, not code: no Python imports it,
  and it must keep opening from `file://` with no build step.

### What this buys

The point is not tidiness. It is that `music` becomes a real command:

```sh
pip install -e .
music scope take.wav           # instead of ./.venv/bin/python music.py scope
```

…which also makes the MCP registration a stable command rather than an
absolute path into somebody's checkout, and makes the package importable by
anything else later without `sys.path` surgery.

---

## Phases

Each phase ends green — tests passing, page loading — so a failure names its
own cause. **Do not start a phase before the previous one is verified.**

### Phase 0 — fix what the move broke — **DONE**

Shipped in #2. The lookup now reads `.env` beside the code, with the
environment taking precedence and `MUSIC_STUDIO_ENV` as an override; nothing
reaches outside the repo. Seven tests in `TestKeyLookup` guard it, verified by
reintroducing the bug and watching them fail. Confirmed live: `advise` and
`eqchat` both answer again.

The original description follows, for the record.

---


`advise.py` reads the API key from
`Path(__file__).resolve().parents[2] / "print-shop" / ".env"`. That resolved
into `atlas-city-press` when this code lived there. It now resolves to
`/Users/tsadok/print-shop/.env`, which does not exist — **so every AI feature
is silently keyless today**: advice, EQ chat, and timeline commentary all
degrade to "no OPENROUTER_API_KEY" without saying why.

Measured: the path it looks at exists = `False`; the real `.env` is still in
`atlas-city-press`.

Fix: `OPENROUTER_API_KEY` from the environment first (already the case), then
a `.env` in THIS repo, then an explicit `--env-file` / `MUSIC_STUDIO_ENV`.
Never a relative walk into a sibling repository — that is the assumption that
just broke. Add `.env` to `.gitignore` and document it in the README.

This phase is independent of everything else and should ship on its own.

### Phase 1 — asset paths stop being `__file__` arithmetic — **DONE**

Shipped in #3. `paths.py` answers five questions — the web directory, the
page, the song template, a sibling script, the `.env` — each with an
environment override. `song-template.md` is still not installed, so
`song_template()` returns `None` and `music new` degrades to a stub with a
warning; that is now an explicit contract rather than a path that happens not
to exist.

The original description follows, for the record.

---


Four places compute a path from their own location:

| Where | Wants |
|---|---|
| `music.py:121` | `song-template.md` beside the module |
| `music.py:265` | `studio/index.html` |
| `music.py:484` | `studio/` |
| `serve.py:51` | `HERE`, for serving the page |

Every one of them breaks the moment a module moves, which is exactly what
Phase 2 does. So a tiny `paths.py` answers these questions once, using
`importlib.resources` for packaged data, and the four callers ask it.

Do this BEFORE moving anything: it is the change that makes the move safe, and
it is verifiable on its own (page still serves, `music studio` still opens
it).

Also settle `song-template.md` here — it is absent from this repo, so
`music new` degrades to a stub. Either vendor it as package data or drop the
command's dependency on it.

### Phase 2 — the move

`git mv` into `src/music_studio/` with the groups above, add `pyproject.toml`
with a `music = "music_studio.cli:app"` entry point, and switch the two test
bootstrap files from `sys.path` insertion to a normal package import.

Mechanical. No logic changes in this phase — if a diff in Phase 2 is not a
move or an import line, it belongs in another phase.

Rename only where the package makes the old name redundant:
`serve.py → serve/http.py`, `mcp_server.py → serve/mcp.py`, `music.py → cli.py`.

### Phase 3 — the CLI gets thin

`music.py` is 672 lines and the second-largest module. Some of that is
argument wiring, which is what a CLI is for; some is logic that belongs in the
module the command drives. Move the logic down, leave the wiring.

Target: `cli.py` contains no ffmpeg invocation and no measurement maths.

### Phase 4 — the three soft couplings

- `DEFAULT_LUFS` / `DEFAULT_TP` move to a `targets` module both `master` and
  `analyze` import. Invariant 10 says these live in one place and travel in
  the analysis JSON; today that place is `master.py`, which `analyze` has to
  reach into.
- `BANDS` moves beside the spectrum code it describes.
- `timeline`'s key loading comes from the same helper Phase 0 introduces, so
  `timeline → advise` disappears on its own.

After this, `audio/` imports nothing from `insight/` — the dependency runs one
way, which is the property worth having.

### Phase 5 — `studio.js` (a separate piece of work)

5,591 lines holding four separable things: the audio engine and rack router,
card layout and workspaces, the chat and its EQ routing, and transport and
file loading.

Split the way `meters.js` became `widgets/` — and read that history first,
because **that split failed three times**: an IIFE cannot span files; a
namespace loses cross-file references if destructured at the top; and a shared
scope collides with `studio.js`'s own `clamp`, `SPEC_LABELS` and
`timelineItems`. `widgets/README.md` records all three.

Deliberately last, and deliberately not mixed with the Python work: a broken
import and a broken page look identical from the outside, and separating them
is how a failure stays diagnosable.

---

## What is NOT in this plan

- **No behaviour changes.** Every phase is a move, a rename, or a path lookup.
  The measured numbers must not shift: `-14.8 LUFS / -2.4 dBTP / LRA 7.5 /
  99.4 BPM` on `Ce Qui Reste du Feu (Take 1)` is the regression check.
- **No new features.** `ytpublish.py` is still missing and `music check` /
  `music publish` still raise `ModuleNotFoundError`. That is a hole, not a
  layout problem, and componentizing neither fixes nor worsens it.
- **No async, no plugin system, no abstraction layer** for a second
  implementation that does not exist.

---

## Verification, every phase

The same four checks, because they are the ones that have caught real
regressions here:

```sh
python -m unittest discover -s tests -t .     # 235 tests
music scope "<take>.wav"                       # -14.8 LUFS, -2.4 dBTP, LRA 7.5
music serve <audio-dir>                        # /api/health reports the root
# and open the page: 8 panels, 4 globals, no console errors
```

The page check is not optional. Several defects here were invisible to the
tests and visible only on screen.

---

## Status

| Phase | What | State |
|---|---|---|
| 0 | API key lookup no longer walks into a sibling repo | **done** (#2) |
| 1 | `paths.py`; `song-template.md` settled | **done** (#3) |
| 2 | `src/` layout, `pyproject.toml`, `music` entry point | not started |
| 3 | thin `cli.py` | not started |
| 4 | shared constants; `audio/` stops importing `insight/` | not started |
| 5 | split `studio.js` | not started |
