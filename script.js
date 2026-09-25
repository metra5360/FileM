(() => {
  "use strict";
 
  const CHUNK_SIZE = 64 * 1024; // 64KB на шматок
 
  // ---------- DOM ----------
  const qrCanvas       = document.getElementById("qrCanvas");
  const statusText     = document.getElementById("statusText");
  const scanBtn        = document.getElementById("scanBtn");
  const cancelScanBtn  = document.getElementById("cancelScanBtn");
  const scannerBox     = document.getElementById("scannerBox");
  const video          = document.getElementById("video");
 
  const dropzone        = document.getElementById("dropzone");
  const fileInput       = document.getElementById("fileInput");
  const pickedFilesEl   = document.getElementById("pickedFiles");
  const incomingFilesEl = document.getElementById("incomingFiles");
  const logEl           = document.getElementById("log");
 
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
 
  // ---------- Стан ----------
  let myPeer = null;
  let activeConn = null;
  let filesToShare = new Map();       // id -> File (те, що обрали на цьому пристрої)
  let incomingBuffers = new Map();    // id -> { chunks, received, meta, blobUrl }
 
  // ---------- Ініціалізація власного Peer + QR ----------
  function initPeer() {
    myPeer = new Peer();
 
    myPeer.on("open", id => {
      const shareUrl = `${location.origin}${location.pathname}?peer=${id}`;
      QRCode.toCanvas(qrCanvas, shareUrl, { width: 220, margin: 1 }, err => {
        if (err) log("Не вдалося згенерувати QR-код: " + err.message, "err");
      });
      statusText.textContent = "Готово. Дай іншому пристрою відсканувати цей QR — або скануй сам.";
      log("Пристрій готовий, ID: " + id, "ok");
 
      // Автопідключення, якщо сторінку відкрито за посиланням з QR (?peer=ID)
      const params = new URLSearchParams(location.search);
      const autoPeer = params.get("peer");
      if (autoPeer && autoPeer !== id) {
        connectTo(autoPeer);
      }
    });
 
    myPeer.on("connection", conn => setupConnection(conn));
    myPeer.on("error", err => log("Помилка з'єднання: " + err.type, "err"));
  }
 
  function connectTo(peerId) {
    statusText.textContent = "Підключення…";
    const conn = myPeer.connect(peerId, { reliable: true });
    setupConnection(conn);
  }
 
  function setupConnection(conn) {
    activeConn = conn;
    conn.on("open", () => {
      statusText.textContent = "✅ Підключено до іншого пристрою";
      log("З'єднання встановлено.", "ok");
      sendFileListIfAny();
    });
    conn.on("data", handleIncomingData);
    conn.on("close", () => {
      activeConn = null;
      statusText.textContent = "З'єднання розірвано.";
      log("З'єднання закрито.", "err");
    });
  }
 
  // ---------- Вибір і надсилання файлів ----------
  function renderPickedFiles() {
    pickedFilesEl.innerHTML = "";
    if (filesToShare.size === 0) {
      pickedFilesEl.innerHTML = `<li class="placeholder">Файли ще не вибрано</li>`;
      return;
    }
    filesToShare.forEach(file => {
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
 
  function fileListMeta() {
    return Array.from(filesToShare.entries()).map(([id, f]) => ({
      id, name: f.name, size: f.size, mime: f.type || "application/octet-stream"
    }));
  }
 
  function sendFileListIfAny() {
    if (filesToShare.size > 0 && activeConn && activeConn.open) {
      activeConn.send({ type: "file-list", files: fileListMeta() });
      log("Список файлів надіслано іншому пристрою.", "ok");
    }
  }
 
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", e => {
    Array.from(e.target.files).forEach(file => {
      const id = crypto.randomUUID();
      filesToShare.set(id, file);
    });
    renderPickedFiles();
    sendFileListIfAny();
  });
 
  function sendFileOverConn(fileId) {
    const file = filesToShare.get(fileId);
    if (!file || !activeConn) return;
    activeConn.send({ type: "file-start", id: fileId, name: file.name, size: file.size, mime: file.type });
 
    let offset = 0;
    const reader = new FileReader();
 
    function readNext() {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    }
 
    reader.onload = () => {
      activeConn.send({ type: "file-chunk", id: fileId, chunk: reader.result });
      offset += reader.result.byteLength;
      if (offset < file.size) {
        readNext();
      } else {
        activeConn.send({ type: "file-end", id: fileId });
        log(`Файл "${file.name}" повністю надіслано.`, "ok");
      }
    };
    reader.onerror = () => log(`Помилка читання файлу "${file.name}".`, "err");
 
    readNext();
  }
 
  // ---------- Прийом файлів ----------
  function renderIncomingList(filesMeta) {
    incomingFilesEl.innerHTML = "";
    filesMeta.forEach(meta => {
      incomingBuffers.set(meta.id, { chunks: [], received: 0, meta });
 
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
        activeConn.send({ type: "request-file", id });
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
 
  function handleIncomingData(data) {
    if (data.type === "file-list") {
      renderIncomingList(data.files);
      log(`Отримано список файлів (${data.files.length}).`, "ok");
    }
 
    if (data.type === "request-file") {
      sendFileOverConn(data.id);
    }
 
    if (data.type === "file-start") {
      incomingBuffers.set(data.id, {
        chunks: [], received: 0,
        meta: { id: data.id, name: data.name, size: data.size, mime: data.mime }
      });
    }
 
    if (data.type === "file-chunk") {
      const entry = incomingBuffers.get(data.id);
      if (!entry) return;
      entry.chunks.push(data.chunk);
      entry.received += data.chunk.byteLength;
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
      }
      triggerDownload(entry.blobUrl, entry.meta.name);
      log(`Файл "${entry.meta.name}" отримано повністю.`, "ok");
    }
  }
 
  // ---------- Сканування QR камерою ----------
  let scanStream = null;
  let scanning = false;
 
  scanBtn.addEventListener("click", startScanning);
  cancelScanBtn.addEventListener("click", stopScanning);
 
  async function startScanning() {
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (e) {
      log("Немає доступу до камери: " + e.message, "err");
      return;
    }
    video.srcObject = scanStream;
    await video.play();
    scannerBox.classList.remove("hidden");
    scanning = true;
    requestAnimationFrame(scanLoop);
  }
 
  function stopScanning() {
    scanning = false;
    scannerBox.classList.add("hidden");
    if (scanStream) {
      scanStream.getTracks().forEach(t => t.stop());
      scanStream = null;
    }
  }
 
  const scanCanvas = document.createElement("canvas");
  const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
 
  function scanLoop() {
    if (!scanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      scanCanvas.width = video.videoWidth;
      scanCanvas.height = video.videoHeight;
      scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
      const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code && code.data) {
        const peerId = extractPeerId(code.data);
        stopScanning();
        if (peerId) {
          log("QR розпізнано, підключаюсь…", "ok");
          connectTo(peerId);
        } else {
          log("QR-код не містить коректного ідентифікатора.", "err");
        }
        return;
      }
    }
    requestAnimationFrame(scanLoop);
  }
 
  function extractPeerId(text) {
    try {
      const url = new URL(text);
      return url.searchParams.get("peer") || null;
    } catch {
      return text.trim() || null; // якщо це просто голий ID, а не URL
    }
  }
 
  // ---------- Старт ----------
  initPeer();
})();
