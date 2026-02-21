// PolyWhale Dashboard — Polymarket-style portfolio UI
// Connects to ws://localhost:3000, receives state every 1s

let ws = null;
let state = null;
let reconnectTimer = null;

// ─── WebSocket ────────────────────────────────────
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setStatus("connected");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onmessage = (e) => {
    try {
      state = JSON.parse(e.data);
      render(state);
    } catch {}
  };

  ws.onclose = () => {
    setStatus("disconnected");
    scheduleReconnect();
  };

  ws.onerror = () => {
    setStatus("error");
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function setStatus(s) {
  const dot = document.getElementById("ws-status");
  const label = document.getElementById("ws-label");
  if (s === "connected") {
    dot.className = "dot green";
    label.textContent = "Live";
  } else if (s === "disconnected") {
    dot.className = "dot red";
    label.textContent = "Disconnected";
  } else {
    dot.className = "dot orange";
    label.textContent = "Connecting...";
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Render ───────────────────────────────────────
function render(s) {
  if (!s) return;
  const sc = s.scalper;
  const bn = s.binance;

  const cl = s.chainlink;

  // Header
  if (bn) {
    const bnEl = document.getElementById("binance-status");
    bnEl.textContent = bn.live ? `Binance: LIVE` : "Binance: Offline";
  }
  if (cl) {
    const clEl = document.getElementById("chainlink-status");
    clEl.textContent = cl.live ? `Chainlink: LIVE` : "Chainlink: Offline";
  }
  const mx = s.multiExchange;
  if (mx) {
    const exEl = document.getElementById("exchange-status");
    exEl.textContent = `Feeds: ${mx.exchangeCount || 1}/3`;
  }
  const pw = s.polyWs;
  if (pw) {
    const clobEl = document.getElementById("clob-status");
    clobEl.textContent = pw.live ? `CLOB: ${pw.subscriptions} tokens` : "CLOB: Offline";
  }
  document.getElementById("uptime").textContent = formatDuration(s.uptime);

  // Portfolio — available cash (debits on bet, credits on exit)
  const available = sc.bankroll || 0;
  setText("total-balance", "$" + fmtNum(available));
  const balEl = document.getElementById("total-balance");
  if (balEl) {
    const started = sc.startingBankroll || 1000;
    balEl.style.color = available > started + 0.01 ? "var(--green)" : available < started - 0.01 ? "var(--red)" : "var(--text)";
  }

  // Portfolio stats
  const totalPnl = sc.totalPnl + (sc.unrealizedPnl || 0);
  setText("total-pnl", formatPnl(totalPnl));
  colorPnl("total-pnl", totalPnl);
  setText("daily-pnl", formatPnl(sc.dailyPnl));
  colorPnl("daily-pnl", sc.dailyPnl);
  setText("bankroll-start", "$" + fmtNum(sc.startingBankroll || 1000));
  setText("bankroll-locked", "$" + fmtNum(sc.lockedInPositions || 0));

  // Tab counts
  setText("tab-pos-count", sc.openPositions || 0);
  setText("tab-mkt-count", sc.marketCount || 0);

  // Stats tab
  setText("win-rate", sc.winRate.toFixed(0) + "%");
  setText("total-bets", sc.totalBets);
  setText("stat-wins", sc.wins);
  setText("stat-losses", sc.losses);
  setText("open-count", sc.openPositions);
  setText("probe-stats", `${sc.probeProven || 0}/${sc.probePatterns || 0}`);

  // Execution stats
  const ex = sc.executionStats || {};
  setText("exec-fills", `${ex.fills || 0} / ${ex.failures || 0}`);
  setText("exec-slippage", "-$" + (ex.totalSlippage || 0).toFixed(3));
  setText("exec-spread", "-$" + (ex.totalSpreadCost || 0).toFixed(3));
  setText("exec-mode", sc.clobWsLive ? `CLOB WS (${sc.orderbookCount || 0} books)` : sc.clobActive ? `CLOB HTTP (${sc.orderbookCount || 0} books)` : "Gamma");

  // Positions
  renderPositions(sc.positions);

  // History
  renderHistory(sc.recentHistory);

  // Live prices — all exchanges + predicted + Chainlink
  const mxPrices = mx && mx.prices ? mx.prices : {};
  for (const asset of ["BTC", "ETH", "SOL"]) {
    const lower = asset.toLowerCase();
    const binPrice = bn && bn.prices ? bn.prices[asset] : null;
    const cbPrice = mxPrices[asset] ? mxPrices[asset].coinbase : null;
    const krPrice = mxPrices[asset] ? mxPrices[asset].kraken : null;
    const predPrice = sc.predictedChainlink ? sc.predictedChainlink[asset] : null;
    const clPrice = sc.chainlinkPrices ? sc.chainlinkPrices[asset] : null;
    const lag = cl && cl.lag && cl.lag[asset] ? cl.lag[asset] : null;

    const fmt = (p) => p ? "$" + p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "--";

    setText(`binance-${lower}`, fmt(binPrice));
    setText(`coinbase-${lower}`, fmt(cbPrice));
    setText(`kraken-${lower}`, fmt(krPrice));

    // Predicted price with accuracy indicator vs Chainlink
    const predEl = document.getElementById(`predicted-${lower}`);
    if (predEl) {
      if (predPrice && clPrice) {
        const diff = Math.abs(predPrice - clPrice);
        const pct = (diff / clPrice * 100).toFixed(3);
        predEl.textContent = `${fmt(predPrice)} (${pct}%)`;
        predEl.className = "price-val predicted-price " + (diff / clPrice < 0.0005 ? "div-pos" : "div-neutral");
      } else {
        predEl.textContent = fmt(predPrice);
        predEl.className = "price-val predicted-price";
      }
    }

    const clEl = document.getElementById(`chainlink-${lower}`);
    if (clEl) {
      let clText = fmt(clPrice);
      if (lag && lag.lagSec !== "--") clText += ` (${lag.lagSec}s)`;
      clEl.textContent = clText;
    }
  }

  // Data source
  const srcEl = document.getElementById("data-source");
  const binSrc = sc.liveData ? "Binance WS" : "Binance HTTP";
  const clSrc = sc.chainlinkLive ? "Chainlink WS" : "Chainlink: waiting";
  const clobSrc = sc.clobWsLive ? "CLOB WS (~100ms)" : "CLOB: polling";
  const mxCount = mx ? mx.exchangeCount || 1 : 1;
  let lagStr = "";
  if (cl && cl.lag && cl.lag.BTC && cl.lag.BTC.avgIntervalSec !== "--") {
    lagStr = ` | Oracle ~${cl.lag.BTC.avgIntervalSec}s`;
  }
  srcEl.textContent = `Poly: ${clobSrc} | Feeds: ${mxCount}/3 | ${clSrc}${lagStr}`;

  // Markets
  renderMarkets(sc.marketList);

  // Logs
  renderLogs(sc.logs);
}

function renderPositions(positions) {
  const el = document.getElementById("positions");
  if (!positions || positions.length === 0) {
    el.innerHTML = '<div class="empty-state">No open positions</div>';
    return;
  }
  el.innerHTML = positions.map(p => {
    const pnl = p.unrealizedPnl || 0;
    const pnlClass = pnl > 0.001 ? "positive" : pnl < -0.001 ? "negative" : "neutral";
    const link = p.polyUrl ? `<a href="${esc(p.polyUrl)}" target="_blank">${esc(p.asset)} [${esc(p.timeframe)}]</a>` : `${esc(p.asset)} [${esc(p.timeframe)}]`;
    const secsLeft = p.endDate ? Math.max(0, Math.floor((p.endDate - Date.now()) / 1000)) : 0;
    const tier = p.betTier || "PROBE";
    const tierClass = getTierClass(tier);

    // Chart pattern badges
    let chartBadge = "";
    if (p.liveChart && p.liveChart.patterns.length > 0) {
      const chartClass = p.liveChart.bias > 0.2 ? "chart-bull" : p.liveChart.bias < -0.2 ? "chart-bear" : "chart-neutral";
      const patternStr = p.liveChart.patterns.slice(0, 2).join(", ");
      const signal = p.liveChart.holdSignal ? "HOLD" : p.liveChart.exitSignal ? "EXIT" : "";
      chartBadge = `<div class="pos-chart ${chartClass}">${esc(patternStr)}${signal ? " → " + signal : ""}</div>`;
    }

    return `<div class="pos-row">
      <div class="pos-side ${p.side === 'UP' ? 'up' : 'down'}">${esc(p.side)}</div>
      <div class="pos-info">
        <div class="pos-title">${link}<span class="pos-tier ${tierClass}">${esc(tier)}</span></div>
        <div class="pos-detail">$${(p.costBasis || 1).toFixed(2)} @ $${p.entryPrice.toFixed(3)} | Now $${(p.currentPrice || p.entryPrice).toFixed(3)} | ${formatDuration(secsLeft)} left</div>
        ${chartBadge}
      </div>
      <div class="pos-numbers">
        <div class="pos-pnl ${pnlClass}">${formatPnl(pnl)}</div>
        <div class="pos-cost">${(pnl !== 0 ? ((pnl / (p.costBasis || 1)) * 100).toFixed(1) : "0.0")}%</div>
      </div>
    </div>`;
  }).join("");
}

function renderHistory(history) {
  const el = document.getElementById("history");
  if (!history || history.length === 0) {
    el.innerHTML = '<div class="empty-state">No trades yet</div>';
    return;
  }
  el.innerHTML = history.slice(0, 30).map(t => {
    const pnlClass = t.pnl > 0.001 ? "positive" : t.pnl < -0.001 ? "negative" : "neutral";
    const link = t.polyUrl ? `<a href="${esc(t.polyUrl)}" target="_blank">${esc(t.asset)} [${esc(t.timeframe)}]</a>` : `${esc(t.asset)} [${esc(t.timeframe)}]`;
    const ago = t.closedAt ? formatAgo(Date.now() - t.closedAt) : "";

    // Outcome label: Won if profit, Lost if loss, Sold if scratch/flip
    let outcomeLabel, outcomeClass;
    if (t.pnl > 0.05) {
      outcomeLabel = "Won";
      outcomeClass = "won";
    } else if (t.pnl < -0.05) {
      outcomeLabel = "Lost";
      outcomeClass = "lost";
    } else {
      outcomeLabel = "Sold";
      outcomeClass = "sold";
    }

    const betStr = t.costBasis ? `$${t.costBasis.toFixed(2)}` : "$1";
    return `<div class="activity-row">
      <div class="activity-outcome ${outcomeClass}">${outcomeLabel}</div>
      <div class="activity-info">
        <div class="activity-title">${link}</div>
        <div class="activity-detail">${esc(t.side)} | ${betStr} @ $${t.entryPrice.toFixed(3)} → $${(t.exitPrice || 0).toFixed(3)} | ${ago}</div>
      </div>
      <div class="activity-pnl ${pnlClass}">${formatPnl(t.pnl)}</div>
    </div>`;
  }).join("");
}

function renderMarkets(markets) {
  const el = document.getElementById("markets-list");
  if (!markets || markets.length === 0) {
    el.innerHTML = '<div class="empty-state">No active markets</div>';
    return;
  }
  el.innerHTML = markets.map(m => {
    const link = m.polyUrl ? `<a href="${esc(m.polyUrl)}" target="_blank">${esc(m.asset)} [${esc(m.timeframe)}]</a>` : `${esc(m.asset)} [${esc(m.timeframe)}]`;
    return `<div class="market-row">
      <div class="market-asset">${esc(m.asset)}</div>
      <div class="market-info">
        <div class="market-title">${link}</div>
        <div class="market-prices">UP $${(m.gammaUpPrice || 0).toFixed(2)} | DOWN $${(m.gammaDownPrice || 0).toFixed(2)}</div>
      </div>
      <div class="market-time">${formatDuration(m.secsLeft)}</div>
    </div>`;
  }).join("");
}

function renderLogs(logs) {
  const el = document.getElementById("log-output");
  if (!logs || logs.length === 0) { el.innerHTML = ""; return; }

  // Only re-render if log count changed
  if (el._logCount === logs.length) return;
  el._logCount = logs.length;

  el.innerHTML = logs.slice().reverse().map(l => {
    const ts = new Date(l.ts).toLocaleTimeString();
    return `<span class="log-line"><span class="ts">${ts}</span> <span class="type-${esc(l.type)}">[${esc(l.type)}]</span> ${esc(l.msg)}</span>`;
  }).join("\n");
}

// ─── Tabs ─────────────────────────────────────────
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ─── Buttons ──────────────────────────────────────
document.getElementById("btn-clear-logs").addEventListener("click", () => send({ type: "CLEAR_LOGS" }));
document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Reset all scalper data? This clears positions, history, and P&L.")) {
    send({ type: "RESET" });
  }
});
document.getElementById("btn-refresh").addEventListener("click", () => send({ type: "REFRESH_MARKETS" }));
// Manual trade UI removed — bot auto-enters daily markets

