# Music Studio — what this is and where it stands

**Read this before changing anything here.** It is the whole-system view: what
exists, what is proven, what is known-broken, and which invariants will bite you.
`SKILL.md` covers the song-production workflow; `widgets/README.md` covers the
browser widget load order; this file covers the system.

Last verified 2026-09-17. Every number below was measured, not estimated. When a
claim here disagrees with the code, the code is right and this file is stale —
fix one of them in the same change.

---

## What it is

A mastering bench for a small music imprint. Two halves that share one contract:

1. **A Python CLI** (`music`) that measures, masters, reports on and renders
   tracks. It is the authority. Everything it reports is reproducible from a
   terminal with no browser involved.
2. **A browser page** (`studio/`) that is a control surface for that CLI —
   meters, an equaliser you can hear, a chat that can operate it, and a
   waveform. It never computes anything the CLI cannot, and it writes no audio.

The page is optional. The CLI is not.

---

## Run it

```sh
python3.12 -m venv .venv && ./.venv/bin/pip install -e .   # first time
./.venv/bin/music studio <file.wav>                    # measure + report, one step
./.venv/bin/music serve <audio-dir>                    # the page, on 127.0.0.1:8770
./.venv/bin/music maximize <file> --preset loud        # then `master` for the ceiling
./.venv/bin/python -m unittest discover -s tests -t .  # 816 tests, 92% covered
```

Python **3.12** or newer. ffmpeg and ffprobe on PATH. The page also opens
straight from `studio/index.html` with no server — it just cannot run commands
then, which it says on screen.

---

## The modules

| File | Does |
|---|---|
| `cli.py` | The CLI (`music`). Every command is a thin wrapper over one of the below. |
| `audio/analyze.py` | The measurement engine. One pass → one `audio-analysis/v1` JSON. |
| `audio/master.py` | Two-pass EBU R128 loudness + true peak, and the `--eq` presets. |
| `audio/maximize.py` | Compressor, stereo imager, maximizer, soft clip — an MClass-style suite. |
| `audio/tempo.py` | Tempo, metre and key estimation, each with a confidence. |
| `audio/timeline.py` | Dated findings — where it clips, peaks, runs off target. Pure. |
| `insight/timeline.py` | A sentence of commentary per finding, from a model. |
| `insight/benchmark.py` | Compare a track against records you trust. Measurements only, never audio. |
| `insight/report.py` | Verdicts → `REPORT.md` (for a person) and `report.ai.md` (for an agent). |
| `insight/advise.py` | Asks a model what the measurements mean. Recommends; never runs. |
| `insight/eqchat.py` | Plain language → equaliser bands. Returns data, never commands. |
| `audio/compare.py` | Null test: hear exactly what processing changed. |
| `insight/studio_run.py` | Analyse + report + advise in one call. What the page's button runs. |
| `paths.py` | Where the page, the templates, the .env and the scripts are. Asked once, never recomputed. |
| `templates/` | Scaffolds `music new` copies. A directory, so adding one is dropping a `.md` in it. |
| `serve/http.py` | Loopback HTTP server. What turns a click in the page into a process. |
| `serve/mcp.py` | The same commands as MCP tools, for an agent. Generated from serve.py's table. |
| `studio/widgets/maximizer.js` | The suite's panel: live preview, GR meters, and the command that renders it. |
| `audio/trackvideo.py` | Audio + artwork → an upload-ready MP4 and thumbnail. |

### Three front doors, on purpose

They are not alternatives; they answer different questions.

| | Gives an agent | Cannot |
|---|---|---|
| `SKILL.md` | the workflow and the judgement — when to master, why publishing before mastering is unrecoverable | execute anything |
| `serve/http.py` | the browser page, and commands for a human at a keyboard | be called by an agent without a browser |
| `serve/mcp.py` | the commands as typed tools with readable schemas | supply the judgement about when to use them |

An agent with only the skill must compose `music master <track> --lufs -14` as
text and hope the shell agrees. Over MCP it calls `master(in=..., lufs=-14)`
against a declared schema, and a wrong argument is a validation error rather
than a mangled command. The skill supplies judgement; MCP supplies hands.

The MCP tool list is GENERATED from `serve/http.py`'s `COMMANDS` table and calls its
validator, so path containment, the option whitelist and argv-not-shell are the
same code, not a second implementation that can drift. Adding a command there
exposes it in both places.

Register it with:

