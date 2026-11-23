#!/usr/bin/env python3
"""Web UI for the YouTube playlist downloader."""

from __future__ import annotations

import json
import os
import platform
import subprocess
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from downloader import (
    convert_dir_to_mp4,
    download_playlist,
    fetch_playlist,
    list_downloaded_files,
)

ROOT = Path(__file__).resolve().parent
DEFAULT_DOWNLOADS = Path(
    os.environ.get("DOWNLOAD_DIR") or (ROOT / "downloads")
).expanduser()
STATIC = ROOT / "static"
SETTINGS_PATH = ROOT / "settings.json"

app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")

# In-memory job store (single-user local app)
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_settings_lock = threading.Lock()


def _load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
    return {"output_dir": str(DEFAULT_DOWNLOADS)}


def _save_settings(settings: dict) -> None:
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def _get_output_dir() -> Path:
    with _settings_lock:
        settings = _load_settings()
        raw = (settings.get("output_dir") or str(DEFAULT_DOWNLOADS)).strip()
    return Path(raw).expanduser()


def _set_output_dir(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    if not resolved.is_dir():
        raise ValueError("Path is not a directory")
    if not os.access(resolved, os.W_OK):
        raise PermissionError(f"Folder is not writable: {resolved}")
    with _settings_lock:
        settings = _load_settings()
        settings["output_dir"] = str(resolved)
        _save_settings(settings)
    return resolved


def _resolve_output_dir(raw: str | None) -> Path:
    """Validate and persist an output directory from the client."""
    if raw and str(raw).strip():
        return _set_output_dir(Path(str(raw).strip()))
    path = _get_output_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def _pick_folder_native(start: Path | None = None) -> Path | None:
    """Open a native folder chooser. Returns None if cancelled."""
    default = start or _get_output_dir()
    system = platform.system()

    if system == "Darwin":
        script = (
            'try\n'
            f'set defaultPath to POSIX file "{default}"\n'
            'set chosen to choose folder with prompt '
            '"Choose where to save downloads" default location defaultPath\n'
            'return POSIX path of chosen\n'
            'on error\n'
            'return ""\n'
            'end try'
        )
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
        chosen = (result.stdout or "").strip()
        return Path(chosen) if chosen else None

    if system == "Linux":
        for cmd in (
            ["zenity", "--file-selection", "--directory", f"--filename={default}/"],
            ["kdialog", "--getexistingdirectory", str(default)],
        ):
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, check=False)
            except FileNotFoundError:
                continue
            chosen = (result.stdout or "").strip()
            if chosen:
                return Path(chosen)
        return None

    # Windows / fallback: tkinter
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(initialdir=str(default), title="Choose save folder")
        root.destroy()
        return Path(chosen) if chosen else None
    except Exception:  # noqa: BLE001
        return None


def _validate_youtube_url(url: str) -> str | None:
    url = (url or "").strip()
    if not url:
        return "Playlist URL is required"
    if "youtube.com" not in url and "youtu.be" not in url:
        return "Please paste a YouTube URL"
    return None


def _push_event(job_id: str, event: dict) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["events"].append(event)
        job["updated_at"] = time.time()
        if event.get("type") == "progress":
            job["progress"] = event
        elif event.get("type") == "status":
            job["status"] = event.get("status", job["status"])
            if "message" in event:
                job["message"] = event["message"]
        elif event.get("type") == "done":
            job["status"] = "done"
            job["result"] = event.get("result")
        elif event.get("type") == "error":
            job["status"] = "error"
            job["message"] = event.get("message", "Download failed")


def _run_download(job_id: str, payload: dict) -> None:
    def hook(d: dict) -> None:
        status = d.get("status")
        info = d.get("info_dict") or {}
        title = info.get("title") or d.get("filename") or "…"
        playlist_index = info.get("playlist_index")
        playlist_count = info.get("n_entries") or info.get("playlist_count")

        event: dict = {
            "type": "progress",
            "status": status,
            "title": title,
            "playlist_index": playlist_index,
            "playlist_count": playlist_count,
        }

        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            event["percent"] = round(downloaded / total * 100, 1) if total else None
            event["speed"] = d.get("speed")
            event["eta"] = d.get("eta")
            event["downloaded"] = downloaded
            event["total"] = total
        elif status == "finished":
            event["percent"] = 100

        _push_event(job_id, event)

    try:
        output_dir = Path(payload["output_dir"])
        _push_event(
            job_id,
            {
                "type": "status",
                "status": "running",
                "message": f"Saving to {output_dir}…",
            },
        )
        result = download_playlist(
            url=payload["url"],
            output_dir=output_dir,
            audio_only=payload.get("audio_only", False),
            quality=payload.get("quality", "1080"),
            items=payload.get("items") or None,
            video_urls=payload.get("video_urls") or None,
            progress_hook=hook,
        )
        _push_event(job_id, {"type": "done", "result": result})
    except Exception as exc:  # noqa: BLE001
        _push_event(job_id, {"type": "error", "message": str(exc)})


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/api/settings")
def get_settings():
    path = _get_output_dir()
    path.mkdir(parents=True, exist_ok=True)
    return jsonify({"output_dir": str(path.resolve())})


