#!/usr/bin/env python3
"""Tests for trackvideo.py.

Everything here is ffmpeg invocation, so what is testable is the argv this
builds and the checks it makes before building it — not the encode. Both
`subprocess.run` calls are patched throughout: an hour-long still at 2 fps is
minutes of CPU, and there is nothing in the output a test could read that the
command line does not already say.

Two things make the argv worth pinning rather than trusting:

  * `-frames:v`. A looped still is only checked once per input frame, so at
    2 fps `-shortest` overruns the audio by tens of seconds. The explicit cap
    is the fix, and it is invisible in the output until someone uploads a
    four-minute track with ninety seconds of silence on the end.
  * `-tune stillimage` is right for a still and wrong for a zoom. Nothing
    fails when it is wrong; the video just looks worse than it should.
"""

from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

from music_studio.audio import trackvideo as tv


def _probe_json(*, width=1920, height=1080, duration=240.0,
                sample_rate=48000, channels=2) -> str:
    """ffprobe's -of json output, in the shape _ffprobe reads it."""
    return json.dumps({
        "streams": [{"width": width, "height": height,
                     "sample_rate": str(sample_rate), "channels": channels}],
        "format": {"duration": str(duration)},
    })


class _Build(unittest.TestCase):
    """Base for tests that call build(). Every subprocess is captured.

    ffprobe answers from `self.audio`/`self.art`; ffmpeg does nothing and
    reports success. The files are created empty because build() checks that
    they exist before it probes anything.
    """

    AUDIO = dict(duration=240.0, sample_rate=48000, channels=2)
    ART = dict(width=1920, height=1080)

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

        self.audio = self.tmp / "track.wav"
        self.art = self.tmp / "cover.png"
        for p in (self.audio, self.art):
            p.write_bytes(b"")

        self.commands: list[list[str]] = []
        self.audio_info = dict(self.AUDIO)
        self.art_info = dict(self.ART)

        def fake_run(argv, **kw):
            self.commands.append(argv)
            if argv[0] == "ffprobe":
                is_audio = "a:0" in argv
                out = _probe_json(**(self.audio_info if is_audio
                                     else {**self.art_info, "duration": 0}))
                return subprocess.CompletedProcess(argv, 0, out, "")
            # ffmpeg writes nothing, so create the file the caller will stat
            Path(argv[-1]).write_bytes(b"\0" * 1024)
            return subprocess.CompletedProcess(argv, 0, "", "")

        run = unittest.mock.patch("subprocess.run", side_effect=fake_run)
        run.start()
        self.addCleanup(run.stop)

        which = unittest.mock.patch.object(tv.shutil, "which",
                                           return_value="/usr/bin/ffmpeg")
        which.start()
        self.addCleanup(which.stop)

        # build() narrates at INFO and warns about croppy artwork. Tests that
        # care about a warning patch `log.warning` themselves and see their own
        # calls; the rest should not have it on screen.
        for level in ("info", "warning"):
            quiet = unittest.mock.patch.object(tv.log, level)
            quiet.start()
            self.addCleanup(quiet.stop)

    def build(self, **kw):
        kw.setdefault("thumbnail", False)
        return tv.build(self.audio, self.art, self.tmp / "dist", **kw)

    @property
    def ffmpeg(self) -> list[list[str]]:
        return [c for c in self.commands if c[0] == "ffmpeg"]

    def encode_for(self, kind: str) -> list[str]:
        """The one ffmpeg command that produced a given output.

        Matched on the filter rather than the filename: _encode writes to a
        randomly named temp file and moves it into place afterwards, so the
        destination never appears in argv. The three outputs are told apart by
        what they ask the filter graph for.
        """
        # A still pads to "1920:1080"; a zoom pads to twice that and hands
        # zoompan "s=1920x1080". Both name the final size, spelled differently,
        # and neither of the other two outputs mentions it at all.
        marks = {
            "landscape": ("pad=1920:1080", "s=1920x1080"),
            "short": ("crop=1080:1920",),   # filled into a vertical frame
            "thumbnail": ("crop=1280:720",),
        }
        self.assertIn(kind, marks)
        if not self.ffmpeg:
            self.build()                    # a test that only asserts on argv
        matches = [c for c in self.ffmpeg
                   if any(m in " ".join(c) for m in marks[kind])]
        self.assertEqual(len(matches), 1,
                         f"expected one {kind} encode, got {len(matches)}")
        return matches[0]


