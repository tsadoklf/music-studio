/* ==========================================================================
   goniometer.js — the vectorscope
   --------------------------------------------------------------------------
   L against R rotated 45 degrees and drawn with phosphor persistence: mono
   reads as a vertical line, anything that will cancel in mono lies down flat.
   Persistence is a dark wash over the previous frame rather than a clear,
   which is what makes a moving signal leave a trail instead of flickering.

   Depends on: core.js. Registered in the tray by tray.js.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ------------------------------------------------------------------ 4.2 --
   Goniometer — a Lissajous vectorscope with phosphor persistence.

   L and R are rotated 45° so the display reads the way an engineer expects:
   mono is a vertical line, a wide image spreads horizontally, and material
   that will cancel in mono lies down flat. Persistence is a dark wash over
   the previous frame rather than a clear, which is what makes a moving
   signal leave a trail instead of flickering.
   ========================================================================= */

function Goniometer(host) {
  const cv = __W.elem('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Goniometer: left against right, rotated 45 degrees');
  const wrap = __W.elem('div', 'scope scope--square');
  wrap.appendChild(cv);

  const side = __W.elem('div', 'gonio-side');
  const readCorr = __W.elem('div', 'gonio-read');
  readCorr.innerHTML = '<span class="k">Correlation</span><span class="v">—</span>';
  const readWidth = __W.elem('div', 'gonio-read');
  readWidth.innerHTML = '<span class="k">Width</span><span class="v">—</span>';
  const note = __W.elem('p', 'gonio-note',
    'Vertical is mono. A horizontal spread is a wide image; a flat horizontal ' +
    'figure is out of phase and will thin out on a phone speaker.');
  side.appendChild(readCorr);
  side.appendChild(readWidth);
  side.appendChild(note);

  const row = __W.elem('div', 'gonio');
  row.appendChild(wrap);
  row.appendChild(side);
  host.appendChild(row);

  /* The trace lives in its own buffer so persistence survives a resize of
     the visible canvas and never depends on the display frame rate. */
  const buf = document.createElement('canvas');
  buf.width = buf.height = 320;
  const bctx = buf.getContext('2d');
  let dirty = false;

  function clearBuf() {
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.fillStyle = '#05060a';
    bctx.fillRect(0, 0, buf.width, buf.height);
    dirty = false;
  }
  clearBuf();

  const S = buf.width;
  const C = S / 2;
  const R = S * 0.46;

  /** Plot one L/R pair. The 45° rotation is folded into the mapping. */
  /* Snapped to whole pixels deliberately. A 1.4 px rect at a fractional
     coordinate is antialiased across four pixels, so a dot drawn at alpha
     0.3 lands as four at roughly 0.09 and the trace disappears; on the pixel
     grid the same dot is the dot that was asked for. */
  function plot(l, r, alpha) {
    const x = (C + (l - r) * R * Math.SQRT1_2) | 0;
    const y = (C - (l + r) * R * Math.SQRT1_2) | 0;
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    bctx.fillStyle = `rgba(255,190,110,${alpha})`;
    bctx.fillRect(x, y, 2, 2);
  }

  function fade() {
    bctx.fillStyle = 'rgba(5,6,10,0.16)';
    bctx.fillRect(0, 0, S, S);
  }

  /* When nothing is playing the scope still has to say something true about
     the file. A correlation and a width give a representative figure: a
     rotated ellipse whose narrowness is the correlation and whose spread is
     the width, traced once and left standing. */
  let staticSig = '';
  function drawStatic(corr, width) {
    const sig = corr.toFixed(3) + '/' + width.toFixed(3);
    if (sig === staticSig) return;
    staticSig = sig;
    clearBuf();
    const c = __W.clamp(corr, -1, 1);
    // A correlation of 1 is a line along the mono axis; 0 is a circle; -1 is
    // a line across it. Map that to the two semi-axes of an ellipse.
    const along = 0.72;
    const across = __W.clamp(Math.sqrt(Math.max(0, 1 - Math.abs(c))) * 0.62 +
                         width * 0.18, 0.02, 0.86);
    const tilt = c < 0 ? Math.PI / 2 : 0;
    for (let i = 0; i < 2600; i++) {
      const th = (i / 2600) * Math.PI * 2;
      // a little radial scatter, so it reads as a trace and not a drawn oval
      const jitter = 0.86 + Math.sin(i * 12.9898) * 0.07 + Math.sin(i * 4.1414) * 0.06;
      const u = Math.cos(th) * along * jitter;
      const v = Math.sin(th) * across * jitter;
      const m = u * Math.cos(tilt) - v * Math.sin(tilt);   // mono axis
      const s = u * Math.sin(tilt) + v * Math.cos(tilt);   // side axis
      // back out L and R from mid/side so the same plot() mapping applies
      plot((m + s) / 2, (m - s) / 2, 0.22);
    }
    dirty = true;
  }

  function render(state) {
    const w = __W.boxWidth(cv, 0);
    const size = __W.clamp(w, 0, 280);
    if (!__W.hasArea(size, size)) return;

    const live = (state && state.live) || {};
    const a = state && state.analysis;
    const stereo = (a && a.stereo) || {};

    const playing = !!(state && state.playing);
    const sampL = live.samplesL, sampR = live.samplesR;

    if (playing && sampL && sampR && sampL.length) {
      fade();
      const n = Math.min(sampL.length, sampR.length);
      // Cap the plotted points: a 2048-sample block at 60 fps is already more
      // dots than the display can resolve, and the whole block adds nothing
      // but time.
      const stride = Math.max(1, Math.floor(n / 1400));
      for (let i = 0; i < n; i += stride) plot(sampL[i], sampR[i], 0.5);
      dirty = true;
      staticSig = '';
    } else {
      /* The static path runs every frame and lets drawStatic's own signature
         check decide whether to redraw. Gating it on `dirty` instead — as an
         earlier version did — meant an idle frame set the flag and no later
         frame could ever draw the figure once an analysis did arrive. */
      const corr = isFinite(__W.num(live.correlation)) ? __W.num(live.correlation)
        : isFinite(__W.num(stereo.correlation)) ? __W.num(stereo.correlation) : NaN;
      const width = isFinite(__W.num(stereo.width)) ? __W.num(stereo.width) : 0.5;
      if (isFinite(corr)) {
        drawStatic(corr, width);
      } else if (staticSig !== 'idle') {
        clearBuf();
        dirty = true;
        staticSig = 'idle';
      }
    }

    /* --- blit, then the graticule over the top ------------------------- */
    const ctx = __W.fitCanvas(cv, size, size);
    cv.style.width = size + 'px';
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(buf, 0, 0, S, S, 0, 0, size, size);

    const cx = size / 2, cy = size / 2, rad = size * 0.46;

    /* faint circle grid */
    ctx.strokeStyle = 'rgba(168,137,78,0.22)';
    ctx.lineWidth = 1;
    for (const f of [0.34, 0.67, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, rad * f, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* the L and R diagonal axes, and the mono/side cross */
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(168,137,78,0.34)';
    ctx.beginPath();
    ctx.moveTo(cx - rad * 0.707, cy + rad * 0.707);
    ctx.lineTo(cx + rad * 0.707, cy - rad * 0.707);
    ctx.moveTo(cx - rad * 0.707, cy - rad * 0.707);
    ctx.lineTo(cx + rad * 0.707, cy + rad * 0.707);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(120,122,112,0.30)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad);
    ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy);
    ctx.stroke();

    ctx.font = `400 9.5px ${__W.ENGRAVE}`;
    ctx.fillStyle = 'rgba(168,137,78,0.8)';
    ctx.letterSpacing = '0.18em';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('L', cx - rad * 0.74, cy - rad * 0.74);
    ctx.textAlign = 'right';
    ctx.fillText('R', cx + rad * 0.74, cy - rad * 0.74);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(130,132,122,0.7)';
    ctx.fillText('M', cx, cy - rad + 8);
    ctx.fillText('S', cx + rad - 8, cy);
    ctx.letterSpacing = '0em';

    /* --- the side readouts --------------------------------------------- */
    const corrNow = playing && isFinite(__W.num(live.correlation))
      ? __W.num(live.correlation)
      : __W.num(stereo.correlation);
    const vCorr = readCorr.querySelector('.v');
    vCorr.textContent = isFinite(corrNow) ? __W.sgn(corrNow, 2) : '—';
    vCorr.className = 'v ' + (!isFinite(corrNow) ? ''
      : corrNow < 0 ? 'is-bad' : corrNow < 0.3 ? 'is-warn' : 'is-ok');

    const wNow = __W.num(stereo.width);
    readWidth.querySelector('.v').textContent =
      isFinite(wNow) ? wNow.toFixed(2) : '—';
  }

  return {
    render,
    reset() {
      clearBuf();
      staticSig = '';
      readCorr.querySelector('.v').textContent = '—';
      readCorr.querySelector('.v').className = 'v';
      readWidth.querySelector('.v').textContent = '—';
      /* Clearing the trace buffer alone would leave the last figure standing
         on the visible canvas until the next frame happens to blit — and if
         the host stops driving after a reset, forever. Repaint the empty face
         and its graticule here, which is what a reset should look like. */
      render({ analysis: null, live: {}, playhead: -1, playing: false });
    },
  };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { Goniometer });

})(window.__studioWidgets || (window.__studioWidgets = {}));
