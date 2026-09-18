#!/usr/bin/env python3
"""Tests for analyze.py, against signals whose right answers we know.

Real audio is no use for testing a measurement tool: you cannot tell a bug from
a track. So every fixture here is synthesised, which means the expected number
is arithmetic rather than opinion — a 1 kHz sine at -20 dBFS in both channels
must read -20 LUFS, a signal lowpassed at 16 kHz must show a cutoff at 16 kHz,
and a sine driven to 1.5 and clipped must show exactly the runs we put there.

Run:
    ./.venv/bin/python -m unittest test_analyze.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import analyze
from analyze import (
    AnalyzeError,
    average_spectrum,
    channel_envelopes,
    detect_clipping,
    detect_cutoff,
    integrated_loudness,
    k_weighting_coefficients,
    loudness_series,
    spectrogram,
    stereo_analysis,
)

RATE = 48000

# The BS.1770-4 published coefficients, at 48 kHz. Our filter is re-derived
# from the analogue prototype, so matching this table is a real check.
BS1770_STAGE1_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
BS1770_STAGE1_A = [1.0, -1.69065929318241, 0.73248077421585]
BS1770_STAGE2_B = [1.0, -2.0, 1.0]
BS1770_STAGE2_A = [1.0, -1.99004745483398, 0.99007225036621]


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

def sine(freq: float, seconds: float, amplitude_db: float,
         rate: int = RATE, channels: int = 2):
    """A sine at a known peak amplitude, in every channel."""
    t = np.arange(int(round(seconds * rate))) / float(rate)
    wave = (10.0 ** (amplitude_db / 20.0)) * np.sin(2.0 * np.pi * freq * t)
    return np.column_stack([wave] * channels)


def clipped_sine(seconds: float = 2.0, drive: float = 1.5, rate: int = RATE):
    """A sine driven past full scale and hard-limited: guaranteed flat tops."""
    t = np.arange(int(round(seconds * rate))) / float(rate)
    wave = np.clip(drive * np.sin(2.0 * np.pi * 220.0 * t), -1.0, 1.0)
    return np.column_stack([wave, wave])


def band_limited_noise(cutoff_hz: float, seconds: float = 6.0,
                       rate: int = RATE, seed: int = 11):
    """White noise through a steep lowpass — a stand-in for a lossy codec.

    Order 10 Butterworth, applied forwards and backwards, gives a cliff of a
    few hundred dB per octave: steeper than any mix filter and comparable to
    what an encoder leaves.
    """
    from scipy import signal

    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, 0.1, (int(round(seconds * rate)), 2))
    sos = signal.butter(10, cutoff_hz, btype="low", fs=rate, output="sos")
    return signal.sosfiltfilt(sos, noise, axis=0)


def program_material(cutoff_hz: float | None = None, seconds: float = 8.0,
                     rate: int = RATE, seed: int = 23):
    """Noise shaped like real music, optionally through a steep lowpass.

    Flat noise through a lowpass is too easy a target: it has no spectral tilt
    and no resonances, so a detector can pass on it while being badly wrong on
    a record. This fixture has both. Pink-ish tilt (about -3 dB per octave)
    puts the treble genuinely tens of dB below the midrange before any codec is
    involved — which is what broke the first detector, since it read that tilt
    as the cliff — and a few resonant peaks give the spectrum the local
    shoulders and plateaus that a naive backward search latches onto.
    """
    from scipy import signal

    rng = np.random.default_rng(seed)
    n = int(round(seconds * rate))
    noise = rng.normal(0.0, 1.0, n)

    # Pink tilt, applied in the frequency domain so the slope is exact.
    spectrum = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(n, 1.0 / rate)
    tilt = np.ones_like(freqs)
    tilt[1:] = (freqs[1:] / 100.0) ** -0.5      # -3 dB per octave
    shaped = np.fft.irfft(spectrum * tilt, n=n)

    # Resonances: a bass note, a low-mid body, a presence peak. These create
    # the local maxima that a knee-walk can mistake for the top of a cliff.
    for centre, gain, q in ((110.0, 6.0, 8.0), (900.0, 4.0, 5.0),
                            (3500.0, 5.0, 6.0)):
        b, a = signal.iirpeak(centre, q, fs=rate)
        shaped = shaped + (10.0 ** (gain / 20.0) - 1.0) * signal.lfilter(b, a, shaped)

    if cutoff_hz is not None:
        sos = signal.butter(12, cutoff_hz, btype="low", fs=rate, output="sos")
        shaped = signal.sosfiltfilt(sos, shaped)

    shaped = shaped / (np.abs(shaped).max() or 1.0) * 0.7
    return np.column_stack([shaped, np.roll(shaped, 7)])


class TempWav:
    """Write an array to a temp wav and clean it up afterwards."""

    def __init__(self, data, rate: int = RATE, subtype: str = "PCM_24"):
        self.data, self.rate, self.subtype = data, rate, subtype

    def __enter__(self) -> Path:
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / "fixture.wav"
        sf.write(str(self.path), self.data, self.rate, subtype=self.subtype)
        return self.path

    def __exit__(self, *exc):
        self._dir.cleanup()
        return False


# --------------------------------------------------------------------------
# K-weighting and loudness
# --------------------------------------------------------------------------

class TestKWeighting(unittest.TestCase):

    def test_coefficients_match_the_published_48k_table(self):
        """Our re-derivation must reproduce BS.1770-4's own numbers."""
        (b1, a1), (b2, a2) = k_weighting_coefficients(48000)
        np.testing.assert_allclose(b1, BS1770_STAGE1_B, atol=1e-9)
        np.testing.assert_allclose(a1, BS1770_STAGE1_A, atol=1e-9)
        np.testing.assert_allclose(b2, BS1770_STAGE2_B, atol=1e-9)
        np.testing.assert_allclose(a2, BS1770_STAGE2_A, atol=1e-9)

    def test_coefficients_differ_at_44100(self):
        """The filter must be re-derived per rate, not reused from the table."""
        (b1_48, _), _ = k_weighting_coefficients(48000)
        (b1_44, _), _ = k_weighting_coefficients(44100)
        self.assertFalse(np.allclose(b1_48, b1_44))

    def test_shelf_gain_is_about_four_db(self):
        """Stage 1 must lift the treble by ~+4 dB and leave the bass alone."""
        from scipy import signal

        (b1, a1), _ = k_weighting_coefficients(RATE)
        freqs, response = signal.freqz(b1, a1, worN=[100.0, 10000.0], fs=RATE)
        gain_db = 20.0 * np.log10(np.abs(response))
        self.assertAlmostEqual(gain_db[0], 0.0, delta=0.3)
        self.assertAlmostEqual(gain_db[1], 4.0, delta=0.3)

    def test_highpass_rejects_subsonic(self):
        """Stage 2 must pull 10 Hz well down while passing 1 kHz."""
        from scipy import signal

        _, (b2, a2) = k_weighting_coefficients(RATE)
        freqs, response = signal.freqz(b2, a2, worN=[10.0, 1000.0], fs=RATE)
        gain_db = 20.0 * np.log10(np.abs(response))
        self.assertLess(gain_db[0], -15.0)
        self.assertAlmostEqual(gain_db[1], 0.0, delta=0.5)

    def test_rejects_nonsense_rate(self):
        with self.assertRaises(AnalyzeError):
            k_weighting_coefficients(0)