class TestProbing(unittest.TestCase):
    """What is read off the files before anything is encoded."""

    def _probe(self, out: str, returncode: int = 0, stderr: str = ""):
        proc = subprocess.CompletedProcess([], returncode, out, stderr)
        with unittest.mock.patch("subprocess.run", return_value=proc):
            return proc

    def test_audio_fields_are_read(self):
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 0, _probe_json(duration=185.5, sample_rate=44100,
                                       channels=1), "")):
            info = tv.probe_audio(Path("a.wav"))
        self.assertAlmostEqual(info.duration, 185.5)
        self.assertEqual(info.sample_rate, 44100)
        self.assertEqual(info.channels, 1)

    def test_image_dimensions_are_read(self):
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 0, _probe_json(width=3000, height=3000), "")):
            info = tv.probe_image(Path("c.png"))
        self.assertEqual((info.width, info.height), (3000, 3000))
        self.assertAlmostEqual(info.aspect, 1.0)

    def test_aspect_is_width_over_height(self):
        """Every padding decision downstream is made from this number."""
        self.assertAlmostEqual(tv.ImageInfo(1920, 1080).aspect, 16 / 9)

    def test_a_zero_duration_is_refused(self):
        """ffprobe reports 0 for a file it could open but not decode. Encoding
        against it produces a zero-length video rather than an error."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 0, _probe_json(duration=0), "")):
            with self.assertRaises(tv.TrackVideoError) as c:
                tv.probe_audio(Path("silent.wav"))
        self.assertIn("duration", str(c.exception))

    def test_a_file_with_no_matching_stream_is_refused(self):
        """Handing --art a WAV is an easy mistake and ffprobe exits 0 on it."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps({"streams": [], "format": {}}), "")):
            with self.assertRaises(tv.TrackVideoError) as c:
                tv.probe_image(Path("track.wav"))
        self.assertIn("No v:0 stream", str(c.exception))

    def test_a_failed_probe_reports_ffprobes_own_message(self):
        err = subprocess.CalledProcessError(1, "ffprobe", "", "Invalid data found")
        with unittest.mock.patch("subprocess.run", side_effect=err):
            with self.assertRaises(tv.TrackVideoError) as c:
                tv.probe_audio(Path("broken.wav"))
        self.assertIn("Invalid data found", str(c.exception))

    def test_ffprobe_is_never_handed_a_shell_string(self):
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 0, _probe_json(), "")) as run:
            tv.probe_audio(Path("my track.wav"))
        argv = run.call_args[0][0]
        self.assertIsInstance(argv, list)
        self.assertIn("my track.wav", argv)