```json
{ "mcpServers": { "music-studio": {
    "command": "/path/to/music-studio/.venv/bin/python",
    "args": ["-m", "music_studio.serve.mcp", "--root", "/path/to/audio"] } } }
```

`--read-only` refuses every tool that writes audio. `master` additionally
requires `confirm=true`, so an agent exploring the tool list cannot overwrite a
master by accident.

---

## Status

### Works, and is tested

- **Measurement.** BS.1770-4 loudness with coefficients re-derived at the
  file's own sample rate, true peak via ffmpeg, spectrum, spectrogram,
  envelopes, stereo correlation, clipping. 53 tests.
- **Codec detection.** Finds the brick wall a lossy generation leaves. Verified
  against real LAME/AAC round-trips: 128k → 16.6 kHz, 192k → 18.7 kHz, 320k →
  20 kHz, and an untouched WAV correctly cleared.
- **Mastering.** `--lufs` / `--tp` targets, five tone presets, and a warning
  when loudnorm silently abandons linear mode.
- **Maximizer suite.** MClass-style compressor, stereo imager, maximizer and
  soft clip, with five editable presets. Reaches −14.0 LUFS in linear mode
  where loudnorm alone stalls at −13.1. Reachable from the CLI, the server and
  MCP, and previewable live in the page.
- **Tempo and key.** 99.4 BPM measured against the 100 BPM in the track's own
  `song.md`. Key reports low confidence on modal material rather than guessing.
- **Reports, timeline, advice, EQ translation, MCP, maximizer.** 816 tests total, all passing. Coverage 92%.
- **The panel cannot drift from the CLI.** `tests/test_panel_presets.py` reads
  `RACK_DEFAULTS` and `RACK_PRESETS` out of the JavaScript with node and
  compares them field for field against `maximize.py`'s `Settings` and
  `PRESETS`, descriptions included. Verified to catch a 2.5 → 2.6 typo.

### Works, verified in a browser, not unit-tested

JavaScript has no test suite here. These were each proven with measurements
taken from the live page, which is weaker than a test but stronger than a claim:

- **13 panels**, drag into rows of 2–3, named workspaces that restore layout +
  meters + EQ across a reload.
- **Live EQ.** Knob and fader changes are audible immediately via
  `BiquadFilterNode`s built from the same RBJ maths the curve is drawn from.
- **Auto gain compensation.** Measured: a +12 dB shelf on a −1 dBFS source went
  from **+4.61 dBFS / 11,949 clipped samples** to **−7.37 dBFS / 0**.
- **Waveform.** Click-to-seek accurate to 0.1–0.3 s against a 0.4 s pixel;
  drawn ink tracks the envelope (silence 12 px, loud passage 96 px).
- **Chat.** Answers with and without a file loaded, and can move the EQ.
- **Equalizer II.** A second 5-band parametric in a rack enclosure, cascading
  after the first. Measured through the engine's own chain: a +12 dB low shelf
  set from the panel gave **+10.78 dB at 60 Hz** and 0 dB at 5 kHz, matching
  the RBJ prediction of +10.73; Bypass took it to **0.00 dB** with the cable
  still patched. Cascade verified — EQ 1 at +12 and EQ 2 at +6 on one
  frequency give +18, and EQ 2 at −12 against EQ 1's +12 cancels to 0.00,
  which is what proves they are two devices and not two views of one list.
  Adds a low cut the first equaliser does not have.
- **The live rack.** The mastering suite audible as the knobs turn. The DSP was
  verified offline rather than by ear, which caught two bugs a listener would
  have missed: an imager that widened at width 1, and a limiter that overshot
  its ceiling by 2.2 dB. Measured after the fix — width 1 bit-transparent,
  ceiling held at −0.99 dBFS regardless of drive, unpatched and bypassed both
  exact passthroughs. Gain reduction is read live from the compressor nodes.
  The four settings the browser can only approximate — compressor release
  above 1 s, adaptive release, the imager crossover, and a low width that
  differs from the high one — are reported by `engine.rackApprox()` and named
  on the knob rather than clamped silently.

### Known broken

- **`music check` and `music publish` cannot work.** `ytpublish.py` has never
  been written. Both commands now exit with a sentence saying so and naming
  what does work, rather than the raw traceback they used to produce — but the
  hole is unchanged: this pipeline can measure, master, report and render
  video, and it **cannot publish**. That is the largest gap left.

### Not verified by anyone

