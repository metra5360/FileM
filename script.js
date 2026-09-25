(() => {
  "use strict";

  const CHUNK_SIZE = 64 * 1024; // 64KB на шматок

  // ---------- DOM ----------
  const dropzone       = document.getElementById("dropzone");
  const dropzoneText   = document.getElementById("dropzoneText");
  const fileInput      = document.getElementById("fileInput");
  const pickedFilesEl  = document.getElementById("pickedFiles");
  const startShareBtn  = document.getElementById("startShareBtn");
  const shareInfo      = document.getElementById("shareInfo");
  const qrCanvas       = document.getElementById("qrCanvas");
  const peerIdField    = document.getElementById("peerIdField");
  const copyLinkBtn    = document.getElementById("copyLinkBtn");
  const connCountEl    = document.getElementById("connCount");

  const joinIdField    = document.getElementById("joinIdField");
  const joinBtn        = document.getElementById("joinBtn");
  const incomingFilesEl= document.getElementById("incomingFiles");

  const logEl          = document.getElementById("log");

  function log(msg, type) {
    const p = document.createElement("p");
    if (type) p.className = type;
    p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(p);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
    if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(1) + " МБ";
    return (bytes / 1024 ** 3).toFixed(2) + " ГБ";
  }

  // ---------- ВІДПРАВНИК ----------
  let filesToShare = new Map(); // id -> File
  let peer = null;
  let openConnections = [];

  function renderPickedFiles() {
    pickedFilesEl.innerHTML = "";
    if (filesToShare.size === 0) {
      pickedFilesEl.innerHTML = `<li class="placeholder">Файли ще не вибрано</li>`;
      startShareBtn.disabled = true;
      return;
    }
    startShareBtn.disabled = false;
    filesToShare.forEach((file, id) => {
      const li = document.createElement("li");
      li.className = "file-row";
      li.innerHTML = `
        <div class="file-meta">
          <div class="file-name">${file.name}</div>
          <div class="file-size">${humanSize(file.size)}</div>
        </div>`;
      pickedFilesEl.appendChild(li);
    });
  }

  function addFiles(fileList) {
    Array.from(fileList).forEach(file => {
      const id = crypto.randomUUID();
      filesToShare.set(id, file);
    });
    renderPickedFiles();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", e => addFiles(e.target.files));

  ["dragover", "dragenter"].forEach(evt =>
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add("drag-over"); })
  );
  ["dragleave", "drop"].forEach(evt =>
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove("drag-over"); })
  );
  dropzone.addEventListener("drop", e => {
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  function fileListMeta() {
    return Array.from(filesToShare.entries()).map(([id, f]) => ({
      id, name: f.name, size: f.size, mime: f.type || "application/octet-stream"
    }));
  }

  function sendFileOverConn(conn, fileId) {
    const file = filesToShare.get(fileId);
    if (!file) return;
    conn.send({ type: "file-start", id: fileId, name: file.name, size: file.size, mime: file.type });

    let offset = 0;
    const reader = new FileReader();

    function readNext() {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    }

    reader.onload = () => {
      conn.send({ type: "file-chunk", id: fileId, chunk: reader.result, offset });
      offset += reader.result.byteLength;
      if (offset < file.size) {
        readNext();
      } else {
        conn.send({ type: "file-end", id: fileId });
        log(`Файл "${file.name}" повністю надіслано.`, "ok");
      }
    };
    reader.onerror = () => log(`Помилка читання файлу "${file.name}".`, "err");

    readNext();
  }

  function initPeerAsSender() {
    peer = new Peer();

    peer.on("open", id => {
      peerIdField.value = id;
      shareInfo.classList.remove("hidden");

      const shareUrl = `${location.origin}${location.pathname}?peer=${id}`;
      QRCode.toCanvas(qrCanvas, shareUrl, { width: 220, margin: 1 }, err => {
        if (err) log("Не вдалося згенерувати QR-код: " + err.message, "err");
      });
      copyLinkBtn.dataset.url = shareUrl;

      log("Роздача готова. Код: " + id, "ok");
    });

    peer.on("connection", conn => {
      openConnections.push(conn);
      updateConnCount();
      log("Новий пристрій підключається…");

      conn.on("open", () => {
        conn.send({ type: "file-list", files: fileListMeta() });
        log("Пристрій підключено, список файлів надіслано.", "ok");
      });

      conn.on("data", data => {
        if (data.type === "request-file") {
          log(`Запит на файл: ${filesToShare.get(data.id)?.name || data.id}`);
          sendFileOverConn(conn, data.id);
        }
      });

      conn.on("close", () => {
        openConnections = openConnections.filter(c => c !== conn);
        updateConnCount();
      });
    });

    peer.on("error", err => log("Помилка з'єднання: " + err.type, "err"));
  }

  function updateConnCount() {
    connCountEl.textContent = openConnections.length
      ? `Підключено пристроїв: ${openConnections.length}`
      : "Очікуємо підключення…";
  }

  startShareBtn.addEventListener("click", () => {
    startShareBtn.disabled = true;
    startShareBtn.textContent = "Роздача активна…";
    initPeerAsSender();
  });

  copyLinkBtn.addEventListener("click", () => {
    const url = copyLinkBtn.dataset.url || peerIdField.value;
    navigator.clipboard.writeText(url).then(() => {
      copyLinkBtn.textContent = "Скопійовано!";
      setTimeout(() => (copyLinkBtn.textContent = "Копіювати посилання"), 1500);
    });
  });

  // ---------- ОТРИМУВАЧ ----------
  let receivePeer = null;
  let incomingBuffers = new Map(); // id -> { chunks: [], meta }

  function renderIncomingList(filesMeta) {
    incomingFilesEl.innerHTML = "";
    filesMeta.forEach(meta => {
      const li = document.createElement("li");
      li.className = "file-row";
      li.id = "recv-" + meta.id;
      li.innerHTML = `
        <div class="file-meta">
          <div class="file-name">${meta.name}</div>
          <div class="file-size">${humanSize(meta.size)}</div>
          <div class="progress-bar"><div style="width:0%"></div></div>
        </div>
        <button class="btn download" data-id="${meta.id}">Завантажити</button>
      `;
      incomingFilesEl.appendChild(li);
    });

    incomingFilesEl.querySelectorAll(".btn.download").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const entry = incomingBuffers.get(id);
        if (entry && entry.blobUrl) {
          triggerDownload(entry.blobUrl, entry.meta.name);
          return;
        }
        btn.textContent = "Завантаження…";
        btn.disabled = true;
        window.__activeConn.send({ type: "request-file", id });
      });
    });
  }

  function triggerDownload(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function connectToPeer(peerId) {
    receivePeer = new Peer();
    receivePeer.on("open", () => {
      const conn = receivePeer.connect(peerId, { reliable: true });
      window.__activeConn = conn;

      conn.on("open", () => log("Підключено до відправника!", "ok"));

      conn.on("data", data => {
        if (data.type === "file-list") {
          renderIncomingList(data.files);
          data.files.forEach(m => incomingBuffers.set(m.id, { chunks: [], meta: m }));
          log(`Отримано список файлів (${data.files.length}).`, "ok");
        }

        if (data.type === "file-start") {
          const entry = incomingBuffers.get(data.id) || { chunks: [] };
          entry.chunks = [];
          entry.received = 0;
          entry.meta = { id: data.id, name: data.name, size: data.size, mime: data.mime };
          incomingBuffers.set(data.id, entry);
        }

        if (data.type === "file-chunk") {
          const entry = incomingBuffers.get(data.id);
          if (!entry) return;
          entry.chunks.push(data.chunk);
          entry.received = (entry.received || 0) + data.chunk.byteLength;
          const pct = Math.min(100, Math.round((entry.received / entry.meta.size) * 100));
          const bar = document.querySelector(`#recv-${data.id} .progress-bar > div`);
          if (bar) bar.style.width = pct + "%";
        }

        if (data.type === "file-end") {
          const entry = incomingBuffers.get(data.id);
          if (!entry) return;
          const blob = new Blob(entry.chunks, { type: entry.meta.mime });
          entry.blobUrl = URL.createObjectURL(blob);

          const btn = document.querySelector(`#recv-${data.id} .btn.download`);
          if (btn) {
            btn.textContent = "Готово — Завантажити ⬇";
            btn.disabled = false;
            btn.classList.add("done");
            triggerDownload(entry.blobUrl, entry.meta.name); // одразу пропонуємо зберегти
          }
          log(`Файл "${entry.meta.name}" отримано повністю.`, "ok");
        }
      });

      conn.on("close", () => log("З'єднання закрито.", "err"));
    });

    receivePeer.on("error", err => log("Помилка з'єднання: " + err.type, "err"));
  }

  joinBtn.addEventListener("click", () => {
    const id = joinIdField.value.trim();
    if (!id) return log("Введи код з'єднання.", "err");
    connectToPeer(id);
  });

  // Автопідключення, якщо відкрито по QR-посиланню з ?peer=ID
  window.addEventListener("DOMContentLoaded", () => {
    renderPickedFiles();
    const params = new URLSearchParams(location.search);
    const autoPeer = params.get("peer");
    if (autoPeer) {
      joinIdField.value = autoPeer;
      connectToPeer(autoPeer);
    }
  });
})();