class TestFilters(unittest.TestCase):
    """The filter strings. Each encodes a decision that is invisible in the
    output until it is wrong."""

    def test_a_still_fits_inside_the_frame_rather_than_stretching(self):
        """`decrease` plus a pad. `increase` would crop; neither preserves the
        artwork, but a stretched square cover is the more obvious wrong."""
        f = tv._still_filter(1920, 1080, "black")
        self.assertIn("force_original_aspect_ratio=decrease", f)
        self.assertIn("pad=1920:1080", f)

    def test_the_pad_colour_reaches_the_filter(self):
        self.assertIn("color=#F5EBDC", tv._still_filter(1920, 1080, "#F5EBDC"))

    def test_the_still_is_centred(self):
        self.assertIn("(ow-iw)/2:(oh-ih)/2", tv._still_filter(1920, 1080, "black"))

    def test_a_vertical_crop_fills_the_frame_instead(self):
        """The opposite choice, and the right one here: a 1080x1920 cut with
        pillarbars is unwatchable on a phone."""
        f = tv._crop_to_fill(1080, 1920)
        self.assertIn("force_original_aspect_ratio=increase", f)
        self.assertIn("crop=1080:1920", f)
        self.assertNotIn("pad=", f)

    def test_every_filter_ends_in_a_playable_pixel_format(self):
        """yuv420p is what every player and every platform accepts. Without it
        ffmpeg picks yuv444p from a PNG and the file plays nowhere."""
        for f in (tv._still_filter(1920, 1080, "black"),
                  tv._crop_to_fill(1080, 1920),
                  tv._zoom_filter(1920, 1080, 25, 100, 0.1, "black")):
            self.assertTrue(f.endswith("format=yuv420p"), f)

    def test_every_filter_sets_a_square_pixel_aspect(self):
        """Artwork carries no SAR; without setsar=1 ffmpeg can inherit a
        non-square one and the video plays stretched."""
        for f in (tv._still_filter(1920, 1080, "black"),
                  tv._crop_to_fill(1080, 1920),
                  tv._zoom_filter(1920, 1080, 25, 100, 0.1, "black")):
            self.assertIn("setsar=1", f)

    def test_the_zoom_upscales_before_it_zooms(self):
        """zoompan crops from the source, so zooming a 1:1 scale softens the
        image as it goes. Scaling to 2x first keeps it sharp throughout."""
        f = tv._zoom_filter(1920, 1080, 25, 6000, 0.10, "black")
        self.assertIn("scale=3840:2160", f)

    def test_the_zoom_ends_at_the_amount_asked_for(self):
        f = tv._zoom_filter(1920, 1080, 25, 6000, 0.10, "black")
        self.assertIn("1.1", f)

    def test_the_zoom_step_divides_the_move_across_the_whole_track(self):
        """Per-frame, not per-second: a step computed against the wrong total
        finishes the zoom in the first ten seconds and then sits still."""
        f = tv._zoom_filter(1920, 1080, 25, 1000, 0.10, "black")
        self.assertIn(f"{0.10 / 1000:.8f}", f)

    def test_the_zoom_output_size_and_rate_are_pinned(self):
        """zoompan emits at its own size and fps unless told; the default is
        the upscaled 2x frame, which is four times the pixels."""
        f = tv._zoom_filter(1920, 1080, 25, 6000, 0.10, "black")
        self.assertIn("s=1920x1080", f)
        self.assertIn("fps=25", f)

    def test_a_zero_frame_zoom_does_not_divide_by_zero(self):
        """A duration that rounds to no frames is degenerate but reachable."""
        self.assertIsInstance(tv._zoom_filter(1920, 1080, 25, 0, 0.1, "black"), str)


