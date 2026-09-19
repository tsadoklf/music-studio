/* studio-verdicts.js — delivery targets and the whole-file verdicts
 *
 * One of the five files the single 5,591-line studio.js became. Same code,
 * same behaviour, in a file you can open on its own.
 *
 * The file is its own IIFE over `window.__studio` (`__S` inside), and
 * publishes what other files need in the Object.assign at the foot.
 *
 * Cross-file names are read as `__S.name` AT THE POINT OF USE, never
 * destructured at the top of the file: `__S` fills up as the scripts load,
 * so `const { drawVu } = __S` here would capture undefined for anything a
 * later file defines. The IIFE is not optional either — these are classic
 * scripts sharing one global scope, and widgets/*.js declare several of the
 * same names with different bodies. See README.md.
 */
(function (__S) {
'use strict';

/* ==========================================================================
   6. Verdicts
   ========================================================================== */

/* Delivery targets. These are defaults for the audio-only path, where nothing
 * tells us what the delivery target is. An analyze.py JSON carries a `targets` block
 * read from master.py, and loading one overwrites these — so changing
 * DEFAULT_LUFS in master.py reaches this page instead of leaving it quietly
 * showing a number nobody targets any more. */
__S.TARGET_LUFS = -14;
__S.TP_CEILING = -1.0;
let TARGET_SOURCE = 'default';

function applyTargets(t) {
  if (!t || typeof t !== 'object') return;
  if (Number.isFinite(t.integrated_lufs)) __S.TARGET_LUFS = t.integrated_lufs;
  if (Number.isFinite(t.true_peak_dbtp)) __S.TP_CEILING = t.true_peak_dbtp;
  TARGET_SOURCE = t.source || 'analysis';
  const el = document.getElementById('delivery-target');
  if (el) {
    el.textContent =
      `delivery target ${__S.TARGET_LUFS} LUFS / ${__S.TP_CEILING.toFixed(1)} dBTP`;
  }
}

function verdictLoudness(integrated) {
  if (!isFinite(integrated)) {
    return { state: 'idle', pill: 'no signal',
      body: 'Play the track, or load an analysis, to measure integrated loudness.' };
  }
  const d = integrated - __S.TARGET_LUFS;
  const ad = Math.abs(d);
  const num = `<b>${__S.fmtLu(integrated, 1)} LUFS</b>`;
  const off = `<b>${d >= 0 ? '+' : '−'}${ad.toFixed(1)} LU</b>`;
  if (ad <= 0.5) {
    return { state: 'ok', pill: 'on target',
      body: `${num}, ${off} from the −14 LUFS target. Ready to upload.` };
  }
  if (ad <= 1.5) {
    return { state: 'warn', pill: `${d >= 0 ? 'hot' : 'quiet'} by ${ad.toFixed(1)} LU`,
      body: `${num}. Within a level YouTube will normalise without audible harm, ` +
            `but a re-master gets it exact.` };
  }
  return { state: 'bad', pill: `${d >= 0 ? 'too hot' : 'too quiet'}`,
    body: `${num}, ${off} off target. ` +
      (d > 0
        ? 'YouTube will turn this down on playback, so the extra level buys nothing and costs dynamics.'
        : 'This will sit noticeably quieter than neighbouring tracks. Re-run mastering before upload.') };
}

function verdictClipping(overs, truePeak) {
  if (!isFinite(truePeak)) {
    return { state: 'idle', pill: 'not measured',
      body: `Sample and true peak are read while the track plays. Ceiling is <b>−1.0 dBTP</b>.` };
  }
  const tp = `<b>${__S.fmtLu(truePeak, 1)} dBTP</b>`;
  if (truePeak > 0) {
    return { state: 'bad', pill: `${overs} over${overs === 1 ? '' : 's'}`,
      body: `True peak ${tp} — above full scale. Lossy encoding will clip this ` +
            `audibly even though the WAV sounds clean. Limit before upload.` };
  }
  if (truePeak > __S.TP_CEILING) {
    return { state: 'warn', pill: 'above ceiling',
      body: `True peak ${tp}, over the −1.0 dBTP ceiling. There is not enough ` +
            `headroom for the encoder.` };
  }
  return { state: 'ok', pill: 'clean',
    body: `True peak ${tp}, inside the −1.0 dBTP ceiling. No clipping detected.` };
}

function verdictCutoff(hz, sourceKind) {
  if (!hz) {
    return { state: 'idle', pill: 'watching',
      body: 'Full-band content up to Nyquist so far. A hard ceiling near ' +
            '<b>16 kHz</b> would mean the source has already been through a lossy codec.' };
  }
  const k = (hz / 1000).toFixed(1);
  if (hz >= 19000) {
    return { state: 'ok', pill: 'full band',
      body: `Content extends to <b>${k} kHz</b>. This looks like an untouched ` +
            `WAV, not a re-encode.` };
  }
  // Measured encoder cutoffs (LAME/AAC round-trips, 2026-09-15): 128k lands
  // near 15-16.6 kHz, 192k near 18.7 kHz, 320k near 20 kHz. So 18 kHz is the
  // honest line between "high bitrate, barely audible" and "128k, a real loss".
  if (hz >= 18000) {
    return { state: 'warn', pill: `${k} kHz wall`,
      body: `Energy stops at <b>${k} kHz</b> — the signature of a high-bitrate ` +
            `MP3 or AAC. Fine to publish, but master from the WAV if you still have it.` };
  }
  if (hz >= 15000) {
    return { state: 'bad', pill: `${k} kHz wall`,
      body: `Energy stops at <b>${k} kHz</b> — around what a <b>128 kbps</b> encode ` +
            `leaves. The top octave is gone and no EQ restores it. Master from the ` +
            `original WAV rather than publishing this.` };
  }
  return { state: 'bad', pill: `${k} kHz wall`,
    body: `A brick wall at <b>${k} kHz</b> means a low-bitrate lossy source. ` +
          `Re-encoding it for upload stacks a second generation of artefacts.` };
}

function verdictPhase(corr) {
  if (!isFinite(corr)) {
    return { state: 'idle', pill: 'no signal', body: 'Stereo correlation reads during playback.' };
  }
  const v = `<b>${(corr >= 0 ? '+' : '−') + Math.abs(corr).toFixed(2)}</b>`;
  if (corr < 0) {
    return { state: 'bad', pill: 'out of phase',
      body: `Correlation ${v}. The channels partly cancel — this track will lose ` +
            `body on a phone speaker or any mono playback.` };
  }
  if (corr < 0.3) {
    return { state: 'warn', pill: 'very wide',
      body: `Correlation ${v}. A wide image, but check it in mono before publishing.` };
  }
  return { state: 'ok', pill: 'mono-safe',
    body: `Correlation ${v}. The stereo image survives a mono fold-down.` };
}


/* Published for the files that load after this one. */
Object.assign(__S, { applyTargets, verdictClipping, verdictCutoff, verdictLoudness, verdictPhase });
})(window.__studio || (window.__studio = {}));
