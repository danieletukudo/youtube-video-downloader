#!/usr/bin/env python3
"""Download all videos from a YouTube playlist using yt-dlp."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from downloader import download_playlist


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download a YouTube playlist with yt-dlp.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "url",
        help="YouTube playlist URL (or a video URL that belongs to a playlist)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("downloads"),
        help="Directory where files are saved",
    )
    parser.add_argument(
        "-a",
        "--audio-only",
        action="store_true",
        help="Download audio only and convert to MP3 (requires ffmpeg)",
    )
    parser.add_argument(
        "-q",
        "--quality",
        default="1080",
        choices=["360", "480", "720", "1080", "1440", "2160"],
        help="Max video height in pixels",
    )
    parser.add_argument(
        "-i",
        "--items",
        default=None,
        help='Playlist items to download, e.g. "1-5", "1,3,7", or "10:"',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        print(f"Playlist : {args.url}")
        print(f"Output   : {args.output.resolve()}")
        print(
            f"Mode     : {'audio (mp3)' if args.audio_only else f'video (≤{args.quality}p)'}"
        )
        if args.items:
            print(f"Items    : {args.items}")
        print()

        result = download_playlist(
            url=args.url,
            output_dir=args.output,
            audio_only=args.audio_only,
            quality=args.quality,
            items=args.items,
        )
        print(f"Finished: {result['title']} ({result['count']} videos)")
        print("Done.")
        return 0
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
