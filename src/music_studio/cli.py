#!/usr/bin/env python3
"""music — the song-shop command line.

One entry point for the whole pipeline: scaffold a song, master it, compare
versions, render the video, publish to YouTube.

    music new ida-y-vuelta --channel camille-marceau
    music check tracks/ida-y-vuelta/song.md
    music measure tracks/ida-y-vuelta/masters/takes/take-01.wav
    music master tracks/ida-y-vuelta --lufs -14
    music compare tracks/ida-y-vuelta --null diff.wav
    music video tracks/ida-y-vuelta --art artwork/frame-1080p.png
    music publish tracks/ida-y-vuelta --dry-run
    music publish tracks/ida-y-vuelta --update --privacy public

Every command that takes a track accepts either the track directory or the
song.md inside it.

Install:
    pip install typer soundfile numpy scipy matchering \
        google-api-python-client google-auth-oauthlib
    ffmpeg must be on PATH.
"""

from __future__ import annotations

import json
import logging
import shutil
import sys
from datetime import date
from pathlib import Path
from typing import Optional

import typer

# the four workers live beside this file

from music_studio import paths  # noqa: E402  (after the path insert above)

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Mastering bench: scaffold, measure, master, compare, render, publish.",
)

log = logging.getLogger("music")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )


def _song_file(track: Path) -> Path:
    """Accept a track directory or a song.md and return the song.md."""
    if track.is_file():
        return track
    candidate = track / "song.md"
    if candidate.is_file():
        return candidate
    raise typer.BadParameter(f"No song.md found at {track}")


def _track_dir(track: Path) -> Path:
    return track.parent if track.is_file() else track


def _fail(message: str) -> None:
    typer.secho(f"error: {message}", fg=typer.colors.RED, err=True)
    raise typer.Exit(1)


def _ok(message: str) -> None:
    typer.secho(message, fg=typer.colors.GREEN)


def _pick_take(track_dir: Path) -> Path:
    """Find the take to master: the only one, or fail asking which."""
    takes_dir = track_dir / "masters" / "takes"
    if not takes_dir.is_dir():
        _fail(f"No masters/takes/ under {track_dir}. Put the raw Suno export there.")
    takes = sorted(p for p in takes_dir.iterdir()
                   if p.suffix.lower() in {".wav", ".flac", ".mp3"})
    if not takes:
        _fail(f"No audio files in {takes_dir}")
    if len(takes) > 1:
        names = "\n  ".join(p.name for p in takes)
        _fail(f"Several takes in {takes_dir}. Pass --take:\n  {names}")
    return takes[0]


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

@app.command()
def new(
    slug: str = typer.Argument(..., help="Kebab-case folder name, e.g. ida-y-vuelta."),
    channel: str = typer.Option(..., "--channel", "-c", help="le-bal-musette | camille-marceau"),
    title: Optional[str] = typer.Option(None, "--title", help="Display title. Defaults to the slug."),
    root: Path = typer.Option(Path("."), "--root", help="Channel root containing tracks/."),
    template: Optional[Path] = typer.Option(None, "--template", help="Path to song-template.md."),
) -> None:
    """Scaffold a new track folder from the song template."""
    if slug != slug.lower() or " " in slug or "_" in slug:
        _fail(f"'{slug}' should be kebab-case: lowercase, hyphens, no spaces.")

    track_dir = root / "tracks" / slug
    if track_dir.exists():
        _fail(f"{track_dir} already exists.")

    for sub in ("masters/takes", "artwork", "video"):
        (track_dir / sub).mkdir(parents=True, exist_ok=True)

    tpl = template or paths.song_template()
    song = track_dir / "song.md"
    if tpl and tpl.is_file():
        text = tpl.read_text(encoding="utf-8")
        text = (text
                .replace("<kebab-case-folder-name>", slug)
                .replace("<Display title, accents and all>", title or slug.replace("-", " ").title())
                .replace("<le-bal-musette | camille-marceau>", channel)
                .replace("<YYYY-MM-DD>", date.today().isoformat(), 1))
        song.write_text(text, encoding="utf-8")
    else:
        song.write_text(
            f"---\nslug: {slug}\ntitle: {title or slug}\nchannel: {channel}\n"
            f"status: sketch\ncreated: {date.today().isoformat()}\nvideo_id: —\n---\n",
            encoding="utf-8",
        )
        typer.secho(f"note: no template at {tpl}; wrote a minimal stub.",
                    fg=typer.colors.YELLOW, err=True)

    _ok(f"Created {track_dir}")
    typer.echo(f"  edit {song}")