@app.post("/api/settings")
def update_settings():
    data = request.get_json(silent=True) or {}
    raw = (data.get("output_dir") or "").strip()
    if not raw:
        return jsonify({"error": "output_dir is required"}), 400
    try:
        path = _set_output_dir(Path(raw))
        return jsonify({"output_dir": str(path)})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400


@app.post("/api/browse-folder")
def browse_folder():
    """Open a native folder picker and remember the choice."""
    try:
        chosen = _pick_folder_native()
        if chosen is None:
            return jsonify({"cancelled": True, "output_dir": str(_get_output_dir().resolve())})
        path = _set_output_dir(chosen)
        return jsonify({"cancelled": False, "output_dir": str(path)})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500


@app.post("/api/preview")
def preview_playlist():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    err = _validate_youtube_url(url)
    if err:
        return jsonify({"error": err}), 400

    items = (data.get("items") or "").strip() or None
    try:
        playlist = fetch_playlist(url, items=items)
        return jsonify(playlist)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500


@app.post("/api/download")
def start_download():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    err = _validate_youtube_url(url)
    if err:
        return jsonify({"error": err}), 400

    quality = str(data.get("quality") or "1080")
    if quality not in {"360", "480", "720", "1080", "1440", "2160"}:
        return jsonify({"error": "Invalid quality"}), 400

    try:
        output_dir = _resolve_output_dir(data.get("output_dir"))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Save folder: {exc}"}), 400

    # Prefer explicit video URLs from the preview UI (works for single + playlist).
    raw_urls = data.get("video_urls")
    video_urls = None
    if isinstance(raw_urls, list) and raw_urls:
        video_urls = [u.strip() for u in raw_urls if isinstance(u, str) and u.strip()]
        if not video_urls:
            return jsonify({"error": "Select at least one video"}), 400

    selected = data.get("selected")
    items = None
    if not video_urls and isinstance(selected, list) and selected:
        try:
            indices = sorted({int(x) for x in selected if int(x) > 0})
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid video selection"}), 400
        if not indices:
            return jsonify({"error": "Select at least one video"}), 400
        items = ",".join(str(i) for i in indices)
    elif not video_urls:
        items = (data.get("items") or "").strip() or None

    audio_only = bool(data.get("audio_only"))

    with _jobs_lock:
        for job in _jobs.values():
            if job["status"] in {"queued", "running"}:
                return jsonify({"error": "A download is already running"}), 409

        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Queued",
            "events": [],
            "progress": None,
            "result": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    thread = threading.Thread(
        target=_run_download,
        args=(
            job_id,
            {
                "url": url,
                "quality": quality,
                "items": items,
                "audio_only": audio_only,
                "video_urls": video_urls,
                "output_dir": str(output_dir),
            },
        ),
        daemon=True,
    )
    thread.start()
    return jsonify(
        {
            "job_id": job_id,
            "items": items,
            "video_count": len(video_urls or []),
            "output_dir": str(output_dir),
        }
    )


@app.get("/api/jobs/<job_id>")
def job_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        return jsonify(
            {
                "id": job["id"],
                "status": job["status"],
                "message": job.get("message"),
                "progress": job.get("progress"),
                "result": job.get("result"),
            }
        )


@app.get("/api/jobs/<job_id>/events")
def job_events(job_id: str):
    """Server-Sent Events stream for live progress."""

    def stream():
        cursor = 0
        while True:
            with _jobs_lock:
                job = _jobs.get(job_id)
                if not job:
                    yield f"data: {json.dumps({'type': 'error', 'message': 'Job not found'})}\n\n"
                    break
                events = job["events"][cursor:]
                cursor = len(job["events"])
                status = job["status"]

            for event in events:
                yield f"data: {json.dumps(event)}\n\n"

            if status in {"done", "error"}:
                break

            time.sleep(0.35)

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/files")
def files():
    raw = request.args.get("dir")
    try:
        output_dir = _resolve_output_dir(raw) if raw else _get_output_dir().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400
    return jsonify(
        {
            "output_dir": str(output_dir),
            "files": list_downloaded_files(output_dir),
        }
    )


@app.post("/api/convert-mp4")
def convert_mp4():
    data = request.get_json(silent=True) or {}
    try:
        output_dir = _resolve_output_dir(data.get("output_dir"))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400
    result = convert_dir_to_mp4(output_dir, delete_original=True)
    result["output_dir"] = str(output_dir)
    return jsonify(result)


def main() -> None:
    DEFAULT_DOWNLOADS.mkdir(parents=True, exist_ok=True)
    if not SETTINGS_PATH.exists():
        _save_settings({"output_dir": str(DEFAULT_DOWNLOADS.resolve())})

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5050"))
    print(f"Playlist Grab → http://{host}:{port}")
    print(f"Save folder   → {_get_output_dir().resolve()}")
    app.run(host=host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