class TestIntegratedLoudness(unittest.TestCase):
    """The reference case: EBU Tech 3341 expects a stereo sine to read its own
    level. A 1 kHz sine at -20 dBFS peak in both channels is -20.0 LUFS."""

    def test_stereo_sine_reads_its_own_level(self):
        for level in (-20.0, -23.0, -10.0):
            with self.subTest(level=level):
                measured = integrated_loudness(sine(1000.0, 10.0, level), RATE)
                self.assertAlmostEqual(measured, level, delta=0.1)

    def test_mono_sine_reads_three_db_quieter(self):
        """Loudness sums channel power, so one channel is ~3 dB below two."""
        mono = sine(1000.0, 10.0, -20.0, channels=1)
        self.assertAlmostEqual(integrated_loudness(mono, RATE), -23.0, delta=0.15)

    def test_correct_at_44100(self):
        rate = 44100
        measured = integrated_loudness(sine(1000.0, 10.0, -20.0, rate=rate), rate)
        self.assertAlmostEqual(measured, -20.0, delta=0.15)

    def test_gain_change_moves_the_reading_by_the_same_amount(self):
        quiet = integrated_loudness(sine(1000.0, 8.0, -30.0), RATE)
        loud = integrated_loudness(sine(1000.0, 8.0, -20.0), RATE)
        self.assertAlmostEqual(loud - quiet, 10.0, delta=0.1)

    def test_relative_gate_ignores_a_silent_tail(self):
        """Ten seconds of tone plus ten of silence must still read as the tone."""
        tone = sine(1000.0, 10.0, -20.0)
        silence = np.zeros_like(tone)
        both = np.vstack([tone, silence])
        self.assertAlmostEqual(integrated_loudness(both, RATE), -20.0, delta=0.2)

    def test_silence_is_not_a_number(self):
        self.assertTrue(np.isnan(integrated_loudness(np.zeros((RATE * 2, 2)), RATE)))


