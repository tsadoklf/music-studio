#!/usr/bin/env python3
"""Turn a track (audio + artwork) into upload-ready videos.

Produces a 1920x1080 landscape video for YouTube, a 1280x720 thumbnail, and
optionally a 1080x1920 vertical cut for Shorts/Reels/TikTok.

Usage:
    trackvideo.py --audio vol1.wav --art cover.png --out dist/
    trackvideo.py --audio vol1.wav --art cover.png --out dist/ --pad-colour '#F5EBDC'
    trackvideo.py --audio vol1.wav --art cover.png --out dist/ --short --zoom

Requires ffmpeg and ffprobe on PATH.

music-works/<artist-name>/_artwork/
   <artist-name>-frame-1080p.png — the video frame. Feed it to trackvideo.py as --art with no --pad-colour; it's already 16:9.
   <artist-name>-thumb-720.jpg — the thumbnail, 247 KB, well under the 2 MB cap.
   <artist-name>-cover-3000.png — the square master for streaming distribution. It's 21 MB as PNG, so convert to JPEG before uploading to a distributor; most want JPEG under 10 MB.

"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("trackvideo")

AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}

STILL_FPS = 2      # nothing moves; 25 fps wastes ~25 min of encoding per hour
MOTION_FPS = 25    # zoom needs real frames
SHORT_MAX = 180.0  # YouTube Shorts limit


class TrackVideoError(RuntimeError):
    """Anything that should stop the run with a readable message."""


# --------------------------------------------------------------------------
# probing
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class AudioInfo:
    duration: float
    sample_rate: int
    channels: int


@dataclass(frozen=True)
class ImageInfo:
    width: int
    height: int

    @property
    def aspect(self) -> float:
        return self.width / self.height


def _require_tools() -> None:
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        raise TrackVideoError(
            f"{', '.join(missing)} not found on PATH. "
            "Install ffmpeg (macOS: brew install ffmpeg, "
            "Debian/Ubuntu: apt install ffmpeg)."
        )


def _ffprobe(path: Path, stream: str) -> dict:
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", stream,
        "-show_entries", "stream=width,height,sample_rate,channels:format=duration",
        "-of", "json", str(path),
    ]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError as exc:
        raise TrackVideoError(f"ffprobe failed on {path.name}: {exc.stderr.strip()}") from exc
    data = json.loads(out)
    if not data.get("streams"):
        raise TrackVideoError(f"No {stream} stream found in {path.name}.")
    return data


def probe_audio(path: Path) -> AudioInfo:
    data = _ffprobe(path, "a:0")
    s = data["streams"][0]
    duration = float(data.get("format", {}).get("duration") or 0)
    if duration <= 0:
        raise TrackVideoError(f"Could not read a duration from {path.name}.")
    return AudioInfo(
        duration=duration,
        sample_rate=int(s.get("sample_rate", 48000)),
        channels=int(s.get("channels", 2)),
    )


def probe_image(path: Path) -> ImageInfo:
    data = _ffprobe(path, "v:0")
    s = data["streams"][0]
    return ImageInfo(width=int(s["width"]), height=int(s["height"]))


# --------------------------------------------------------------------------
# filters
# --------------------------------------------------------------------------

def _still_filter(w: int, h: int, pad_colour: str) -> str:
    """Fit the artwork inside w x h, padding rather than distorting."""
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={pad_colour},"
        "setsar=1,format=yuv420p"
    )


def _zoom_filter(w: int, h: int, fps: int, frames: int, amount: float, pad_colour: str) -> str:
    """Slow Ken Burns zoom.

    zoompan emits d frames per input frame, so the source is upscaled first to
    keep the zoom from softening, and d is the total frame count of the output.
    """
    big_w, big_h = w * 2, h * 2
    step = amount / max(frames, 1)
    return (
        f"scale={big_w}:{big_h}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={big_w}:{big_h}:(ow-iw)/2:(oh-ih)/2:color={pad_colour},"
        f"zoompan=z='min(zoom+{step:.8f},{1 + amount})'"
        f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        f":d={frames}:s={w}x{h}:fps={fps},"
        "setsar=1,format=yuv420p"
    )


def _crop_to_fill(w: int, h: int) -> str:
    """Fill the frame edge to edge, cropping the overflow. Used for verticals."""
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={w}:{h},setsar=1,format=yuv420p"
    )


# --------------------------------------------------------------------------
# encoding
# --------------------------------------------------------------------------

def _run_ffmpeg(cmd: list[str], label: str) -> None:
    log.debug("%s: %s", label, " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-12:])
        raise TrackVideoError(f"ffmpeg failed while writing {label}:\n{tail}")


def _encode(
    art: Path,
    audio: Path,
    out: Path,
    vf: str,
    fps: int,
    crf: int,
    audio_bitrate: str,
    *,
    still: bool = True,
    start: float | None = None,
    duration: float | None = None,
) -> None:
    """Write one video. Encodes to a temp file and moves it into place."""
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=out.suffix, dir=out.parent)
    import os
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin"]
        cmd += ["-loop", "1", "-framerate", str(fps), "-i", str(art)]
        if start is not None and start > 0:
            cmd += ["-ss", f"{start:.3f}"]
        cmd += ["-i", str(audio)]
        if duration is not None:
            cmd += ["-t", f"{duration:.3f}"]
        cmd += ["-vf", vf, "-r", str(fps)]
        # -shortest alone doesn't reliably cut a looped still: the loop is only
        # checked once per input frame, so at 2 fps it overruns the audio by up
        # to tens of seconds. Cap the video stream explicitly.
        if duration is not None:
            cmd += ["-frames:v", str(max(int(round(duration * fps)), 1))]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf)]
        if still:
            # wrong tune for a moving frame; only correct when nothing moves
            cmd += ["-tune", "stillimage"]
        cmd += [
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", audio_bitrate, "-ar", "48000", "-ac", "2",
            "-shortest", "-movflags", "+faststart",
            str(tmp),
        ]
        _run_ffmpeg(cmd, out.name)
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)


def _thumbnail(art: Path, out: Path) -> None:
    """1280x720 JPEG, cropped to fill rather than padded."""
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", str(art),
        "-vf", "scale=1280:720:force_original_aspect_ratio=increase:flags=lanczos,crop=1280:720",
        "-frames:v", "1", "-q:v", "2",
        str(out),
    ]
    _run_ffmpeg(cmd, out.name)
    size_mb = out.stat().st_size / 1e6
    if size_mb > 2:
        log.warning("Thumbnail is %.1f MB; YouTube's limit is 2 MB.", size_mb)


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

def build(
    audio: Path,
    art: Path,
    outdir: Path,
    *,
    short: bool = False,
    short_art: Path | None = None,
    short_start: float = 0.0,
    short_duration: float = 30.0,
    zoom: bool = False,
    fps: int | None = None,
    crf: int = 18,
    audio_bitrate: str = "320k",
    pad_colour: str = "black",
    thumbnail: bool = True,
    stem: str | None = None,
) -> list[Path]:
    _require_tools()

    for p, kinds, what in ((audio, AUDIO_SUFFIXES, "audio"), (art, IMAGE_SUFFIXES, "image")):
        if not p.is_file():
            raise TrackVideoError(f"{what.capitalize()} file not found: {p}")
        if p.suffix.lower() not in kinds:
            log.warning("%s has an unexpected extension (%s); trying anyway.", p.name, p.suffix)

    info = probe_audio(audio)
    art_info = probe_image(art)

    # fps follows the content unless overridden: a still frame needs almost none
    effective_fps = fps if fps is not None else (MOTION_FPS if zoom else STILL_FPS)

    log.info(
        "%s: %s (%.0fs), %d Hz, %d ch | artwork %dx%d | %d fps",
        audio.name, _hms(info.duration), info.duration,
        info.sample_rate, info.channels,
        art_info.width, art_info.height, effective_fps,
    )
    if min(art_info.width, art_info.height) < 720:
        log.warning(
            "Artwork is %dx%d; it will look soft at 1080p. 1920x1080 or larger is better.",
            art_info.width, art_info.height,
        )

    # warn when padding will actually be visible, and say what to do about it
    if not zoom and abs(art_info.aspect - 16 / 9) > 0.05 and pad_colour == "black":
        bar_pct = 100 * (1 - min(art_info.aspect / (16 / 9), 1.0))
        if bar_pct > 5:
            log.warning(
                "Artwork is %.2f:1, so ~%.0f%% of the frame will be black bars. "
                "Pass --pad-colour '#F5EBDC' (or any hex) to match your artwork, "
                "or supply 16:9 art.",
                art_info.aspect, bar_pct,
            )

    name = stem or audio.stem
    written: list[Path] = []

    frames = max(int(info.duration * effective_fps), 1)
    vf = (
        _zoom_filter(1920, 1080, effective_fps, frames, 0.10, pad_colour)
        if zoom else
        _still_filter(1920, 1080, pad_colour)
    )
    landscape = outdir / f"{name}-1080p.mp4"
    log.info("Writing %s%s", landscape.name, " (with zoom)" if zoom else "")
    _encode(art, audio, landscape, vf, effective_fps, crf, audio_bitrate, still=not zoom,
            duration=info.duration)
    written.append(landscape)

    if thumbnail:
        thumb = outdir / f"{name}-thumb.jpg"
        log.info("Writing %s", thumb.name)
        _thumbnail(art, thumb)
        written.append(thumb)

    if short:
        if short_start < 0 or short_start >= info.duration:
            raise TrackVideoError(
                f"--short-start {short_start}s is outside the track (0-{info.duration:.1f}s)."
            )
        clip = min(short_duration, info.duration - short_start, SHORT_MAX)
        if clip < short_duration:
            log.warning("Short trimmed to %.1fs.", clip)

        src_art = short_art or art
        if short_art:
            probe_image(short_art)  # fail early if unreadable
        elif art_info.aspect > 1.2:
            log.warning(
                "Cropping landscape artwork to vertical will cut the sides. "
                "Pass --short-art with a portrait image for a better result."
            )
        vertical = outdir / f"{name}-short.mp4"
        log.info("Writing %s (%.0fs from %.0fs)", vertical.name, clip, short_start)
        _encode(
            src_art, audio, vertical,
            _crop_to_fill(1080, 1920), effective_fps, crf, audio_bitrate,
            still=True, start=short_start, duration=clip,
        )
        written.append(vertical)

    return written


def _hms(seconds: float) -> str:
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:d}:{sec:02d}"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Turn a track's audio and artwork into upload-ready videos.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--audio", type=Path, required=True, help="Audio file (wav preferred).")
    p.add_argument("--art", type=Path, required=True, help="Artwork, 1920x1080 or larger.")
    p.add_argument("--out", type=Path, default=Path("dist"), help="Output directory.")
    p.add_argument("--stem", help="Base name for outputs. Defaults to the audio filename.")
    p.add_argument("--short", action="store_true", help="Also write a 1080x1920 vertical cut.")
    p.add_argument("--short-art", type=Path, help="Portrait artwork for the vertical cut.")
    p.add_argument("--short-start", type=float, default=0.0, help="Where the short starts, in seconds.")
    p.add_argument("--short-duration", type=float, default=30.0,
                   help=f"Short length, in seconds (max {SHORT_MAX:.0f}).")
    p.add_argument("--zoom", action="store_true", help="Slow zoom on the landscape video.")
    p.add_argument("--no-thumbnail", dest="thumbnail", action="store_false",
                   help="Skip the 1280x720 thumbnail.")
    p.add_argument("--fps", type=int, default=None,
                   help=f"Frame rate. Default: {STILL_FPS} for stills, {MOTION_FPS} with --zoom.")
    p.add_argument("--crf", type=int, default=18, help="Lower is higher quality, 18-23 is sensible.")
    p.add_argument("--audio-bitrate", default="320k")
    p.add_argument("--pad-colour", default="black",
                   help="Fill colour when the artwork isn't 16:9, e.g. '#F5EBDC'.")
    p.add_argument("-v", "--verbose", action="store_true", help="Show the ffmpeg commands.")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    try:
        written = build(
            args.audio, args.art, args.out,
            short=args.short,
            short_art=args.short_art,
            short_start=args.short_start,
            short_duration=args.short_duration,
            zoom=args.zoom,
            fps=args.fps,
            crf=args.crf,
            audio_bitrate=args.audio_bitrate,
            pad_colour=args.pad_colour,
            thumbnail=args.thumbnail,
            stem=args.stem,
        )
    except TrackVideoError as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.error("Interrupted.")
        return 130

    for path in written:
        print(f"{path}  ({path.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
