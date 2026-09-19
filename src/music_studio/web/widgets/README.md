# widgets/ — the Music Studio meter bank

These files were one 4,200-line `meters.js` (plus `maximizer.js`, added later). Same code, same behaviour, split
so that each instrument is a file you can open on its own.

## The files, in load order

Order matters. Each file uses what the ones above it defined, and `tray.js` names
every meter factory, so it has to run last.

| # | File | What it is |
|---|---|---|
| 1 | `core.js` | Shared helpers: canvas fitting for the device pixel ratio, the two colour maps, the log frequency scale, number and time formatting, `localStorage` access that survives a private window, and the readers that pull loudness, envelopes, targets and codec facts out of an analysis JSON. Depends on nothing. |
| 2 | `knob.js` | The rotary knob control — a knurled cap with an arc showing its value, drawn on a canvas. Drag vertically, shift for fine, double-click for the default. |
| 3 | `fader.js` | The slide fader, plus `roundRect` (Safari shipped `ctx.roundRect` late enough that a page opened from a disk cannot assume it). |
| 4 | `biquad.js` | RBJ cookbook filter coefficients and their magnitude response. The same maths ffmpeg and `BiquadFilterNode` use, so the drawn curve and the audible filter agree by construction. Depends on nothing but `Math`. |
| 5 | `loudness-over-time.js` | Short-term LUFS across the track against the delivery target. |
| 6 | `goniometer.js` | The vectorscope: L against R rotated 45°, with phosphor persistence. |
| 7 | `spectrum.js` | Spectrum and spectrogram behind one selector, marking a codec brick wall where the analysis found one. |
| 8 | `dynamics.js` | Crest factor and loudness range over the track. |
| 9 | `equalizer.js` | The equaliser: presets, the band bank, the draggable response curve, the ffmpeg chain. Publishes `window.StudioEq`. Uses 1–4. |
| 10 | `equalizer2.js` | A SECOND 5-band parametric, rack-mounted, cascading after the first. Publishes `window.StudioEq2` and never touches `window.StudioEq`. Uses 1–4. |
| 11 | `maximizer.js` | The mastering suite: compressor, stereo imager, maximizer and soft clip, live and patchable. Publishes `window.StudioRack`. Presets and defaults are copied from `maximize.py` and must stay identical to it. Uses 1–2. |
| 12 | `tray.js` | The tray (which meters are on the bench, in what order, persisted), the mount/render/reset plumbing, and the self-drive loop. Publishes `window.StudioMeters`. Uses all of the above. |

`index.html` loads them in exactly this order, after `studio.js`.

## How the files see each other

Each file is its own IIFE over one shared namespace object:

```js
(function (__W) {
'use strict';
  /* ... */
Object.assign(__W, { Knob });          // publish what this file defines
})(window.__studioWidgets || (window.__studioWidgets = {}));
```

A file reaches another file's symbols through `__W`: `__W.elem('div')`,
`__W.Knob(opts)`, `__W.Fader(...)`. Nothing else leaks. The only globals are the four that were
always intended — `window.StudioMeters`, `window.StudioEq`, `window.StudioEq2` and `window.StudioRack` — plus
`window.__studioWidgets` itself, which is the transport and is not part of the
public interface.

The parameter is named `__W` rather than something short like `S` for a concrete
reason: the original code uses `S` and `W` as ordinary local variable names (`const
S = o.size` in the knob's paint, `const W = o.width` in the fader's). A wrapper
parameter called `S` is shadowed inside those functions, and `S.hasArea(...)` then
fails with "S.hasArea is not a function" at runtime while still parsing cleanly.
`__W` appears nowhere in the original source, so it cannot be shadowed.

**References go through `__W` at the point of use, never destructured at the top of a
file.** That is not a style preference, it is the thing that makes the split work:
`__W` fills up progressively as the scripts load, so a
`const { LoudnessOverTime } = __W`
at the top of `tray.js` would capture `undefined` for anything defined later, and
would break the moment the load order changed. Writing `__W.LoudnessOverTime` at call
time reads the property when the call happens, by which point every file has run.

## Why classic scripts and not ES modules