class TestLoudnessSeries(unittest.TestCase):

    def test_momentary_tracks_a_step_change(self):
        """A quiet half then a loud half must show both levels in the curve."""
        quiet = sine(1000.0, 5.0, -30.0)
        loud = sine(1000.0, 5.0, -18.0)
        values, times = loudness_series(np.vstack([quiet, loud]), RATE, 0.400)

        self.assertGreater(values.size, 10)
        self.assertEqual(values.size, times.size)
        early = values[times < 4.0]
        late = values[times > 6.0]
        self.assertAlmostEqual(float(early.mean()), -30.0, delta=0.3)
        self.assertAlmostEqual(float(late.mean()), -18.0, delta=0.3)

    def test_short_term_window_gives_fewer_blocks(self):
        data = sine(1000.0, 12.0, -20.0)
        momentary, _ = loudness_series(data, RATE, 0.400)
        short_term, _ = loudness_series(data, RATE, 3.000)
        self.assertGreater(momentary.size, short_term.size)

    def test_shorter_than_one_block_is_empty_not_an_error(self):
        values, times = loudness_series(sine(1000.0, 0.1, -20.0), RATE, 0.400)
        self.assertEqual(values.size, 0)
        self.assertEqual(times.size, 0)


# --------------------------------------------------------------------------
# codec cutoff
# --------------------------------------------------------------------------

