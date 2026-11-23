"""Shared yt-dlp download helpers used by the CLI and web app."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable

from yt_dlp import YoutubeDL

ProgressCallback = Callable[[dict[str, Any]], None]

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".avi"}
AUDIO_EXTS = {".mp3", ".m4a", ".opus", ".wav"}


def is_playlist_url(url: str) -> bool:
    lower = url.lower()
    if "/playlist" in lower:
        return True
    # watch URLs often include &list= — treat those as single videos by default
    return False


def build_opts(
    output_dir: Path,
    audio_only: bool,
    quality: str,
    items: str | None,
    progress_hooks: list[ProgressCallback] | None = None,
    *,
    noplaylist: bool = False,
    numbered: bool = True,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)

    if audio_only:
        format_selector = "bestaudio/best"
        postprocessors = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]
        merge_fmt = None
    else:
        # Prefer MP4-compatible streams; remux everything to .mp4.
        format_selector = (
            f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/"
            f"bestvideo[height<={quality}]+bestaudio/"
            f"best[height<={quality}][ext=mp4]/best[height<={quality}]/best"
        )
        postprocessors = [
            {
                "key": "FFmpegVideoRemuxer",
                "preferedformat": "mp4",
            }
        ]
        merge_fmt = "mp4"

    if numbered:
        outtmpl = str(output_dir / "%(playlist_index)03d - %(title)s.%(ext)s")
    else:
        outtmpl = str(output_dir / "%(title)s.%(ext)s")

    opts: dict = {
        "format": format_selector,
        "outtmpl": outtmpl,
        "ignoreerrors": True,
        "noplaylist": noplaylist,
        "continuedl": True,
        "retries": 5,
        "fragment_retries": 5,
        "download_archive": str(output_dir / ".download_archive.txt"),
        "writethumbnail": False,
        "quiet": True,
        "no_warnings": True,
        "progress": True,
        "noprogress": False,
    }

    if merge_fmt:
        opts["merge_output_format"] = merge_fmt
    if postprocessors:
        opts["postprocessors"] = postprocessors
    if items and not noplaylist:
        opts["playlist_items"] = items
    if progress_hooks:
        opts["progress_hooks"] = progress_hooks

    return opts


def _watch_url(entry: dict[str, Any]) -> str | None:
    vid = entry.get("id")
    for key in ("webpage_url", "url", "original_url"):
        value = entry.get(key)
        if isinstance(value, str) and ("youtube.com" in value or "youtu.be" in value):
            return value
    if vid:
        return f"https://www.youtube.com/watch?v={vid}"
    return None


def _video_entry(entry: dict[str, Any], index: int) -> dict[str, Any]:
    duration = entry.get("duration")
    vid = entry.get("id")
    return {
        "index": entry.get("playlist_index") or index,
        "id": vid,
        "title": entry.get("title") or "Untitled",
        "url": _watch_url(entry),
        "duration": duration,
        "duration_string": _format_duration(duration),
        "channel": entry.get("uploader") or entry.get("channel"),
        "thumbnail": entry.get("thumbnail")
        or (f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else None),
    }


def fetch_playlist(
    url: str,
    items: str | None = None,
) -> dict[str, Any]:
    """List playlist or single-video metadata without downloading."""
    single = not is_playlist_url(url)
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "ignoreerrors": True,
        "noplaylist": single,
    }
    if items and not single:
        opts["playlist_items"] = items

    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info is None:
            raise RuntimeError("Could not fetch video/playlist info.")

        raw_entries = info.get("entries")
        videos: list[dict[str, Any]] = []

        if raw_entries:
            if not isinstance(raw_entries, list):
                raw_entries = list(raw_entries)
            for i, entry in enumerate(raw_entries, start=1):
                if not entry:
                    continue
                videos.append(_video_entry(entry, i))
            kind = "playlist"
            title = info.get("title") or "Unknown playlist"
        else:
            # Single video result
            videos = [_video_entry(info, 1)]
            kind = "video"
            title = info.get("title") or "Untitled video"

        return {
            "title": title,
            "id": info.get("id"),
            "count": len(videos),
            "kind": kind,
            "videos": videos,
        }


def download_playlist(
    url: str,
    output_dir: Path,
    audio_only: bool = False,
    quality: str = "1080",
    items: str | None = None,
    progress_hook: ProgressCallback | None = None,
    video_urls: list[str] | None = None,
) -> dict[str, Any]:
    hooks = [progress_hook] if progress_hook else None

    # Explicit video URL list (single video or cherry-picked playlist items)
    if video_urls:
        cleaned = [u.strip() for u in video_urls if isinstance(u, str) and u.strip()]
        if not cleaned:
            raise RuntimeError("No video URLs to download.")

        opts = build_opts(
            output_dir,
            audio_only,
            quality,
            items=None,
            progress_hooks=hooks,
            noplaylist=True,
            numbered=False,
        )
        with YoutubeDL(opts) as ydl:
            if len(cleaned) == 1:
                info = ydl.extract_info(cleaned[0], download=True)
                if info is None:
                    raise RuntimeError("Could not download video.")
                return {
                    "title": info.get("title") or "Video",
                    "count": 1,
                    "id": info.get("id"),
                    "output_dir": str(output_dir.resolve()),
                }

            ydl.download(cleaned)
            return {
                "title": f"{len(cleaned)} videos",
                "count": len(cleaned),
                "id": None,
                "output_dir": str(output_dir.resolve()),
            }

    single = not is_playlist_url(url)
    opts = build_opts(
        output_dir,
        audio_only,
        quality,
        items,
        hooks,
        noplaylist=single,
        numbered=not single,
    )

    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None:
            raise RuntimeError("Could not fetch video/playlist info.")

        entries = info.get("entries")
        if entries is not None:
            if not isinstance(entries, list):
                entries = list(entries)
            count = len(entries)
        else:
            count = 1

        return {
            "title": info.get("title") or ("Unknown playlist" if not single else "Untitled video"),
            "count": count,
            "id": info.get("id"),
            "output_dir": str(output_dir.resolve()),
        }


def list_downloaded_files(output_dir: Path) -> list[dict[str, Any]]:
    if not output_dir.exists():
        return []

    files = []
    for path in sorted(output_dir.iterdir()):
        if not path.is_file():
            continue
        if path.name.startswith(".") or path.suffix in {".part", ".ytdl"}:
            continue
        if path.suffix.lower() not in VIDEO_EXTS | AUDIO_EXTS:
            continue
        files.append(
            {
                "name": path.name,
                "size": path.stat().st_size,
                "modified": path.stat().st_mtime,
                "ext": path.suffix.lower().lstrip("."),
            }
        )
    return files


def convert_dir_to_mp4(
    output_dir: Path,
    delete_original: bool = True,
) -> dict[str, Any]:
    """Remux/convert non-MP4 videos in a folder to MP4."""
    if not output_dir.exists():
        return {"converted": [], "failed": [], "skipped": []}

    converted: list[str] = []
    failed: list[dict[str, str]] = []
    skipped: list[str] = []

    sources = sorted(
        p
        for p in output_dir.iterdir()
        if p.is_file()
        and p.suffix.lower() in VIDEO_EXTS - {".mp4"}
        and not p.name.startswith(".")
    )

    for src in sources:
        dest = src.with_suffix(".mp4")
        if dest.exists():
            skipped.append(src.name)
            continue
        try:
            _to_mp4(src, dest)
            if delete_original:
                src.unlink(missing_ok=True)
            converted.append(dest.name)
        except Exception as exc:  # noqa: BLE001
            if dest.exists():
                dest.unlink(missing_ok=True)
            failed.append({"file": src.name, "error": str(exc)})

    return {"converted": converted, "failed": failed, "skipped": skipped}


def _to_mp4(src: Path, dest: Path) -> None:
    # Fast path: remux without re-encoding.
    remux = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    result = subprocess.run(remux, capture_output=True, text=True)
    if result.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
        return

    if dest.exists():
        dest.unlink(missing_ok=True)

    # Fallback: re-encode to H.264 + AAC.
    encode = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    result = subprocess.run(encode, capture_output=True, text=True)
    if result.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        raise RuntimeError(result.stderr.strip() or "ffmpeg failed")


def _format_duration(seconds: float | int | None) -> str | None:
    if seconds is None:
        return None
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return None
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"