Playback-time playhead motion; a 71 MB WAV through the waveform's peak pyramid;
touch input; Safari and Firefox; audible output through speakers (signal flow
and pixels were checked, not sound).

`benchmarks/` is the beginning of an answer to the last one: `music benchmark`
stores the measurements of records you trust, and `music scope --against` says
how a take sits beside them. It needs references to be useful, and choosing
those is a listening decision nobody else can make.

---

## The monitor chain

Blocks in order, each one patched independently. An unpatched block is absent
from the graph, not bypassed inside it:

```
source → gain → EQ 1 → [EQ 2] → [rack: comp → imager → maximizer → clip] → meters → out
                 │        │              │
         StudioEq │  StudioEq2 │   StudioRack.settings
```

Measured: with both equalisers patched, a +12 dB bell in EQ 1 and +6 dB at the
same frequency in EQ 2 give **+18 dB** — they cascade. EQ 2 set to −12 against
EQ 1's +12 gives **0.00 dB**, which is what proves they are two devices rather
than two views of one band list. Unpatched, EQ 2 is exactly transparent.

Only EQ 1 carries the auto-gain trim. A second trim would attenuate twice.

---

## Invariants — break these and something silently lies

These were each learned by getting them wrong. The comment in the code explains
the case; this is the index.

1. **`alimiter` is not a true-peak limiter.** Measured: asked for −2.0 dBFS it
   still produced +0.17 dBTP, and pushed an already-legal source over zero.
   `loudnorm`'s TP stage is the only true-peak-accurate ceiling in stock ffmpeg
   and must have the last word. Never end a chain with `alimiter`.
2. **`--eq` runs before the loudness stage.** Every tone chain changes peak
   level, so the ceiling has to be applied after it.
3. **The browser's auto-trim is monitor-only.** It must never appear in the
   emitted ffmpeg chain — `master.py` applies its own ceiling and would
   attenuate twice.
4. **A codec cutoff cannot be EQ'd back.** Both `advise.py` and `eqchat.py`
   refuse to try, and their tests assert the refusal.
5. **The band energy table is relative to one file.** It is not a tonal
   verdict and carries no reference. `report.py`'s agent report says so
   explicitly because a model reliably gets this wrong.
6. **Confidence means "this damages the audio", not "a filter exists."** A
   cutoff above 19 kHz is reported with confidence 0 — inaudible, and flagging
   every 320 kbps source cries wolf.
7. **`serve/http.py` builds argv, never a shell string.** A request names a command
   from a fixed table and supplies typed arguments; `shell=False` always. Path
   arguments must resolve inside `--root`. Loopback binding only. 20 tests
   guard this; do not add a `--host` escape hatch.
8. **Gain-less filter types are active at gain 0.** A lowpass, highpass or
   notch does its work without gain; filtering bands on `b.gain` silently
   dropped them. See `activeEqBands` in `studio.js`.
9. **Every script shares one global scope.** The page is classic `<script>`
    tags, not modules — `import` is blocked under `file://` and the page must
    open by double-click. So a top-level `const clamp` in two files throws
    `Identifier 'clamp' has already been declared` and the SECOND FILE NEVER
    RUNS, with one console line as the only symptom. Splitting `studio.js`
    failed three times on exactly this. `tests/test_web_assets.py` scans every
    script by brace depth and fails on a duplicate. Note that `studio.js`
    writes function bodies unindented, so a line-based scan is wrong: it
    reports 228 top-level declarations where there are 75.
10. **The widgets are classic scripts in one IIFE, not modules.** `import` is
   blocked on `file://` and the page must open from disk. See
   `widgets/README.md` for the load order.
11. **Delivery targets live in `master.py` and travel in the analysis JSON.**
    Nothing else should hardcode −14 LUFS / −1 dBTP.
12. **`DynamicsCompressorNode` is not a limiter either.** The browser's version
    of invariant 1, measured independently: asked to hold −1.0 dBFS it let
    +0.38 dBFS through at 6 dB of drive and +1.195 dBFS at 12 dB — worse the
    harder it is pushed. The live maximizer is a delay (look-ahead) → a
    compressor (gain riding) → a hard-clipping `WaveShaper` (the actual
    ceiling). Remove the shaper and the ceiling stops being a ceiling.