@app.command()
def check(
    track: Path = typer.Argument(..., help="Track directory or song.md."),
) -> None:
    """Validate a song file's publishing metadata without touching YouTube."""
    from ytpublish import PublishError, parse_song

    song = _song_file(track)
    try:
        meta = parse_song(song)
    except PublishError as exc:
        _fail(str(exc))

    problems = meta.validate()
    typer.echo(f"slug      {meta.slug}")
    typer.echo(f"channel   {meta.channel or '—'}")
    typer.echo(f"title     {meta.title}")
    typer.echo(f"tags      {len(meta.tags)}")
    typer.echo(f"video_id  {meta.video_id or '— (not uploaded)'}")

    if problems:
        typer.echo("")
        for issue in problems:
            typer.secho(f"  ✗ {issue}", fg=typer.colors.RED)
        raise typer.Exit(1)
    _ok("\nMetadata is ready to publish.")


@app.command()
def measure(
    audio: Path = typer.Argument(..., help="Audio file."),
) -> None:
    """Report integrated loudness, true peak and loudness range."""
    from music_studio.audio.master import MasterError, measure as _measure

    try:
        typer.echo(_measure(audio).describe())
    except MasterError as exc:
        _fail(str(exc))


@app.command()
def studio(
    target: Path = typer.Argument(..., help="An audio file, a track directory, or song.md."),
    audio: Optional[Path] = typer.Option(None, "--audio", help="Defaults to masters/master.wav."),
    out_dir: Optional[Path] = typer.Option(None, "--out-dir", help="Where to write. Default: beside the audio."),
    no_advice: bool = typer.Option(False, "--no-advice", help="Skip the model call."),
    open_page: bool = typer.Option(False, "--open", help="Open the studio page on the result."),
    serve_it: bool = typer.Option(False, "--serve", help="Serve the page, wired to the CLI."),
    port: int = typer.Option(8770, "--port"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Analyse a file and write everything: JSON, a report, an agent report.

    One step from an audio file to a verdict. Writes analysis.json (the full
    data), REPORT.md (for you) and report.ai.md (for an agent) beside the audio.
    """
    import webbrowser

    from music_studio.audio.analyze import AnalyzeError, analyze as _analyze
    from music_studio.insight.report import write_reports

    _setup_logging(verbose)

    if target.is_file() and target.suffix.lower() not in (".md", ".json"):
        src = target
    else:
        tdir = _track_dir(target)
        src = audio or (tdir / "masters" / "master.wav")
        if not src.is_file():
            _fail(f"No audio at {src}. Pass a file, or --audio.")

    dest = out_dir or src.parent
    dest.mkdir(parents=True, exist_ok=True)

    typer.echo(f"Analysing {src.name} …")
    try:
        report_data = _analyze(src)
    except AnalyzeError as exc:
        _fail(str(exc))

    analysis_path = dest / "analysis.json"
    analysis_path.write_text(json.dumps(report_data, separators=(",", ":")), encoding="utf-8")

    advice = None
    if not no_advice:
        from music_studio.insight.advise import DEFAULT_MODEL, AdviseError, advise as _advise
        try:
            advice = _advise(report_data, None, DEFAULT_MODEL)
        except AdviseError as exc:
            typer.secho(f"  (no advice: {exc})", fg=typer.colors.YELLOW, err=True)

    written = write_reports(report_data, dest, advice)

    # The verdict, in the terminal, without opening anything.
    from music_studio.insight.report import headline, verdicts as _verdicts
    vs = _verdicts(report_data)
    typer.echo("")
    typer.secho(f"  {headline(vs)}", bold=True,
                fg=typer.colors.RED if any(v["severity"] == "bad" for v in vs)
                else typer.colors.YELLOW if any(v["severity"] == "warn" for v in vs)
                else typer.colors.GREEN)
    for v in vs:
        mark = {"bad": "✗", "warn": "!", "ok": "✓"}[v["severity"]]
        colour = {"bad": typer.colors.RED, "warn": typer.colors.YELLOW,
                  "ok": typer.colors.GREEN}[v["severity"]]
        typer.secho(f"  {mark} {v['title']}", fg=colour)
    typer.echo("")
    _ok(f"  {analysis_path}")
    _ok(f"  {written['human']}")
    _ok(f"  {written['ai']}")

    if serve_it:
        from music_studio.serve.http import ServeError, serve as _serve
        try:
            _serve(dest.resolve(), port, False)
        except ServeError as exc:
            _fail(str(exc))
        return

    if open_page:
        page = paths.page()
        if not page.is_file():
            _fail(f"No studio page at {page}.")
        launcher = _write_launcher(page, report_data, src.name, advice, analysis_path)
        webbrowser.open(launcher.as_uri())


@app.command()
def maximize(
    target: Path = typer.Argument(..., help="Audio file, or a track directory."),
    out: Optional[Path] = typer.Option(None, "--out", help="Where to write. Default: beside the source."),
    preset: Optional[str] = typer.Option(None, "--preset", help="gentle | loud | broadcast | wide | glue"),
    list_presets: bool = typer.Option(False, "--list", help="Describe the presets and exit."),
    chain_only: bool = typer.Option(False, "--chain", help="Print the filter chain for --eq."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Compressor, stereo imager, maximizer and soft clip — an MClass-style suite.

    Reaches loudness targets plain loudnorm cannot: measured, -14.0 LUFS in
    linear mode where loudnorm alone stalled at -13.1. Follow it with
    `music master`, which applies the true-peak ceiling — the limiter here
    cannot, and must never be the last word.
    """
    from music_studio.audio import maximize as mx

    _setup_logging(verbose)
    if list_presets:
        raise typer.Exit(mx.main(["--list"]))

    try:
        settings = mx.resolve(preset, {})
        settings.validate()
    except mx.MaximizeError as exc:
        _fail(str(exc))

    if chain_only:
        typer.echo(mx.chain_string(settings))
        return

    if target.is_file() and target.suffix.lower() not in (".md", ".json"):
        src = target
    else:
        src = _track_dir(target) / "masters" / "master.wav"
        if not src.is_file():
            _fail(f"No audio at {src}.")

    dst = out or src.with_name(src.stem + "-max.wav")
    try:
        mx.run(src, dst, settings)
    except mx.MaximizeError as exc:
        _fail(str(exc))
    _ok(f"Wrote {dst}")
    typer.echo("  now run `music master` on it — the ceiling is loudnorm's job")


@app.command()
def serve(
    root: Path = typer.Argument(Path("."), help="Directory commands may touch."),
    port: int = typer.Option(8770, "--port"),
    read_only: bool = typer.Option(False, "--read-only",
                                   help="Refuse every command that writes audio."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Serve the music studio, and run commands for it.

    Loopback only, and anything that writes audio shows you the exact command
    and waits for a click first. Stop it with Ctrl-C; nothing is left running.
    """
    from music_studio.serve.http import ServeError, serve as _serve

    _setup_logging(verbose)
    try:
        _serve(root.resolve(), port, read_only)
    except ServeError as exc:
        _fail(str(exc))


@app.command()
def advise(
    track: Path = typer.Argument(..., help="Track directory, or an analysis.json."),
    ask: Optional[str] = typer.Option(None, "--ask", help="A question about the track."),
    model: Optional[str] = typer.Option(None, "--model"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Ask a model what the measurements mean and what to run next.

    It reads an analysis, never the audio, and it recommends commands rather
    than running them.
    """
    from music_studio.insight.advise import DEFAULT_MODEL, AdviseError, advise as _advise

    _setup_logging(verbose)

    if track.is_file() and track.suffix.lower() == ".json":
        path = track
    else:
        path = _track_dir(track) / "analysis.json"
        if not path.is_file():
            _fail(f"No analysis at {path}. Run `music scope` first.")

    try:
        report = json.loads(path.read_text(encoding="utf-8"))
        typer.echo(_advise(report, ask, model or DEFAULT_MODEL))
    except AdviseError as exc:
        _fail(str(exc))


def _write_launcher(page: Path, report: dict, name: str,
                    advice: str | None = None,
                    analysis_path: Path | None = None) -> Path:
    """Write a one-off page that opens the studio with this analysis already in it.

    The studio is a file:// page, and a file:// page may not fetch a sibling
    JSON — the browser treats every local file as its own origin. So rather than
    linking the data we inline it into a tiny wrapper that sets
    window.PRELOADED_ANALYSIS and then loads the real page's assets.

    The wrapper lands beside the page and is overwritten each run; it is a
    view of the last scope, not an artefact worth keeping.
    """
    payload = json.dumps(report, separators=(",", ":"))
    # </script> inside the data would end the block early.
    payload = payload.replace("</", "<\\/")

    # Take the studio page's own markup and insert the data ahead of its script, so
    # there is exactly one copy of the page. Rebuilding the markup here, or
    # fetching it at runtime, both fail: fetch() is blocked on file:// (verified
    # 2026-09-15 — "Failed to fetch"), and a second copy would drift.
    source = page.read_text(encoding="utf-8")
    inject = (f'<script>\nwindow.PRELOADED_ANALYSIS = {payload};\n'
              f'window.PRELOADED_NAME = {json.dumps(name)};\n')
    if advice:
        inject += f'window.PRELOADED_ADVICE = {json.dumps(advice)};\n'
    if analysis_path is not None:
        # so the page can ask follow-up questions about the same file
        inject += f'window.PRELOADED_PATH = {json.dumps(str(analysis_path))};\n'
    inject += '</script>\n'
    marker = '<script src="studio.js"'
    if marker not in source:
        _fail(f"{page.name} no longer loads studio.js the expected way; "
              "the launcher cannot inject the analysis.")
    html = source.replace(marker, inject + marker, 1)

    out = page.parent / "scope.html"
    out.write_text(html, encoding="utf-8")
    return out


@app.command()
def scope(
    track: Path = typer.Argument(..., help="Track directory, song.md, or an audio file."),
    audio: Optional[Path] = typer.Option(None, "--audio", help="Defaults to masters/master.wav."),
    out: Optional[Path] = typer.Option(None, "--out", help="Where to write the analysis JSON."),
    open_player: bool = typer.Option(False, "--open", help="Open the studio page on the result."),
    with_advice: bool = typer.Option(False, "--advise",
                                     help="Also ask a model what to do, and show it on the page."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Analyse a track and write the JSON the studio page reads.

    Reports what the loudness numbers alone cannot: whether the file has been
    through a lossy codec, where it clips, how it sits against the -14 LUFS
    target, and how it moves over time.
    """
    import webbrowser

    from music_studio.audio.analyze import AnalyzeError, analyze as _analyze

    _setup_logging(verbose)

    if track.is_file() and track.suffix.lower() != ".md":
        src, tdir = track, track.parent
    else:
        tdir = _track_dir(track)
        src = audio or (tdir / "masters" / "master.wav")
        if not src.is_file():
            _fail(f"No audio at {src}. Run `music master` first, or pass --audio.")

    dst = out or (tdir / "analysis.json")
    try:
        report = _analyze(src)
    except AnalyzeError as exc:
        _fail(str(exc))

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(report, separators=(",", ":")), encoding="utf-8")

    # The headline findings, so the terminal is useful without opening anything.
    codec = report.get("codec", {})
    clip = report.get("clipping", {})
    meas = report.get("measures", {})
    if meas.get("integrated_lufs") is not None:
        typer.echo(f"  {meas['integrated_lufs']:+.1f} LUFS   "
                   f"{meas.get('true_peak_dbtp', float('nan')):+.1f} dBTP   "
                   f"LRA {meas.get('lra', float('nan')):.1f}")
    if meas.get("true_peak_dbtp") is not None and meas["true_peak_dbtp"] > -1.0:
        typer.secho(f"  ✗ true peak {meas['true_peak_dbtp']:+.1f} dBTP is above the "
                    "-1.0 ceiling; it will distort on lossy playback.",
                    fg=typer.colors.RED)
    if codec.get("lossy_suspected"):
        typer.secho(f"  ✗ {codec.get('verdict')}", fg=typer.colors.RED)
    if clip.get("clipping_suspected"):
        typer.secho(f"  ✗ {clip.get('clipped_samples')} clipped samples "
                    f"in {clip.get('runs')} runs.", fg=typer.colors.YELLOW)

    _ok(f"Wrote {dst}")

    advice = None
    if with_advice:
        from music_studio.insight.advise import DEFAULT_MODEL, AdviseError, advise as _advise
        try:
            advice = _advise(report, None, DEFAULT_MODEL)
        except AdviseError as exc:
            # Advice is a bonus; a missing key must not lose the analysis.
            typer.secho(f"  (no advice: {exc})", fg=typer.colors.YELLOW, err=True)
        else:
            typer.echo("")
            typer.echo(advice)

    studio_dir = paths.web_dir()
    page = studio_dir / "index.html"
    if open_player:
        if not page.is_file():
            _fail(f"No studio page at {page}.")
        launcher = _write_launcher(page, report, src.name, advice, dst)
        webbrowser.open(launcher.as_uri())
        typer.echo(f"  opened {launcher.name}")
    else:
        typer.echo(f"  open {page}  and load {dst.name}")


@app.command()
def master(
    track: Path = typer.Argument(..., help="Track directory or song.md."),
    take: Optional[Path] = typer.Option(None, "--take", help="Which take to master."),
    out: Optional[Path] = typer.Option(None, "--out", help="Override the output path."),
    reference: Optional[Path] = typer.Option(None, "--reference",
                                             help="Match a reference recording instead of a target."),
    lufs: float = typer.Option(-14.0, "--lufs", help="Integrated loudness target."),
    tp: float = typer.Option(-1.0, "--tp", help="True peak ceiling, dBTP."),
    sample_rate: Optional[int] = typer.Option(None, "--sample-rate", help="Resample on output."),
    bit_depth: int = typer.Option(24, "--bit-depth"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Master a take to masters/master.wav."""
    from music_studio.audio.master import MasterError, master_loudnorm, master_reference

    _setup_logging(verbose)
    tdir = _track_dir(track)
    src = take or _pick_take(tdir)
    dst = out or (tdir / "masters" / "master.wav")

    if dst.resolve() == src.resolve():
        _fail("Refusing to overwrite the take. Masters and takes stay separate.")

    try:
        if reference:
            master_reference(src, dst, reference)
        else:
            master_loudnorm(src, dst, lufs=lufs, tp=tp,
                            sample_rate=sample_rate, bit_depth=bit_depth)
    except MasterError as exc:
        _fail(str(exc))
    _ok(f"Wrote {dst}")


@app.command()
def compare(
    track: Path = typer.Argument(..., help="Track directory, or the first file with --b."),
    b: Optional[Path] = typer.Option(None, "--b", help="Second file. Defaults to masters/master.wav."),
    a: Optional[Path] = typer.Option(None, "--a", help="First file. Defaults to the take."),
    null: Optional[Path] = typer.Option(None, "--null",
                                        help="Write the difference signal here, to listen to."),
    amplify: float = typer.Option(20.0, "--amplify", help="Boost the residue, dB."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Compare two versions numerically, and write a null test you can hear."""
    from music_studio.audio.compare import CompareError, compare as _compare

    _setup_logging(verbose)
    if a and b:
        first, second = a, b
    else:
        tdir = _track_dir(track)
        first = a or _pick_take(tdir)
        second = b or (tdir / "masters" / "master.wav")
        if not second.is_file():
            _fail(f"No master at {second}. Run `music master` first, or pass --b.")

    try:
        _compare(first, second, null, amplify)
    except CompareError as exc:
        _fail(str(exc))


@app.command()
def video(
    track: Path = typer.Argument(..., help="Track directory or song.md."),
    art: Optional[Path] = typer.Option(None, "--art", help="Artwork. Defaults to artwork/cover*."),
    audio: Optional[Path] = typer.Option(None, "--audio", help="Defaults to masters/master.wav."),
    zoom: bool = typer.Option(False, "--zoom", help="Slow Ken Burns zoom."),
    short: bool = typer.Option(False, "--short", help="Also write a vertical cut."),
    pad_colour: str = typer.Option("black", "--pad-colour", help="Fill colour for non-16:9 art."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Render the YouTube video and thumbnail from the master and artwork."""
    from music_studio.audio.trackvideo import TrackVideoError, build

    _setup_logging(verbose)
    tdir = _track_dir(track)

    src_audio = audio or (tdir / "masters" / "master.wav")
    if not src_audio.is_file():
        _fail(f"No master at {src_audio}. Run `music master` first.")

    if art is None:
        art_dir = tdir / "artwork"
        candidates = sorted(art_dir.glob("*.png")) + sorted(art_dir.glob("*.jpg")) \
            if art_dir.is_dir() else []
        if not candidates:
            _fail(f"No artwork in {art_dir}. Pass --art.")
        art = candidates[0]
        if len(candidates) > 1:
            typer.secho(f"note: using {art.name} of {len(candidates)} images.",
                        fg=typer.colors.YELLOW, err=True)

    try:
        written = build(src_audio, art, tdir / "video",
                        short=short, zoom=zoom, pad_colour=pad_colour, stem="video")
    except TrackVideoError as exc:
        _fail(str(exc))

    for p in written:
        typer.echo(f"  {p}  ({p.stat().st_size / 1e6:.1f} MB)")
    _ok("Rendered.")


@app.command()
def publish(
    track: Path = typer.Argument(..., help="Track directory or song.md."),
    update: bool = typer.Option(False, "--update", help="Edit an existing video's metadata."),
    privacy: Optional[str] = typer.Option(None, "--privacy",
                                          help="private | unlisted | public."),
    publish_at: Optional[str] = typer.Option(None, "--publish-at",
                                             help="RFC3339 UTC for a scheduled release."),
    thumbnail_only: bool = typer.Option(False, "--thumbnail-only"),
    secrets: Path = typer.Option(Path("client_secrets.json"), "--secrets"),
    token: Path = typer.Option(Path("token.json"), "--token"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print what would be sent."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Upload to YouTube, or push edited metadata to an existing video."""
    import ytpublish

    song = _song_file(track)
    argv = ["--song", str(song), "--secrets", str(secrets), "--token", str(token)]
    if update:
        argv.append("--update")
    if thumbnail_only:
        argv.append("--thumbnail-only")
    if privacy:
        argv += ["--privacy", privacy]
    if publish_at:
        argv += ["--publish-at", publish_at]
    if dry_run:
        argv.append("--dry-run")
    if verbose:
        argv.append("--verbose")

    raise typer.Exit(ytpublish.main(argv))


@app.command()
def doctor() -> None:
    """Check that the tools and libraries this CLI needs are present."""
    rows: list[tuple[str, bool, str]] = []
    for tool in ("ffmpeg", "ffprobe"):
        rows.append((tool, shutil.which(tool) is not None, "brew install ffmpeg"))
    for mod, hint in (
        ("soundfile", "pip install soundfile"),
        ("numpy", "pip install numpy"),
        ("scipy", "pip install scipy"),
        ("matchering", "pip install matchering  (only for --reference)"),
        ("googleapiclient", "pip install google-api-python-client google-auth-oauthlib"),
    ):
        try:
            __import__(mod)
            rows.append((mod, True, ""))
        except ImportError:
            rows.append((mod, False, hint))

    width = max(len(n) for n, _, _ in rows)
    missing = 0
    for name, present, hint in rows:
        mark = "✓" if present else "✗"
        colour = typer.colors.GREEN if present else typer.colors.RED
        typer.secho(f"  {mark} {name:<{width}}  {hint if not present else ''}", fg=colour)
        missing += not present

    typer.echo("")
    if missing:
        typer.secho(f"{missing} missing.", fg=typer.colors.YELLOW)
        raise typer.Exit(1)
    _ok("All present.")


def main() -> None:
    """The `music` console script.

    A named function rather than pointing the entry point straight at `app`:
    setuptools needs something callable with no arguments, and a wrapper is
    also where anything that must happen before Typer takes over would go.
    """
    app()


if __name__ == "__main__":
    main()