class TestLandscapeArgv(_Build):
    """The main encode."""

    def test_it_writes_a_1080p_file_named_for_the_track(self):
        written = self.build()
        self.assertEqual(written[0].name, "track-1080p.mp4")

    def test_the_stem_can_be_overridden(self):
        self.assertEqual(self.build(stem="volume-one")[0].name,
                         "volume-one-1080p.mp4")

    def test_the_artwork_is_looped_and_the_audio_is_not(self):
        """Two inputs, and only the image gets -loop. Looping the audio would
        produce a video as long as ffmpeg felt like."""
        cmd = self.encode_for("landscape")
        self.assertEqual(cmd.count("-loop"), 1)
        self.assertLess(cmd.index("-loop"), cmd.index(str(self.art)))

    def test_the_video_stream_is_capped_to_the_audio_length(self):
        """THE bug this guards. -shortest alone is checked once per input
        frame, so at 2 fps a still overruns by up to tens of seconds."""
        cmd = self.encode_for("landscape")
        self.assertIn("-frames:v", cmd)
        self.assertEqual(cmd[cmd.index("-frames:v") + 1],
                         str(int(240.0 * tv.STILL_FPS)))

    def test_shortest_is_still_passed_as_well(self):
        """Belt and braces: the frame cap handles the still, -shortest handles
        anything that makes the audio the shorter stream."""
        self.assertIn("-shortest", self.encode_for("landscape"))

    def test_a_still_encodes_at_the_low_frame_rate(self):
        """Nothing moves. 25 fps costs about 25 minutes of encoding per hour of
        audio and produces an identical picture."""
        self.build()
        cmd = self.encode_for("landscape")
        self.assertEqual(cmd[cmd.index("-r") + 1], str(tv.STILL_FPS))

    def test_a_zoom_encodes_at_the_motion_frame_rate(self):
        """2 fps motion is a slideshow."""
        self.build(zoom=True)
        cmd = self.encode_for("landscape")
        self.assertEqual(cmd[cmd.index("-r") + 1], str(tv.MOTION_FPS))

    def test_an_explicit_fps_beats_both_defaults(self):
        self.build(fps=12)
        self.assertEqual(self.encode_for("landscape")[
            self.encode_for("landscape").index("-r") + 1], "12")

    def test_a_still_is_tuned_for_a_still(self):
        self.assertIn("stillimage", self.encode_for("landscape"))

    def test_a_zoom_is_not_tuned_for_a_still(self):
        """The wrong tune for a moving frame: it biases toward flat areas and
        smears exactly the motion the zoom was added for."""
        self.build(zoom=True)
        self.assertNotIn("stillimage", self.encode_for("landscape"))

    def test_the_quality_setting_is_passed_through(self):
        self.build(crf=23)
        cmd = self.encode_for("landscape")
        self.assertEqual(cmd[cmd.index("-crf") + 1], "23")

    def test_the_audio_is_encoded_at_the_requested_bitrate(self):
        self.build(audio_bitrate="256k")
        cmd = self.encode_for("landscape")
        self.assertEqual(cmd[cmd.index("-b:a") + 1], "256k")

    def test_the_audio_is_normalised_to_stereo_48k_aac(self):
        """What every platform re-encodes to anyway. Handing YouTube a 44.1
        mono track makes it do the conversion with no say in it."""
        cmd = self.encode_for("landscape")
        self.assertEqual(cmd[cmd.index("-ar") + 1], "48000")
        self.assertEqual(cmd[cmd.index("-ac") + 1], "2")
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "aac")

    def test_the_moov_atom_is_moved_to_the_front(self):
        """+faststart. Without it the file only begins playing after the whole
        thing has downloaded, which on a 400 MB upload is the whole file."""
        self.assertIn("+faststart", self.encode_for("landscape"))

    def test_nothing_is_ever_a_shell_string(self):
        self.build(short=True, thumbnail=True)
        for cmd in self.commands:
            self.assertIsInstance(cmd, list)

    def test_stdin_is_closed_so_a_prompt_cannot_hang_the_run(self):
        """-nostdin. ffmpeg asks "File exists. Overwrite?" and waits forever
        when it is not there."""
        for cmd in self.ffmpeg:
            self.assertIn("-nostdin", cmd)

    def test_the_output_directory_is_created(self):
        self.build()
        self.assertTrue((self.tmp / "dist").is_dir())


class TestThumbnail(_Build):
    def test_it_is_written_by_default(self):
        names = [p.name for p in tv.build(self.audio, self.art, self.tmp / "dist")]
        self.assertIn("track-thumb.jpg", names)

    def test_it_can_be_skipped(self):
        self.assertNotIn("track-thumb.jpg", [p.name for p in self.build()])

    def test_it_is_a_single_frame_cropped_to_fill(self):
        """A padded thumbnail is black bars in a grid of other people's
        thumbnails, which is the one place the artwork has to compete."""
        tv.build(self.audio, self.art, self.tmp / "dist")
        cmd = self.encode_for("thumbnail")
        self.assertEqual(cmd[cmd.index("-frames:v") + 1], "1")
        self.assertIn("crop=1280:720", " ".join(cmd))

    def test_an_oversized_thumbnail_is_warned_about(self):
        """YouTube rejects anything over 2 MB, and it rejects it at upload
        time after the video has finished encoding."""
        out = self.tmp / "big.jpg"

        def fake_run(argv, **kw):
            Path(argv[-1]).write_bytes(b"\0" * 3_000_000)
            return subprocess.CompletedProcess(argv, 0, "", "")

        with unittest.mock.patch("subprocess.run", side_effect=fake_run), \
                unittest.mock.patch.object(tv.log, "warning") as warned:
            tv._thumbnail(self.art, out)
        self.assertTrue(any("2 MB" in str(c) for c in warned.call_args_list))

    def test_a_small_thumbnail_is_not_warned_about(self):
        out = self.tmp / "small.jpg"

        def fake_run(argv, **kw):
            Path(argv[-1]).write_bytes(b"\0" * 200_000)
            return subprocess.CompletedProcess(argv, 0, "", "")

        with unittest.mock.patch("subprocess.run", side_effect=fake_run), \
                unittest.mock.patch.object(tv.log, "warning") as warned:
            tv._thumbnail(self.art, out)
        warned.assert_not_called()


