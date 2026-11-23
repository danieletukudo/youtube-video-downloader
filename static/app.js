(() => {
  const form = document.getElementById("form");
  const submitBtn = document.getElementById("submit");
  const previewBtn = document.getElementById("previewBtn");
  const browseBtn = document.getElementById("browseBtn");
  const refreshBtn = document.getElementById("refresh");
  const selectAllBtn = document.getElementById("selectAll");
  const selectNoneBtn = document.getElementById("selectNone");
  const folderLabel = document.getElementById("folderLabel");
  const folderHint = document.getElementById("folderHint");
  const zipBtn = document.getElementById("zipBtn");
  const saveAllBtn = document.getElementById("saveAllBtn");
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
  /** @type {FileSystemDirectoryHandle | null} */
  let dirHandle = null;
  let latestFiles = [];
  let filesBeforeJob = new Set();
  let pendingSaveCount = 0;

  const supportsDirPicker = typeof window.showDirectoryPicker === "function";

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

  function updateFolderLabel() {
    if (dirHandle) {
      folderLabel.value = dirHandle.name;
      folderHint.textContent =
        "Videos will be written into this folder on your computer after they finish.";
    } else if (supportsDirPicker) {
      folderLabel.value = "";
      folderHint.textContent =
        "Click Browse… to pick a folder on this PC (Chrome / Edge).";
    } else {
      folderLabel.value = "";
      folderHint.textContent =
        "This browser can’t pick folders. Use the Download links, or open the site in Chrome / Edge.";
      browseBtn.disabled = true;
    }
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
    browseBtn.disabled = busy || !supportsDirPicker;
    if (busy) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Downloading…";
    } else {
      updateDownloadButton();
    }
  }

  async function pickFolder() {
    if (!supportsDirPicker) {
      throw new Error(
        "Folder picker needs Chrome or Edge (File System Access API)."
      );
    }
    const handle = await window.showDirectoryPicker({
      mode: "readwrite",
      id: "playlist-grab-save",
      startIn: "downloads",
    });
    // Verify we can write (prompts for permission if needed)
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      throw new Error("Permission to write to that folder was denied.");
    }
    dirHandle = handle;
    updateFolderLabel();
    return handle;
  }

  async function ensureFolder() {
    if (dirHandle) {
      const perm = await dirHandle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") return dirHandle;
      const next = await dirHandle.requestPermission({ mode: "readwrite" });
      if (next === "granted") return dirHandle;
    }
    return pickFolder();
  }

  async function writeFileToFolder(fileMeta) {
    const handle = await ensureFolder();
    const url = fileMeta.download_url || `/api/files/download/${encodeURIComponent(fileMeta.name)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch ${fileMeta.name}`);
    const blob = await res.blob();
    const fileHandle = await handle.getFileHandle(fileMeta.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async function saveFilesToFolder(files) {
    if (!files.length) {
      showBanner("No files to save yet.", "err");
      return;
    }
    try {
      await ensureFolder();
      let ok = 0;
      for (const file of files) {
        nowPlaying.textContent = `Saving ${file.name} to your folder…`;
        await writeFileToFolder(file);
        ok += 1;
      }
      showBanner(
        `Saved ${ok} file${ok === 1 ? "" : "s"} to “${dirHandle.name}” on this PC.`,
        "ok"
      );
      nowPlaying.textContent = `Saved to ${dirHandle.name}`;
    } catch (err) {
      if (err && err.name === "AbortError") {
        showBanner("Folder selection cancelled.", "err");
        return;
      }
      showBanner(err.message || "Could not save to folder", "err");
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

  async function loadFiles() {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not list files");

      latestFiles = data.files || [];
      if (!latestFiles.length) {
        empty.hidden = false;
        empty.textContent = "No files yet.";
        fileList.hidden = true;
        fileList.innerHTML = "";
        zipBtn.hidden = true;
        saveAllBtn.hidden = true;
        return;
      }

      empty.hidden = true;
      fileList.hidden = false;
      zipBtn.hidden = false;
      saveAllBtn.hidden = !supportsDirPicker;
      zipBtn.href = data.zip_url || "/api/files/zip";
      fileList.innerHTML = latestFiles
        .map((f) => {
          const href =
            f.download_url || `/api/files/download/${encodeURIComponent(f.name)}`;
          return `
          <li>
            <span class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="size">${formatBytes(f.size)} · ${escapeHtml(f.ext || "")}</span>
            <button class="file-dl" type="button" data-save="${escapeHtml(f.name)}">Save to folder</button>
            <a class="file-dl" href="${escapeHtml(href)}" download="${escapeHtml(f.name)}">Download</a>
          </li>`;
        })
        .join("");
    } catch (err) {
      empty.hidden = false;
      empty.textContent = err.message || "Could not list files.";
      fileList.hidden = true;
      zipBtn.hidden = true;
      saveAllBtn.hidden = true;
    }
  }

  function handleEvent(event) {
    if (event.type === "status") {
      statusEl.classList.add("visible");
      statusTitle.textContent =
        event.status === "running" ? "Fetching" : event.status;
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
      loadFiles().then(async () => {
        if (supportsDirPicker) {
          let toSave = latestFiles.filter((f) => !filesBeforeJob.has(f.name));
          if (!toSave.length && pendingSaveCount > 0) {
            toSave = [...latestFiles]
              .sort((a, b) => (b.modified || 0) - (a.modified || 0))
              .slice(0, pendingSaveCount);
          }
          showBanner("Fetching done — saving into your chosen folder…", "ok");
          await saveFilesToFolder(toSave.length ? toSave : latestFiles);
        } else {
          showBanner(
            "Fetching done. Use Download / ZIP to save files on this PC.",
            "ok"
          );
        }
      });
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
    browseBtn.disabled = true;
    browseBtn.textContent = "Opening…";
    try {
      await pickFolder();
      showBanner(`Folder selected: ${dirHandle.name}`, "ok");
    } catch (err) {
      if (err && err.name === "AbortError") {
        showBanner("Folder selection cancelled.", "err");
      } else {
        showBanner(err.message || "Could not open folder picker", "err");
      }
    } finally {
      browseBtn.disabled = !supportsDirPicker;
      browseBtn.textContent = "Browse…";
    }
  });

  saveAllBtn.addEventListener("click", () => saveFilesToFolder(latestFiles));

  fileList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-save]");
    if (!btn) return;
    const name = btn.getAttribute("data-save");
    const file = latestFiles.find((f) => f.name === name);
    if (!file) return;
    btn.disabled = true;
    try {
      await saveFilesToFolder([file]);
    } finally {
      btn.disabled = false;
    }
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
          ? "Video loaded. Pick a folder, then click Download video."
          : `Loaded ${data.count} videos. Pick a folder, then download.`;
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

    // Ask for the destination folder up front (browser native picker).
    if (supportsDirPicker && !dirHandle) {
      try {
        await pickFolder();
      } catch (err) {
        if (err && err.name === "AbortError") {
          showBanner("Choose a folder to continue.", "err");
          return;
        }
        showBanner(err.message || "Folder picker failed", "err");
        return;
      }
    }

    const urls = selectedUrls();
    const payload = {
      url: document.getElementById("url").value.trim(),
      quality: document.getElementById("quality").value,
      audio_only: document.getElementById("audio_only").checked,
      selected,
      video_urls: urls,
    };

    filesBeforeJob = new Set(latestFiles.map((f) => f.name));
    pendingSaveCount = selected.length;

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

  updateFolderLabel();
  loadFiles();
})();
