// PolyWhale — Side Panel UI (Scalper + Logs only)

let currentTab = "scalper";
let scalperStats = {};

// ─── Init ────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupResetButton();
  setupClearLogs();
  setupClickableRows();
  await loadState();
  setInterval(loadState, 2000);
});

// ─── Tabs ────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const t = tab.dataset.tab;
      if (t) switchTab(t);
    });
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.add("active");
  document.getElementById(`panel-${tab}`)?.classList.add("active");
}

// ─── Load state from background ──────────────────
async function loadState() {
  try {
    const state = await sendMessage({ type: "GET_STATE" });
    if (!state) return;
    scalperStats = state.scalperStats || {};
    renderAll();
  } catch (e) {
    console.error("Load error:", e);
  }
}

function renderAll() {
  renderMetrics();
  renderStatus();
  renderScalper();
  renderLogs();
}

// ─── Status ──────────────────────────────────────
function renderStatus() {
  const el = document.getElementById("status");
  const text = document.getElementById("status-text");
  const hasBets = (scalperStats.totalBets || 0) > 0;
  const hasPositions = (scalperStats.openPositions || 0) > 0;
  if (scalperStats.tickCount > 0 || hasPositions || hasBets) {
    el.className = "status live";
    text.textContent = "Live";
  } else if (scalperStats.markets > 0) {
    el.className = "status live";
    text.textContent = "Scanning";
  } else {
    el.className = "status";
    text.textContent = "Connecting";
  }
}

// ─── Metrics (P&L, Bets, Win%) ──────────────────
function renderMetrics() {
  const pnl = (scalperStats.totalPnl || 0) + (scalperStats.unrealizedPnl || 0);
  const bets = scalperStats.totalBets || 0;
  const winRate = scalperStats.winRate || 0;

  const pnlEl = document.getElementById("metric-pnl");
  pnlEl.textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
  pnlEl.className = `metric-value ${pnl > 0 ? "positive" : pnl < 0 ? "negative" : ""}`;

  document.getElementById("metric-bets").textContent = bets;
  document.getElementById("metric-win").textContent = `${winRate.toFixed(0)}%`;
}

// ─── Scalper panel ──────────────────────────────
function renderScalper() {
  const positions = scalperStats.positions || [];
  const history = scalperStats.recentHistory || [];

  document.getElementById("pos-count").textContent = `(${positions.length})`;
  document.getElementById("trade-count").textContent = `(${history.length})`;

  const posEl = document.getElementById("positions-list");
  if (positions.length === 0) {
    posEl.innerHTML = `<div class="empty">Scanning for entries...</div>`;
  } else {
    posEl.innerHTML = positions.map(p => {
      const pnl = p.unrealizedPnl || 0;
      const pnlClass = pnl >= 0 ? "up" : "down";
      const isUp = p.side === "YES";
      const sideClass = isUp ? "yes" : "no";
      const url = p.polyUrl || "";
      return `
        <div class="pos-row clickable" ${url ? `data-url="${esc(url)}"` : ""}>
          <div class="pos-info">
            <div class="pos-label">
              <span class="side-tag ${sideClass}">${isUp ? "UP" : "DOWN"}</span>
              ${esc(p.asset)} ${esc(p.timeframe)} [${p.entryReason || ""}]
            </div>
            <div class="pos-detail">$${p.entryPrice?.toFixed(3) || "?"} → $${p.currentPrice?.toFixed(3) || "?"} | ${timeAgo(p.openedAt)}</div>
          </div>
          <div class="pos-pnl ${pnlClass}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(3)}</div>
        </div>`;
    }).join("");
  }

  const histEl = document.getElementById("history-list");
  if (history.length === 0) {
    histEl.innerHTML = `<div class="empty">No trades yet</div>`;
  } else {
    histEl.innerHTML = history.slice(0, 30).map(t => {
      const pnl = t.pnl || 0;
      const pnlClass = pnl >= 0 ? "up" : "down";
      const tIsUp = t.side === "YES";
      const sideClass = tIsUp ? "yes" : "no";
      const url = t.polyUrl || "";
      return `
        <div class="trade-row clickable" ${url ? `data-url="${esc(url)}"` : ""}>
          <div class="trade-info">
            <div class="trade-label">
              <span class="side-tag ${sideClass}">${tIsUp ? "UP" : "DOWN"}</span>
              ${esc(t.asset)} ${esc(t.timeframe)} <span class="reason-tag">${t.reason || ""}</span>
            </div>
            <div class="trade-detail">$${t.entryPrice?.toFixed(3) || "?"} → $${t.exitPrice?.toFixed(3) || "?"} | ${timeAgo(t.closedAt)}</div>
          </div>
          <div class="trade-pnl ${pnlClass}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(3)}</div>
        </div>`;
    }).join("");
  }
}

// ─── Logs panel ─────────────────────────────────
function renderLogs() {
  const logs = scalperStats.logs || [];
  const container = document.getElementById("logs-list");
  if (logs.length === 0) {
    container.innerHTML = `<div class="empty">Waiting...</div>`;
    return;
  }

  // Newest first
  container.innerHTML = logs.slice().reverse().map(entry => {
    const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const cls = logClass(entry.type);
    return `<div class="log-entry"><span class="log-time">${time}</span><span class="log-type ${cls}">${entry.type}</span><span class="log-msg">${esc(entry.msg)}</span></div>`;
  }).join("");
}

function logClass(type) {
  switch (type) {
    case "OPEN": return "log-open";
    case "EXIT": return "log-exit";
    case "ERROR": case "WARN": return "log-error";
    case "TICK": return "log-tick";
    case "SIGNAL": return "log-open";
    case "HOLD": return "log-init";
    case "SCAN": case "MARKET": return "log-scan";
    case "INIT": return "log-init";
    default: return "log-default";
  }
}

// ─── Clickable rows → open Polymarket ───────────
function setupClickableRows() {
  document.querySelector(".content").addEventListener("click", (e) => {
    const row = e.target.closest(".clickable[data-url]");
    if (row?.dataset.url) {
      try { chrome.tabs.create({ url: row.dataset.url }); }
      catch { window.open(row.dataset.url, "_blank"); }
    }
  });
}

function setupResetButton() {
  document.getElementById("btn-reset-scalper").addEventListener("click", async () => {
    if (!confirm("Reset all data?")) return;
    await sendMessage({ type: "RESET_SCALPER" });
    await loadState();
  });
}

function setupClearLogs() {
  document.getElementById("btn-clear-logs").addEventListener("click", async () => {
    await sendMessage({ type: "CLEAR_LOGS" });
    await loadState();
  });
}

// ─── Messaging ───────────────────────────────────
function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response);
    });
  });
}

// ─── Helpers ─────────────────────────────────────
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function timeAgo(ts) {
  if (!ts) return "";
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return "now";
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}