class TestShort(_Build):
    """The vertical cut. It is a slice of the track, so the arithmetic about
    where it starts and how long it runs is the part worth pinning."""

    def test_it_is_written_when_asked_for(self):
        self.assertIn("track-short.mp4", [p.name for p in self.build(short=True)])

    def test_it_is_not_written_otherwise(self):
        self.assertNotIn("track-short.mp4", [p.name for p in self.build()])

    def test_the_start_offset_seeks_the_audio_only(self):
        """-ss before the audio input, after the image. Seeking the looped
        still would skip frames of a picture that never changes."""
        self.build(short=True, short_start=45.0)
        cmd = self.encode_for("short")
        self.assertIn("-ss", cmd)
        self.assertEqual(cmd[cmd.index("-ss") + 1], "45.000")
        self.assertGreater(cmd.index("-ss"), cmd.index(str(self.art)))
        self.assertLess(cmd.index("-ss"), cmd.index(str(self.audio)))

    def test_no_seek_is_emitted_when_it_starts_at_zero(self):
        self.build(short=True, short_start=0.0)
        self.assertNotIn("-ss", self.encode_for("short"))

    def test_the_length_reaches_ffmpeg(self):
        self.build(short=True, short_duration=45.0)
        cmd = self.encode_for("short")
        self.assertEqual(cmd[cmd.index("-t") + 1], "45.000")

    def test_it_is_trimmed_to_what_is_left_of_the_track(self):
        """Asking for 60s from 3:40 of a 4:00 track. ffmpeg would write 20
        seconds and pad, or stall, depending on the muxer."""
        self.build(short=True, short_start=220.0, short_duration=60.0)
        cmd = self.encode_for("short")
        self.assertEqual(cmd[cmd.index("-t") + 1], "20.000")

    def test_it_is_capped_at_the_platform_limit(self):
        """Over three minutes and it is no longer a Short — YouTube files it
        as a normal video, in a feed it was never shaped for."""
        self.audio_info["duration"] = 1200.0
        self.build(short=True, short_duration=600.0)
        cmd = self.encode_for("short")
        self.assertEqual(cmd[cmd.index("-t") + 1], f"{tv.SHORT_MAX:.3f}")

    def test_a_start_past_the_end_is_refused(self):
        with self.assertRaises(tv.TrackVideoError) as c:
            self.build(short=True, short_start=900.0)
        self.assertIn("outside the track", str(c.exception))

    def test_a_negative_start_is_refused(self):
        with self.assertRaises(tv.TrackVideoError):
            self.build(short=True, short_start=-5.0)

    def test_separate_portrait_artwork_is_used_when_given(self):
        """Cropping a 16:9 cover to 9:16 keeps a third of it. Supplying
        portrait art is the only way to get a usable vertical."""
        portrait = self.tmp / "portrait.png"
        portrait.write_bytes(b"")
        self.build(short=True, short_art=portrait)
        self.assertIn(str(portrait), self.encode_for("short"))

    def test_cropping_landscape_art_to_vertical_is_warned_about(self):
        with unittest.mock.patch.object(tv.log, "warning") as warned:
            self.build(short=True)
        self.assertTrue(any("Cropping landscape" in str(c)
                            for c in warned.call_args_list))

    def test_square_artwork_gets_no_crop_warning(self):
        """1:1 loses little going to 9:16; the warning is for 16:9."""
        self.art_info.update(width=3000, height=3000)
        with unittest.mock.patch.object(tv.log, "warning") as warned:
            self.build(short=True)
        self.assertFalse(any("Cropping landscape" in str(c)
                             for c in warned.call_args_list))