// ─── Helpers ──────────────────────────────────────
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function colorPnl(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.color = val > 0.001 ? "var(--green)" : val < -0.001 ? "var(--red)" : "var(--text)";
}

function formatPnl(val) {
  const sign = val >= 0 ? "+" : "";
  return sign + "$" + Math.abs(val).toFixed(2);
}

function fmtNum(val) {
  return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDuration(secs) {
  if (typeof secs !== "number" || secs < 0) return "--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function getTierClass(tier) {
  switch (tier) {
    case "PROBE": return "tier-probe";
    case "SCOUT": return "tier-scout";
    case "SMALL": return "tier-small";
    case "MEDIUM": return "tier-mid";
    case "HIGH": return "tier-high";
    case "AGGRESSIVE": return "tier-aggressive";
    case "ALL-IN": return "tier-allin";
    case "AUTO": return "tier-high";
    case "MANUAL": return "tier-aggressive";
    default: return "tier-probe";
  }
}

function esc(str) {
  if (typeof str !== "string") return String(str || "");
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Boot ─────────────────────────────────────────
connect();

// Fallback: poll /api/state if WS fails for 10s
setInterval(async () => {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    const res = await fetch("/api/state");
    if (res.ok) {
      state = await res.json();
      render(state);
    }
  } catch {}
}, 3000);