13. **Stereo width 1 must be bit-transparent.** The mid/side algebra is easy to
    fold into fewer nodes and get subtly wrong: the first version turned a
    0.5/0.1 input into 0.525/0.075 at width 1, i.e. widened the signal while
    claiming to do nothing. Each gain is its own node, and the offline check
    asserts 0/1/2 → mono / transparent / doubled.
14. **`audio/` must not import `insight/`.** Measurement cannot depend on
    interpretation: `insight/` is the only half that needs an API key and a
    network, so an import in that direction means a missing key stops the
    meters. The rule lived in a docstring and was false within a day —
    `analyze.py` imported `insight.timeline` for findings that were pure
    arithmetic all along. `tests/test_architecture.py` parses the package with
    `ast` and fails on a violation, including one hidden inside a function.
15. **Each equaliser owns its own band list.** `window.StudioEq` is the first
    panel's, `window.StudioEq2` is the second's, and neither may write the
    other. They are separate devices that cascade — a single shared list would
    make each panel overwrite the other's knob on its next publish, which
    looks like a knob that will not stay put rather than like a bug.
16. **Only the first equaliser trims.** Auto gain compensation is computed for
    the whole monitor path and applied once, before EQ 1's filters. A second
    trim on EQ 2 would attenuate twice and deliver a monitor quieter than the
    source, which reads as "the second EQ sounds wrong".
17. **The rack is a router of `{input, output}` blocks.** A device that is not
    patched is absent from the graph, not bypassed inside it. Keep new devices
    as blocks so back-panel cabling stays a change to the router alone.

---

## Data contracts

**`audio-analysis/v1`** — what `analyze.py` emits and everything else consumes:

```
schema, targets{integrated_lufs, true_peak_dbtp}, tempo{bpm, confidence, meter,
beat_times}, key{name, confidence, alternatives}, metadata, measures, loudness
{momentary, short_term}, envelopes{channels[{peak, rms, peak_db, rms_db}]},
spectrogram{db, shape, layout:"freq-major", freqs, times}, spectrum{freqs, db,
bands}, codec{cutoff_hz, confidence, lossy_suspected, verdict}, clipping, stereo,
timeline[{time_s, time, severity, title, detail}]
```

Every field is optional to a consumer. Never throw on a missing one.

**Browser globals** — the seam between `studio.js` and `widgets/`:

| Global | Owner | Shape |
|---|---|---|
| `window.engine` | studio.js | the audio graph; `buildEq`/`updateEq`/`setEqBypass`/`setEqTrim`, the second EQ's `eq2Enabled`/`buildEq2`/`updateEq2`/`rebuildEq2`/`setEq2Bypass`, and for the rack `rackEnabled`/`buildRack`/`updateRack`/`rebuildRack`/`setRackBypass`/`rackReduction`/`rackApprox` |
| `window.StudioRack` | widgets/maximizer.js | `{settings}` — one key per `maximize.py` CLI flag, same names |
| `window.StudioEq2` | widgets/equalizer2.js | `{bands}` — the SECOND equaliser, a device of its own. Never written by the first. |
| `window.StudioAnalysis` | studio.js | the raw analysis object, as loaded |
| `window.StudioMeters` | widgets/tray.js | `{mount, render, reset, tray, meters}` |
| `window.StudioEq` | widgets/equalizer.js | `{bands:[{id,type,freq,gain,q}], preset}` |
| `studio-eq-restore` | event | `{detail:{bands}}` — workspaces restoring an EQ |

`type` must always be a valid `BiquadFilterNode` type string; `studio.js` hands
it straight to WebAudio.

---

## Working here

- **Run the tests.** `./.venv/bin/python -m unittest discover -s tests -t .`
  from the repo root. 816, all passing, 92% covered. Keep it that way.
- **Measure, do not assume.** Most of the bugs found here were invisible to the
  test that was supposed to catch them: a canvas that drew but was too small to
  read, a preset that emitted a chain nobody ran, a detector validated only on
  synthetic input. If a claim can be measured, measure it.
- **Look at the screenshot.** Several real defects were caught only by eye —
  lit-pixel counts cannot tell "correct" from "tiny but non-blank".
- **The CLI is the authority.** If the page and the CLI disagree, the page is
  wrong.
- **Asset paths come from `paths.py`.** The browser page, the song template,
  the `.env` and the scripts `serve.py` runs as subprocesses are all asked for
  there, with an environment override apiece. Do not write `Path(__file__)` to
  find an asset: five call sites each carried that assumption, and every one of
  them breaks when a module moves.
