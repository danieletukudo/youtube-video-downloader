(() => {
  const form = document.getElementById("form");
  const submitBtn = document.getElementById("submit");
  const previewBtn = document.getElementById("previewBtn");
  const browseBtn = document.getElementById("browseBtn");
  const refreshBtn = document.getElementById("refresh");
  const selectAllBtn = document.getElementById("selectAll");
  const selectNoneBtn = document.getElementById("selectNone");
  const outputDirInput = document.getElementById("outputDir");
  const folderField = document.getElementById("folderField");
  const serverHint = document.getElementById("serverHint");
  const localHint = document.getElementById("localHint");
  const modeBanner = document.getElementById("modeBanner");
  const zipBtn = document.getElementById("zipBtn");
  const statusEl = document.getElementById("status");
  const statusTitle = document.getElementById("statusTitle");
  const statusMeta = document.getElementById("statusMeta");
  const barFill = document.getElementById("barFill");
  const nowPlaying = document.getElementById("nowPlaying");
  const banner = document.getElementById("banner");
  const empty = document.getElementById("empty");
  const fileList = document.getElementById("fileList");
  const preview = document.getElementById("preview");
  const previewTitle = document.getElementById("previewTitle");
  const previewMeta = document.getElementById("previewMeta");
  const videoList = document.getElementById("videoList");

  let eventSource = null;
  let playlistLoaded = false;
  let saveTimer = null;
  let serverMode = false;

  function formatBytes(n) {
    if (!n && n !== 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatSpeed(bps) {
    if (!bps) return "";
    return `${formatBytes(bps)}/s`;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function showBanner(message, kind) {
    banner.textContent = message;
    banner.className = `banner visible ${kind}`;
  }

  function clearBanner() {
    banner.className = "banner";
    banner.textContent = "";
  }

  function currentOutputDir() {
    return outputDirInput.value.trim();
  }

  function applyServerMode(enabled) {
    serverMode = Boolean(enabled);
    folderField.classList.toggle("folder-field-server", serverMode);
    serverHint.hidden = !serverMode;
    localHint.hidden = serverMode;
    modeBanner.hidden = !serverMode;
    outputDirInput.required = !serverMode;
    browseBtn.disabled = serverMode;
  }

  function selectedCheckboxes() {
    return [...videoList.querySelectorAll('input[type="checkbox"]:checked')];
  }

  function selectedIndices() {
    return selectedCheckboxes().map((el) => Number(el.value));
  }

  function selectedUrls() {
    return selectedCheckboxes()
      .map((el) => el.dataset.url)
      .filter(Boolean);
  }

  function updateDownloadButton() {
    const n = selectedCheckboxes().length;
    const total = videoList.querySelectorAll("input").length;
    const single = total === 1;
    submitBtn.disabled = !playlistLoaded || n === 0 || submitBtn.dataset.busy === "1";
    if (submitBtn.dataset.busy !== "1") {
      if (single && n === 1) {
        submitBtn.textContent = "Download video";
      } else {
        submitBtn.textContent =
          n > 0 ? `Download selected (${n})` : "Download selected";
      }
    }
    if (playlistLoaded) {
      previewMeta.textContent = single
        ? "1 video ready"
        : `${n} of ${total} selected`;
    }
  }

  function setBusy(busy) {
    submitBtn.dataset.busy = busy ? "1" : "0";
    previewBtn.disabled = busy;
    browseBtn.disabled = busy || serverMode;
    if (busy) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Downloading…";
    } else {
      updateDownloadButton();
    }
  }

  function renderVideos(playlist) {
    preview.hidden = false;
    playlistLoaded = true;
    previewTitle.textContent = playlist.title || "Playlist";
    videoList.innerHTML = (playlist.videos || [])
      .map((v) => {
        const thumb = v.thumbnail
          ? `<img class="video-thumb" src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />`
          : `<span class="video-thumb" aria-hidden="true"></span>`;
        const urlAttr = v.url ? ` data-url="${escapeHtml(v.url)}"` : "";
        return `
          <li>
            <label>
              <input type="checkbox" value="${v.index}"${urlAttr} checked />
              <span class="video-index">${String(v.index).padStart(2, "0")}</span>
              ${thumb}
              <span class="video-title">${escapeHtml(v.title)}</span>
              <span class="video-duration">${escapeHtml(v.duration_string || "—")}</span>
            </label>
          </li>`;
      })
      .join("");
    updateDownloadButton();
  }

  async function loadSettings() {
    const res = await fetch("/api/settings");
    const data = await res.json();
    applyServerMode(data.server_mode || data.mode === "server");
    if (data.output_dir) {
      outputDirInput.value = data.output_dir;
    }
  }

  async function saveOutputDir(dir) {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_dir: dir }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not save folder");
    if (data.output_dir) outputDirInput.value = data.output_dir;
    return data.output_dir;
  }

  async function loadFiles() {
    try {
      const dir = currentOutputDir();
      const qs =
        !serverMode && dir ? `?dir=${encodeURIComponent(dir)}` : "";
      const res = await fetch(`/api/files${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not list files");

      if (typeof data.server_mode === "boolean") {
        applyServerMode(data.server_mode);
      }
      if (data.output_dir && data.output_dir !== outputDirInput.value) {
        outputDirInput.value = data.output_dir;
      }

      const files = data.files || [];
      if (!files.length) {
        empty.hidden = false;
        empty.textContent = serverMode
          ? "No files yet. Load a video, download it, then save it to your PC from this list."
          : `No files yet in ${data.output_dir || "this folder"}.`;
        fileList.hidden = true;
        fileList.innerHTML = "";
        zipBtn.hidden = true;
        return;
      }

      empty.hidden = true;
      fileList.hidden = false;
      zipBtn.hidden = false;
      zipBtn.href = data.zip_url || "/api/files/zip";
      fileList.innerHTML = files
        .map((f) => {
          const href = f.download_url || `/api/files/download/${encodeURIComponent(f.name)}`;
          return `
          <li>
            <span class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="size">${formatBytes(f.size)} · ${escapeHtml(f.ext || "")}</span>
            <a class="file-dl" href="${escapeHtml(href)}" download="${escapeHtml(f.name)}">Download</a>
          </li>`;
        })
        .join("");
    } catch (err) {
      empty.hidden = false;
      empty.textContent = err.message || "Could not list files.";
      fileList.hidden = true;
      zipBtn.hidden = true;
    }
  }

  function handleEvent(event) {
    if (event.type === "status") {
      statusEl.classList.add("visible");
      statusTitle.textContent =
        event.status === "running" ? "Downloading" : event.status;
      if (event.message) nowPlaying.textContent = event.message;
      return;
    }

    if (event.type === "progress") {
      statusEl.classList.add("visible");
      const idx = event.playlist_index;
      const count = event.playlist_count;
      if (idx && count) {
        statusMeta.textContent = `${idx} / ${count}`;
        const overall = Math.min(
          100,
          ((idx - 1) / count) * 100 + (event.percent || 0) / count
        );
        barFill.style.width = `${overall}%`;
      } else if (event.percent != null) {
        barFill.style.width = `${event.percent}%`;
        statusMeta.textContent = `${event.percent}%`;
      }

      const bits = [];
      if (event.title) bits.push(event.title);
      if (event.speed) bits.push(formatSpeed(event.speed));
      if (event.eta != null) bits.push(`ETA ${event.eta}s`);
      nowPlaying.innerHTML = bits.length
        ? `<strong>${escapeHtml(bits[0])}</strong>${
            bits.slice(1).length ? " · " + bits.slice(1).map(escapeHtml).join(" · ") : ""
          }`
        : "";
      return;
    }

    if (event.type === "done") {
      setBusy(false);
      statusTitle.textContent = "Complete";
      barFill.style.width = "100%";
      const title = event.result?.title || "Playlist";
      const count = event.result?.count ?? "";
      nowPlaying.textContent = `${title}${count !== "" ? ` — ${count} videos` : ""}`;
      showBanner(
        serverMode
          ? "Ready on the server — use Download / Download all as ZIP to save to your PC."
          : `Saved to ${event.result?.output_dir || currentOutputDir()}`,
        "ok"
      );
      loadFiles();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      return;
    }

    if (event.type === "error") {
      setBusy(false);
      statusTitle.textContent = "Failed";
      showBanner(event.message || "Download failed", "err");
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }
  }

  browseBtn.addEventListener("click", async () => {
    clearBanner();
    if (serverMode) {
      showBanner(
        "Browse only works when the app runs on your computer. Use the Download buttons to save files to your PC.",
        "err"
      );
      return;
    }
    browseBtn.disabled = true;
    browseBtn.textContent = "Opening…";
    try {
      if (currentOutputDir()) {
        try {
          await saveOutputDir(currentOutputDir());
        } catch {
          // ignore
        }
      }
      const res = await fetch("/api/browse-folder", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not open folder picker");
      if (data.cancelled) {
        showBanner("Folder selection cancelled.", "err");
      } else {
        outputDirInput.value = data.output_dir;
        showBanner(`Save folder set to ${data.output_dir}`, "ok");
        await loadFiles();
      }
    } catch (err) {
      showBanner(err.message || "Browse failed", "err");
    } finally {
      browseBtn.disabled = serverMode;
      browseBtn.textContent = "Browse…";
    }
  });

  outputDirInput.addEventListener("change", () => {
    if (serverMode) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const dir = currentOutputDir();
      if (!dir) return;
      try {
        await saveOutputDir(dir);
        await loadFiles();
      } catch (err) {
        showBanner(err.message || "Invalid folder", "err");
      }
    }, 300);
  });

  previewBtn.addEventListener("click", async () => {
    clearBanner();
    const url = document.getElementById("url").value.trim();
    if (!url) {
      showBanner("Paste a video or playlist URL first.", "err");
      return;
    }

    previewBtn.disabled = true;
    previewBtn.textContent = "Loading…";
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          items: document.getElementById("items").value.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load");
      if (!data.videos?.length) throw new Error("No videos found");
      renderVideos(data);
      const msg =
        data.kind === "video" || data.count === 1
          ? "Video loaded. Click Download video."
          : `Loaded ${data.count} videos. Select what to download.`;
      showBanner(msg, "ok");
    } catch (err) {
      playlistLoaded = false;
      preview.hidden = true;
      submitBtn.disabled = true;
      showBanner(err.message || "Preview failed", "err");
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = "Load";
    }
  });

  videoList.addEventListener("change", updateDownloadButton);

  selectAllBtn.addEventListener("click", () => {
    videoList.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.checked = true;
    });
    updateDownloadButton();
  });

  selectNoneBtn.addEventListener("click", () => {
    videoList.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.checked = false;
    });
    updateDownloadButton();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearBanner();

    if (!playlistLoaded) {
      showBanner("Load the video/playlist first so you can preview.", "err");
      return;
    }

    const selected = selectedIndices();
    if (!selected.length) {
      showBanner("Select at least one video.", "err");
      return;
    }

    const outputDir = currentOutputDir();
    if (!serverMode && !outputDir) {
      showBanner("Choose a save folder first.", "err");
      return;
    }

    const urls = selectedUrls();
    const payload = {
      url: document.getElementById("url").value.trim(),
      quality: document.getElementById("quality").value,
      audio_only: document.getElementById("audio_only").checked,
      selected,
      video_urls: urls,
    };
    if (!serverMode) payload.output_dir = outputDir;

    setBusy(true);
    statusEl.classList.add("visible");
    statusTitle.textContent = "Starting…";
    statusMeta.textContent = "";
    barFill.style.width = "0%";
    nowPlaying.textContent = "Connecting to YouTube…";

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start download");

      if (data.output_dir) outputDirInput.value = data.output_dir;

      if (eventSource) eventSource.close();
      eventSource = new EventSource(`/api/jobs/${data.job_id}/events`);
      eventSource.onmessage = (msg) => {
        try {
          handleEvent(JSON.parse(msg.data));
        } catch {
          // ignore malformed events
        }
      };
    } catch (err) {
      setBusy(false);
      showBanner(err.message || "Something went wrong", "err");
    }
  });

  refreshBtn.addEventListener("click", loadFiles);

  loadSettings()
    .then(loadFiles)
    .catch(() => loadFiles());
})();
