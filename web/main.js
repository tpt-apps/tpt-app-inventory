import init, { scan_rgba } from "./vendor/tpt_app_inventory_wasm.js";
import * as db from "./lib/db.js";

const $ = (id) => document.getElementById(id);

const SAMPLE_SKUS = Array.from({ length: 8 }, (_, i) => ({
  id: `SKU-${String(i + 1).padStart(5, "0")}`,
  expectedQty: (i + 1) * 5,
}));

const errorBox = $("error-box");
const scanFlash = $("scan-flash");
const scanStatus = $("scan-status");
const tbody = $("sku-tbody");
const searchBox = $("search-box");

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.toggle("show", Boolean(msg));
}

function parseSkuRows(raw) {
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split(",").map((p) => p.trim());
    const id = parts[0];
    if (!id) continue;
    const qty = parts[1] !== undefined && parts[1] !== "" ? Number(parts[1]) : null;
    rows.push({ id, expectedQty: Number.isFinite(qty) ? qty : null });
  }
  return rows;
}

let allSkus = [];

async function refreshTable() {
  allSkus = await db.getAllSkus();
  allSkus.sort((a, b) => a.id.localeCompare(b.id));
  renderStats();
  renderTable();
}

function renderStats() {
  const totalScanned = allSkus.reduce((sum, s) => sum + s.countedQty, 0);
  const unexpected = allSkus.filter((s) => s.unexpected).length;
  $("stat-skus").textContent = allSkus.length;
  $("stat-counted").textContent = totalScanned;
  $("stat-unexpected").textContent = unexpected;
}

function statusFor(sku) {
  if (sku.unexpected) return { pill: "unexpected", label: "Unexpected" };
  if (sku.expectedQty != null && sku.countedQty >= sku.expectedQty) return { pill: "matched", label: "Matched" };
  if (sku.countedQty > 0) return { pill: "matched", label: "Counted" };
  return { pill: "zero", label: "Not yet counted" };
}

function renderTable() {
  const query = searchBox.value.trim().toLowerCase();
  tbody.innerHTML = "";
  const filtered = query ? allSkus.filter((s) => s.id.toLowerCase().includes(query)) : allSkus;

  for (const sku of filtered) {
    const tr = document.createElement("tr");
    if (sku.unexpected) tr.className = "unexpected";

    const idTd = document.createElement("td");
    idTd.textContent = sku.id;

    const expectedTd = document.createElement("td");
    expectedTd.textContent = sku.expectedQty == null ? "—" : sku.expectedQty;

    const countedTd = document.createElement("td");
    countedTd.className = "count";
    countedTd.textContent = sku.countedQty;

    const statusTd = document.createElement("td");
    const s = statusFor(sku);
    const pill = document.createElement("span");
    pill.className = `pill ${s.pill}`;
    pill.textContent = s.label;
    statusTd.appendChild(pill);

    const timeTd = document.createElement("td");
    timeTd.textContent = sku.lastScannedAt ? new Date(sku.lastScannedAt).toLocaleTimeString() : "—";

    tr.append(idTd, expectedTd, countedTd, statusTd, timeTd);
    tbody.appendChild(tr);
  }
}

async function loadSkus() {
  const fileInput = $("sku-file");
  const pasteText = $("sku-paste").value;

  let raw = pasteText;
  if (fileInput.files && fileInput.files[0]) {
    raw = await fileInput.files[0].text();
  }

  const rows = parseSkuRows(raw);
  if (rows.length === 0) {
    showError("No SKUs found — paste some or choose a CSV file first.");
    return;
  }

  await db.replaceAllSkus(rows);
  showError("");
  await refreshTable();
}

function flash(kind, text) {
  scanFlash.textContent = text;
  scanFlash.className = `scan-flash show ${kind}`;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => scanFlash.classList.remove("show"), 1800);
}

const recentlySeen = new Map();
const SEEN_COOLDOWN_MS = 1200;

async function handleScan(text) {
  const now = Date.now();
  const last = recentlySeen.get(text);
  if (last && now - last < SEEN_COOLDOWN_MS) return;
  recentlySeen.set(text, now);

  const sku = await db.recordScan(text);
  if (sku.unexpected) {
    flash("invalid", `Unexpected: ${text} (not in list, added — count ${sku.countedQty})`);
  } else {
    flash("ok", `+1 ${text} — count now ${sku.countedQty}`);
  }
  await refreshTable();
}

function wireScanner() {
  const video = $("video");
  const overlay = $("overlay");
  const capture = $("capture");
  const scanBtn = $("scan-btn");
  const stopBtn = $("stop-btn");

  let stream = null;
  let rafHandle = null;

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (err) {
      scanStatus.textContent = `Camera access failed: ${err}`;
      return;
    }

    video.srcObject = stream;
    await video.play();

    capture.width = video.videoWidth;
    capture.height = video.videoHeight;
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    scanStatus.textContent = "Scanning… each hit adds +1 to that SKU's count.";
    scanBtn.disabled = true;
    stopBtn.disabled = false;

    scheduleFrame();
  }

  function stop() {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    scanStatus.textContent = "Camera not started. Each scan adds +1 to that SKU's count — rescan to tally multiples.";
    scanBtn.disabled = false;
    stopBtn.disabled = true;
  }

  function scheduleFrame() {
    rafHandle = requestAnimationFrame(processFrame);
  }

  function processFrame() {
    if (!stream) return;

    const ctx = capture.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, capture.width, capture.height);
    const { data, width, height } = ctx.getImageData(0, 0, capture.width, capture.height);

    let hits = [];
    try {
      hits = scan_rgba(new Uint8Array(data.buffer), width, height);
    } catch (err) {
      console.debug("scan_rgba error:", err);
    }

    for (const hit of hits) {
      handleScan(hit.text);
    }

    scheduleFrame();
  }

  scanBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);
}

function exportCsv() {
  const rows = [["sku", "expected_qty", "counted_qty", "status", "last_scanned_at"]];
  for (const s of allSkus) {
    rows.push([
      s.id,
      s.expectedQty ?? "",
      s.countedQty,
      statusFor(s).label,
      s.lastScannedAt ? new Date(s.lastScannedAt).toISOString() : "",
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stock-count-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function main() {
  await init();
  wireScanner();

  $("load-skus-btn").addEventListener("click", loadSkus);
  $("load-sample-btn").addEventListener("click", async () => {
    $("sku-paste").value = SAMPLE_SKUS.map((s) => `${s.id},${s.expectedQty}`).join("\n");
    await db.replaceAllSkus(SAMPLE_SKUS);
    showError("");
    await refreshTable();
  });
  $("export-btn").addEventListener("click", exportCsv);
  $("reset-btn").addEventListener("click", async () => {
    if (!confirm("Reset all counts? This clears scanned counts but keeps the SKU list.")) return;
    await db.resetAllCounts();
    await refreshTable();
  });
  searchBox.addEventListener("input", renderTable);

  const aboutDialog = $("about-dialog");
  $("about-link").addEventListener("click", (e) => {
    e.preventDefault();
    aboutDialog.showModal();
  });
  $("about-close").addEventListener("click", () => aboutDialog.close());

  await refreshTable();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  let deferredInstallPrompt = null;
  const installLink = $("install-link");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installLink.hidden = false;
  });
  installLink.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installLink.hidden = true;
  });
}

main();