class TestCutoffDetection(unittest.TestCase):

    def _cutoff(self, data, rate: int = RATE):
        freqs, magnitude_db = average_spectrum(data, rate)
        return detect_cutoff(freqs, magnitude_db, rate)

    def test_finds_a_known_sixteen_kilohertz_lowpass(self):
        """The real case: a file that dies at 16 kHz has been through a codec."""
        result = self._cutoff(band_limited_noise(16000.0))
        self.assertAlmostEqual(result.cutoff_hz, 16000.0, delta=500.0)
        self.assertGreater(result.confidence, 0.5)
        self.assertIn("kHz", result.verdict)

    def test_finds_other_known_cutoffs(self):
        for target in (11025.0, 15000.0, 18500.0):
            with self.subTest(cutoff=target):
                result = self._cutoff(band_limited_noise(target))
                self.assertAlmostEqual(result.cutoff_hz, target, delta=500.0)
                self.assertGreater(result.confidence, 0.3)

    def test_a_cutoff_at_twenty_kilohertz_is_located_but_not_alarming(self):
        """The frequency is still reported; only the alarm is withheld."""
        result = self._cutoff(band_limited_noise(20000.0))
        self.assertAlmostEqual(result.cutoff_hz, 20000.0, delta=500.0)
        self.assertEqual(result.confidence, 0.0)
        self.assertIn("harmless", result.verdict)

    def test_full_bandwidth_noise_is_not_flagged(self):
        rng = np.random.default_rng(3)
        noise = rng.normal(0.0, 0.1, (RATE * 6, 2))
        result = self._cutoff(noise)
        self.assertGreater(result.cutoff_hz, 20000.0)
        self.assertLess(result.confidence, 0.33)

    def test_finds_the_cutoff_in_realistic_program_material(self):
        """The regression that matters: music-shaped input, not flat noise.

        An earlier detector compared everything to the 200 Hz - 2 kHz midrange.
        On flat noise that works; on material with a real spectral tilt the
        treble is already 20 dB down before any codec touches it, so the test
        tripped early and the answer came back near 8 kHz — the bottom of the
        search window — regardless of where the actual cliff was.
        """
        for target in (12000.0, 15500.0, 16000.0, 18000.0):
            with self.subTest(cutoff=target):
                result = self._cutoff(program_material(target))
                self.assertAlmostEqual(
                    result.cutoff_hz, target, delta=1000.0,
                    msg=f"expected ~{target} Hz, got {result.cutoff_hz}")
                self.assertGreater(result.confidence, 0.33)

    def test_program_material_cutoff_is_never_the_search_floor(self):
        """The specific failure signature: ~8 kHz no matter what the input is."""
        readings = [self._cutoff(program_material(c)).cutoff_hz
                    for c in (12000.0, 16000.0, 18000.0)]
        for value in readings:
            self.assertGreater(value, 9000.0)
        # Different inputs must give different answers.
        self.assertGreater(max(readings) - min(readings), 3000.0)

    def test_full_bandwidth_program_material_is_not_flagged(self):
        """Tilt and resonances alone must not read as a codec."""
        result = self._cutoff(program_material(None))
        self.assertFalse(result.confidence >= 0.33,
                         f"false positive at {result.cutoff_hz} Hz")

    def test_a_cutoff_above_hearing_is_reported_but_not_alarming(self):
        """48 kHz material routinely stops near 20 kHz. That harms nothing."""
        result = self._cutoff(program_material(20500.0, rate=48000), rate=48000)
        self.assertEqual(result.confidence, 0.0)
        self.assertIn("harmless", result.verdict)

    def test_gentle_rolloff_scores_low_confidence(self):
        """A first-order slope is a mix, not an encoder. Say so."""
        from scipy import signal

        rng = np.random.default_rng(5)
        noise = rng.normal(0.0, 0.1, (RATE * 6, 2))
        sos = signal.butter(1, 12000.0, btype="low", fs=RATE, output="sos")
        result = self._cutoff(signal.sosfilt(sos, noise, axis=0))
        self.assertLess(result.confidence, 0.66)


# --------------------------------------------------------------------------
# clipping
# --------------------------------------------------------------------------

class TestClipping(unittest.TestCase):

    def test_finds_samples_we_pinned_ourselves(self):
        """Plant exactly 7 consecutive full-scale samples and find exactly those."""
        data = sine(440.0, 1.0, -6.0)
        data[1000:1007, 0] = 1.0
        result = detect_clipping(data, RATE)

        self.assertGreaterEqual(result.clipped_samples, 7)
        self.assertEqual(result.runs, 1)
        self.assertEqual(result.longest_run, 7)
        self.assertEqual(result.worst[0]["start_sample"], 1000)
        self.assertEqual(result.worst[0]["channel"], 0)
        self.assertAlmostEqual(result.worst[0]["time"], 1000 / RATE, places=3)

    def test_finds_a_clipped_sine(self):
        """A sine driven to 1.5 and limited clips on every one of its cycles."""
        data = clipped_sine(seconds=2.0, drive=1.5)
        result = detect_clipping(data, RATE)
        self.assertGreater(result.clipped_samples, 1000)
        # 220 Hz for 2 s, both channels: two flat tops per cycle per channel.
        self.assertGreater(result.runs, 800)
        self.assertGreater(result.longest_run, 10)

    def test_clean_sine_does_not_clip(self):
        result = detect_clipping(sine(440.0, 1.0, -6.0), RATE)
        self.assertEqual(result.clipped_samples, 0)
        self.assertEqual(result.runs, 0)
        self.assertEqual(result.longest_run, 0)
        self.assertEqual(result.worst, ())

    def test_isolated_peaks_are_not_called_runs(self):
        """A single sample at full scale is not a flat top."""
        data = sine(440.0, 1.0, -6.0)
        data[500, 0] = 1.0
        data[9000, 1] = -1.0
        result = detect_clipping(data, RATE)
        self.assertEqual(result.clipped_samples, 2)
        self.assertEqual(result.runs, 0)

    def test_worst_offenders_are_sorted_longest_first(self):
        data = sine(440.0, 1.0, -6.0)
        data[1000:1005, 0] = 1.0
        data[5000:5020, 0] = 1.0
        data[8000:8009, 0] = 1.0
        result = detect_clipping(data, RATE)
        lengths = [w["samples"] for w in result.worst]
        self.assertEqual(lengths[:3], [20, 9, 5])


