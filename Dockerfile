FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=5050 \
    DOWNLOAD_DIR=/data \
    RUNNING_IN_DOCKER=1

# ffmpeg for merge/remux; curl for deno install
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py downloader.py download_playlist.py ./
COPY static ./static

RUN mkdir -p /data \
    && useradd --create-home --uid 1000 appuser \
    && chown -R appuser:appuser /app /data

USER appuser

VOLUME ["/data"]
EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5050/', timeout=3)"

CMD ["python", "app.py"]