class TestGuards(_Build):
    """Checks made before anything is encoded, because each of them otherwise
    surfaces minutes later as an ffmpeg error nobody can read."""

    def test_a_missing_audio_file_is_named(self):
        self.audio.unlink()
        with self.assertRaises(tv.TrackVideoError) as c:
            self.build()
        self.assertIn("Audio file not found", str(c.exception))

    def test_a_missing_art_file_is_named(self):
        self.art.unlink()
        with self.assertRaises(tv.TrackVideoError) as c:
            self.build()
        self.assertIn("Image file not found", str(c.exception))

    def test_an_unexpected_extension_warns_but_proceeds(self):
        """A .aiff is perfectly playable; refusing it would be worse than
        saying so and trying."""
        odd = self.tmp / "track.aiff"
        odd.write_bytes(b"")
        with unittest.mock.patch.object(tv.log, "warning") as warned:
            tv.build(odd, self.art, self.tmp / "dist", thumbnail=False)
        self.assertTrue(any("unexpected extension" in str(c)
                            for c in warned.call_args_list))

    def test_missing_ffmpeg_is_reported_before_any_probe(self):
        with unittest.mock.patch.object(tv.shutil, "which", return_value=None):
            with self.assertRaises(tv.TrackVideoError) as c:
                self.build()
        self.assertIn("ffmpeg", str(c.exception))
        self.assertEqual(self.commands, [])

    def test_low_resolution_artwork_is_warned_about(self):
        """It will be upscaled to 1080p and look soft, and there is no fixing
        that after the encode."""
        self.art_info.update(width=500, height=500)
        with unittest.mock.patch.object(tv.log, "warning") as warned:
            self.build()
        self.assertTrue(any("look soft" in str(c) for c in warned.call_args_list))

    def test_black_bars_on_a_default_pad_are_warned_about_with_the_remedy(self):
        """A square cover in a 16:9 frame is 44% black. The warning names
        --pad-colour because the fix is not obvious from the output."""
        self.art_info.update(width=3000, height=3000)
        with unittest.mock.patch.object(tv.log, "warning") as warned:
            self.build()
        text = " ".join(str(c) for c in warned.call_args_list)
        self.assertIn("black bars", text)
        self.assertIn("--pad-colour", text)

    def test_no_bar_warning_when_a_pad_colour_was_chosen(self):
        """The person has already answered; repeating it is noise."""
        self.art_info.update(width=3000, height=3000)
        with unittest.mock.patch.object(tv.log, "warning") as warned:
            self.build(pad_colour="#F5EBDC")
        self.assertFalse(any("black bars" in str(c)
                             for c in warned.call_args_list))

    def test_no_bar_warning_for_artwork_that_is_already_16_by_9(self):
        with unittest.mock.patch.object(tv.log, "warning") as warned:
            self.build()
        self.assertFalse(any("black bars" in str(c)
                             for c in warned.call_args_list))

    def test_a_failing_encode_reports_ffmpegs_last_lines(self):
        """The useful part of a 200-line ffmpeg log is the end of it."""
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 1, "", "\n".join(f"line {i}" for i in range(40)))):
            with self.assertRaises(tv.TrackVideoError) as c:
                tv._run_ffmpeg(["ffmpeg"], "out.mp4")
        self.assertIn("line 39", str(c.exception))
        self.assertNotIn("line 0", str(c.exception))

    def test_a_failed_encode_leaves_no_partial_file_behind(self):
        """It encodes to a temp file and moves it. A half-written mp4 sitting
        where the finished one belongs is worse than nothing there."""
        out = self.tmp / "dist" / "x.mp4"
        with unittest.mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess([], 1, "", "boom")):
            with self.assertRaises(tv.TrackVideoError):
                tv._encode(self.art, self.audio, out, "null", 2, 18, "320k")
        self.assertFalse(out.exists())
        self.assertEqual(list((self.tmp / "dist").iterdir()), [])