# --------------------------------------------------------------------------
# envelopes, spectrogram, stereo
# --------------------------------------------------------------------------

class TestEnvelopes(unittest.TestCase):

    def test_rms_of_a_sine_is_three_db_below_its_peak(self):
        data = sine(440.0, 3.0, -6.0)
        env = channel_envelopes(data, RATE)
        rms_db = np.array([v for v in env["channels"][0]["rms_db"] if v is not None])
        self.assertAlmostEqual(float(np.median(rms_db)), -9.0, delta=0.3)

    def test_one_entry_per_channel_and_the_cap_is_respected(self):
        env = channel_envelopes(sine(440.0, 30.0, -6.0), RATE, limit=500)
        self.assertEqual(len(env["channels"]), 2)
        for channel in env["channels"]:
            self.assertLessEqual(len(channel["peak"]), 500)
            self.assertEqual(len(channel["peak"]), len(channel["rms"]))

    def test_downsampling_keeps_the_peak(self):
        """A lone transient must survive reduction, or the meter lies."""
        data = np.zeros((RATE * 10, 2))
        data[RATE * 5, :] = 0.95
        env = channel_envelopes(data, RATE, limit=100)
        self.assertAlmostEqual(max(env["channels"][0]["peak"]), 0.95, places=2)


class TestSpectrogram(unittest.TestCase):

    def test_shape_matches_the_flat_array(self):
        result = spectrogram(sine(1000.0, 5.0, -12.0), RATE, bins=64, max_frames=50)
        bins, frames = result["shape"]
        self.assertLessEqual(bins, 64)
        self.assertLessEqual(frames, 50)
        self.assertEqual(len(result["db"]), bins * frames)
        self.assertEqual(len(result["freqs"]), bins)
        self.assertEqual(len(result["times"]), frames)

    def test_energy_lands_in_the_right_bin(self):
        """A 1 kHz tone must be loudest in the bin nearest 1 kHz."""
        result = spectrogram(sine(1000.0, 5.0, -12.0), RATE, bins=128, max_frames=40)
        bins, frames = result["shape"]
        db = np.array(result["db"]).reshape(bins, frames)
        loudest = int(np.argmax(db.mean(axis=1)))
        self.assertAlmostEqual(result["freqs"][loudest], 1000.0, delta=120.0)

    def test_values_are_rounded_to_one_decimal(self):
        result = spectrogram(sine(1000.0, 3.0, -12.0), RATE, bins=32, max_frames=20)
        for value in result["db"][:200]:
            self.assertEqual(value, round(value, 1))


class TestStereo(unittest.TestCase):

    def test_identical_channels_correlate_at_one(self):
        result = stereo_analysis(sine(440.0, 3.0, -12.0), RATE)
        self.assertAlmostEqual(result["correlation"], 1.0, places=3)
        self.assertEqual(result["note"], "effectively mono")
        self.assertAlmostEqual(result["balance_db"], 0.0, delta=0.05)

    def test_inverted_channels_correlate_at_minus_one(self):
        data = sine(440.0, 3.0, -12.0)
        data[:, 1] *= -1.0
        result = stereo_analysis(data, RATE)
        self.assertAlmostEqual(result["correlation"], -1.0, places=3)
        self.assertIn("out of phase", result["note"])

    def test_a_louder_left_shows_as_positive_balance(self):
        data = sine(440.0, 6.0, -20.0)
        data[:, 0] *= 10.0 ** (6.0 / 20.0)
        result = stereo_analysis(data, RATE)
        self.assertAlmostEqual(result["balance_db"], 6.0, delta=0.2)

    def test_mono_file_is_reported_not_crashed(self):
        result = stereo_analysis(sine(440.0, 1.0, -12.0, channels=1), RATE)
        self.assertFalse(result["stereo"])