The studio has to open by double-clicking `index.html` — straight from `file://`,
with no server and no build step. Under `file://` a browser treats every file as a
distinct opaque origin, so `import` is blocked by CORS and a `<script type="module">`
page loads nothing at all. Classic `<script>` tags have no such restriction. That
constraint is the whole reason for the IIFE-plus-namespace arrangement above: it is
what ES modules would have given for free, done with what `file://` actually allows.

## studio.js is now five files too

It was 5,591 lines until 2026-09-19, when it became `studio-core.js` (helpers,
VU ballistics, loudness), `studio-draw.js`, `studio-engine.js`,
`studio-verdicts.js`, and `studio.js` holding the wiring. They load in that
order, before this directory.

Two measurements made that tractable after three failed attempts. **`studio.js`
writes function bodies UNINDENTED**, so `const s` at column 0 is usually a
local — a line-based scan reports 228 top-level declarations where there are
75, and any sed-driven tool built on indentation corrupts the file. And only 31
declarations are referenced outside their own section, flowing one way.

`tests/test_web_assets.py` (Python, in the main suite) now fails if two scripts
declare the same top-level name, which is the failure described below.

## Why the IIFEs, and why they cannot be dropped

`studio.js` is **not** wrapped in an IIFE — it declares `clamp`, `lerp`, `INFERNO`,
`FMIN`, `SPEC_LABELS`, `fmtTime`, `fmtLu`, `hasArea`, `fitCanvas`, `fToT`, `fmtHz`
and more at genuine top-level script scope. Several of those names are also used
here, with different definitions.

Classic scripts share one global scope, and a top-level `const` in one script
collides with the same name in another: `Identifier 'clamp' has already been
declared`, and the second script never runs. The single IIFE around the old
`meters.js` was what kept the two files apart. Every file here keeps its own, for
the same reason. Do not remove them, and do not add a top-level declaration outside
one.

## The sizes of things

Measured from the live page, not intended. A control that is wider than it
needs to be reads as a gap, and the eye takes the gap for part of the control.

| Thing | Width | Where |
|---|---|---|
| Knob face | **38 px** | `knob.js`, `opts.size`; the same in every panel |
| Fader face | **32 px** (53 px box, 139 tall) | `fader.js` |
| EQ knob row | **99 px** | knob + a 8.6ch field |
| Rack knob cell | **116 px** | knob + a 9.6ch field — one character longer, because `-18.0 dB` is nine and a threshold that drops its unit is a number you cannot act on |
| Panel | 925 px at a 1480 px window | one card per row |

The rack's cell was 200 px until 2026-09-17: 38 px of knob plus 60 px of field
left **102 px of air, half of every row**, sitting between each knob and the
label naming it. Cells are now sized to the control rather than to a fraction
of the panel, `auto-fill` packs as many as fit, and the slack goes to the right
margin where nobody sees it. Six knobs per row instead of four; the rack went
from about 1100 px tall to 655.

The knob canvases DO scale for the device pixel ratio — `knob.js` calls
`fitCanvas`, and at `devicePixelRatio: 2` the 38 px face carries a 76 px
buffer. A 1:1 buffer measured in headless Chromium is that browser reporting
`devicePixelRatio: 1`, not a bug to fix.

## Changing things

- **Adding a symbol another file needs:** declare it as usual, add it to that file's
  `Object.assign(__W, { ... })`, and reference it as `__W.name` from the other file.
- **Adding a meter:** write `widgets/<name>.js` on the same pattern, publish its
  factory onto `__W`, add a `<script>` tag before `tray.js`, and add an entry to
  `METERS` in `tray.js`.
- **Load order:** anything new goes before `tray.js`.
- The five built-in EQ preset chains in `equalizer.js` are copied from `master.py`'s
  `EQ_PRESETS` and must stay byte-identical to them. The same rule binds
  `maximizer.js`'s `RACK_DEFAULTS` and `RACK_PRESETS` to `maximize.py`'s `Settings`
  and `PRESETS`: the emitted `--preset loud` is a promise that the render matches the
  preview. There is a checker for this — see STATUS.md.
