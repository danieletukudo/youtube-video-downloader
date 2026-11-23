# youtube-video-downloader

Download YouTube videos and playlists as MP4 with a local HTML UI. Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Features

- Preview a playlist or single video before downloading
- Select which videos to save
- MP4 output (audio-only MP3 optional)
- Choose the save folder on your machine
- Resume interrupted downloads

## Run with Docker

```bash
docker compose up --build
```

Open [http://127.0.0.1:5050](http://127.0.0.1:5050).

Files are saved into `./downloads` on the host (mapped to `/data` in the container). Change the volume in `docker-compose.yml` to point at any folder, for example:

```yaml
volumes:
  - /Users/you/Movies/YouTube:/data
```

### Plain Docker

```bash
docker build -t youtube-video-downloader .
docker run --rm -p 5050:5050 -v "$PWD/downloads:/data" youtube-video-downloader
```

## Run locally (without Docker)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Recommended extras:

```bash
brew install ffmpeg deno
```

## CLI

```bash
python download_playlist.py "https://www.youtube.com/playlist?list=PLxxxx"
python download_playlist.py "URL" -o ./my_videos -i 1-5 -q 720
python download_playlist.py "URL" --audio-only
```

## Deploy notes

- The container listens on `0.0.0.0:$PORT` (default `5050`).
- Set `DOWNLOAD_DIR` to control the default save path inside the container.
- Mount a persistent volume at that path so downloads survive restarts.
- **Browse…** only works when the app runs on your own computer. On a deployed server it cannot see your PC’s folders — after a video is fetched, use **Download** or **Download all as ZIP** in the UI; your browser saves the file locally.

## License / use

Only download content you have the right to save (your own uploads, Creative Commons, or permission from the owner).