# --------------------------------------------------------------------------
# the whole document, and the CLI
# --------------------------------------------------------------------------

class TestAnalyzeDocument(unittest.TestCase):

    def test_document_is_complete_and_json_serialisable(self):
        with TempWav(sine(1000.0, 6.0, -20.0)) as path:
            result = analyze.analyze(path, spectrogram_frames=100,
                                     spectrogram_bins=64, use_ffmpeg=False)

        for key in ("schema", "metadata", "measures", "loudness", "envelopes",
                    "spectrogram", "spectrum", "codec", "clipping", "stereo"):
            self.assertIn(key, result)

        meta = result["metadata"]
        self.assertEqual(meta["sample_rate"], RATE)
        self.assertEqual(meta["channels"], 2)
        self.assertEqual(meta["bit_depth"], 24)
        self.assertAlmostEqual(meta["duration"], 6.0, places=2)

        self.assertAlmostEqual(result["measures"]["integrated_lufs"], -20.0, delta=0.15)
        self.assertAlmostEqual(result["measures"]["peak"], -20.0, delta=0.1)
        # A sine's crest factor is 3.01 dB, by definition.
        self.assertAlmostEqual(result["measures"]["crest_factor"], 3.01, delta=0.1)

        json.dumps(result)  # must not raise

    def test_floats_are_rounded_not_seventeen_digits(self):
        with TempWav(band_limited_noise(16000.0, seconds=4.0)) as path:
            result = analyze.analyze(path, spectrogram_frames=80,
                                     spectrogram_bins=32, use_ffmpeg=False)
        text = json.dumps(result)
        self.assertNotIn("0000000000", text)
        self.assertLess(len(text), 900_000)

    def test_a_lossy_looking_file_is_flagged_end_to_end(self):
        with TempWav(band_limited_noise(16000.0)) as path:
            result = analyze.analyze(path, spectrogram_frames=60,
                                     spectrogram_bins=32, use_ffmpeg=False)
        self.assertTrue(result["codec"]["lossy_suspected"])
        self.assertAlmostEqual(result["codec"]["cutoff_hz"], 16000.0, delta=500.0)

    def test_a_clipped_file_is_flagged_end_to_end(self):
        with TempWav(clipped_sine()) as path:
            result = analyze.analyze(path, spectrogram_frames=60,
                                     spectrogram_bins=32, use_ffmpeg=False)
        self.assertTrue(result["clipping"]["clipping_suspected"])
        self.assertGreater(result["clipping"]["runs"], 100)
        self.assertGreater(len(result["clipping"]["worst"]), 0)

    def test_sixteen_bit_depth_is_reported(self):
        with TempWav(sine(1000.0, 2.0, -20.0), subtype="PCM_16") as path:
            result = analyze.analyze(path, spectrogram_frames=40,
                                     spectrogram_bins=32, use_ffmpeg=False)
        self.assertEqual(result["metadata"]["bit_depth"], 16)

    def test_missing_file_raises_analyze_error(self):
        with self.assertRaises(AnalyzeError):
            analyze.analyze(Path("/nonexistent/nope.wav"), use_ffmpeg=False)

    def test_a_clip_shorter_than_one_fft_segment_still_works(self):
        """100 samples is not music, but it must not raise out of scipy."""
        with TempWav(np.zeros((100, 2))) as path:
            result = analyze.analyze(path, use_ffmpeg=False)
        self.assertEqual(result["metadata"]["frames"], 100)
        self.assertEqual(result["loudness"]["momentary"]["lufs"], [])
        json.dumps(result)

    def test_silence_produces_a_document_rather_than_a_crash(self):
        with TempWav(np.zeros((RATE * 2, 2))) as path:
            result = analyze.analyze(path, spectrogram_frames=40,
                                     spectrogram_bins=32, use_ffmpeg=False)
        self.assertIsNone(result["measures"]["integrated_lufs"])
        self.assertEqual(result["clipping"]["clipped_samples"], 0)
        json.dumps(result)

    def test_a_mono_file_analyses_end_to_end(self):
        with TempWav(sine(440.0, 3.0, -12.0, channels=1)) as path:
            result = analyze.analyze(path, spectrogram_frames=40,
                                     spectrogram_bins=32, use_ffmpeg=False)
        self.assertEqual(result["metadata"]["channels"], 1)
        self.assertFalse(result["stereo"]["stereo"])
        self.assertEqual(len(result["envelopes"]["channels"]), 1)

    def test_a_low_sample_rate_file_analyses_end_to_end(self):
        """8 kHz means a 4 kHz Nyquist, below the codec search floor."""
        rate = 8000
        data = sine(300.0, 3.0, -12.0, rate=rate)
        with TempWav(data, rate=rate, subtype="PCM_16") as path:
            result = analyze.analyze(path, spectrogram_frames=40,
                                     spectrogram_bins=32, use_ffmpeg=False)
        self.assertEqual(result["metadata"]["sample_rate"], rate)
        self.assertEqual(result["codec"]["confidence"], 0.0)