class TestDuration(unittest.TestCase):
    def test_under_an_hour_omits_the_hour(self):
        self.assertEqual(tv._hms(185), "3:05")

    def test_over_an_hour_includes_it(self):
        self.assertEqual(tv._hms(3725), "1:02:05")

    def test_seconds_are_always_two_digits(self):
        """"3:5" reads as three minutes five, or as 3.5 minutes."""
        self.assertEqual(tv._hms(184.6), "3:05")

    def test_zero_is_not_blank(self):
        self.assertEqual(tv._hms(0), "0:00")


class TestMain(unittest.TestCase):
    """The CLI. build() is patched: the wiring is what is under test."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        quiet = unittest.mock.patch.object(tv.log, "error")
        quiet.start()
        self.addCleanup(quiet.stop)

    def _written(self):
        p = self.tmp / "track-1080p.mp4"
        p.write_bytes(b"\0" * 2_000_000)
        return [p]

    def test_every_flag_reaches_build(self):
        with unittest.mock.patch.object(tv, "build",
                                        return_value=self._written()) as called, \
                redirect_stdout(io.StringIO()):
            rc = tv.main(["--audio", "a.wav", "--art", "c.png", "--out", "dist",
                          "--short", "--zoom", "--no-thumbnail",
                          "--short-start", "30", "--short-duration", "45",
                          "--fps", "30", "--crf", "20",
                          "--audio-bitrate", "256k", "--pad-colour", "#F5EBDC",
                          "--stem", "vol1"])
        self.assertEqual(rc, 0)
        kw = called.call_args[1]
        self.assertTrue(kw["short"])
        self.assertTrue(kw["zoom"])
        self.assertFalse(kw["thumbnail"])
        self.assertEqual(kw["short_start"], 30.0)
        self.assertEqual(kw["short_duration"], 45.0)
        self.assertEqual(kw["fps"], 30)
        self.assertEqual(kw["crf"], 20)
        self.assertEqual(kw["audio_bitrate"], "256k")
        self.assertEqual(kw["pad_colour"], "#F5EBDC")
        self.assertEqual(kw["stem"], "vol1")

    def test_the_defaults_are_a_thumbnail_and_no_short(self):
        with unittest.mock.patch.object(tv, "build",
                                        return_value=self._written()) as called, \
                redirect_stdout(io.StringIO()):
            tv.main(["--audio", "a.wav", "--art", "c.png"])
        kw = called.call_args[1]
        self.assertTrue(kw["thumbnail"])
        self.assertFalse(kw["short"])
        self.assertFalse(kw["zoom"])
        self.assertIsNone(kw["fps"])

    def test_it_prints_each_file_with_its_size(self):
        """The sizes are the point: it is how you find out the thumbnail is
        over the limit or the video is 4 GB before you try to upload it."""
        buf = io.StringIO()
        with unittest.mock.patch.object(tv, "build", return_value=self._written()), \
                redirect_stdout(buf):
            tv.main(["--audio", "a.wav", "--art", "c.png"])
        self.assertIn("track-1080p.mp4", buf.getvalue())
        self.assertIn("MB", buf.getvalue())

    def test_a_refusal_is_an_exit_code_not_a_traceback(self):
        with unittest.mock.patch.object(
                tv, "build", side_effect=tv.TrackVideoError("no ffmpeg")):
            self.assertEqual(tv.main(["--audio", "a.wav", "--art", "c.png"]), 1)

    def test_ctrl_c_is_130(self):
        """An encode is long enough that interrupting it is routine."""
        with unittest.mock.patch.object(tv, "build", side_effect=KeyboardInterrupt):
            self.assertEqual(tv.main(["--audio", "a.wav", "--art", "c.png"]), 130)


if __name__ == "__main__":
    unittest.main()