class TestCli(unittest.TestCase):

    def test_writes_a_json_file_and_returns_zero(self):
        with TempWav(sine(1000.0, 4.0, -20.0)) as path:
            out = path.parent / "analysis.json"
            code = analyze.main([
                "--in", str(path), "--out", str(out), "--indent", "2",
                "--no-ffmpeg", "--spectrogram-frames", "50",
                "--spectrogram-bins", "32",
            ])
            self.assertEqual(code, 0)
            self.assertTrue(out.is_file())
            document = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(document["schema"], "audio-analysis/v1")
            self.assertAlmostEqual(
                document["measures"]["integrated_lufs"], -20.0, delta=0.15)

    def test_missing_file_returns_one(self):
        self.assertEqual(
            analyze.main(["--in", "/nonexistent/nope.wav", "--no-ffmpeg"]), 1)

    def test_stdout_is_valid_json(self):
        """Nothing but JSON may reach stdout, or `analyze.py | jq` breaks."""
        with TempWav(sine(1000.0, 3.0, -20.0)) as path:
            proc = subprocess.run(
                [sys.executable, str(Path(__file__).resolve().parent.parent / "analyze.py"),
                 "--in", str(path), "--no-ffmpeg",
                 "--spectrogram-frames", "40", "--spectrogram-bins", "32"],
                capture_output=True, text=True,
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        document = json.loads(proc.stdout)
        self.assertEqual(document["schema"], "audio-analysis/v1")


class TestAgainstFfmpeg(unittest.TestCase):
    """Cross-check our BS.1770 against ffmpeg's, when ffmpeg is available.

    Two independent implementations agreeing to a few tenths of a LU is much
    stronger evidence than either one agreeing with itself.
    """

    def setUp(self):
        import shutil

        if shutil.which("ffmpeg") is None:
            self.skipTest("ffmpeg not on PATH")

    def test_internal_loudness_matches_ffmpeg(self):
        from master import measure

        for level in (-20.0, -14.0):
            with self.subTest(level=level):
                with TempWav(sine(1000.0, 12.0, level)) as path:
                    data, rate = sf.read(str(path), always_2d=True, dtype="float64")
                    mine = integrated_loudness(data, rate)
                    theirs = measure(path).integrated
                self.assertAlmostEqual(mine, theirs, delta=0.3)

    def test_internal_loudness_matches_ffmpeg_on_noise(self):
        from master import measure

        rng = np.random.default_rng(17)
        noise = rng.normal(0.0, 0.05, (RATE * 12, 2))
        with TempWav(noise) as path:
            data, rate = sf.read(str(path), always_2d=True, dtype="float64")
            mine = integrated_loudness(data, rate)
            theirs = measure(path).integrated
        self.assertAlmostEqual(mine, theirs, delta=0.3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
