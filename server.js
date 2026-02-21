// PolyWhale Server — Main orchestrator
// Binance WS (real-time) → Scalper (1-2s fast ticks) → HTTP dashboard
// Usage: node server.js

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";

import "dotenv/config";
import { WebSocketServer } from "ws";
import { Scalper } from "./lib/scalper.js";
import { BinanceWS } from "./lib/binance-ws.js";
import { ChainlinkWS } from "./lib/chainlink-ws.js";
import { MultiExchange } from "./lib/multi-exchange.js";
import { PolymarketWS } from "./lib/polymarket-ws.js";
import { ClobOrders } from "./lib/clob-orders.js";
import * as api from "./lib/polymarket-api.js";
import * as supa from "./lib/supabase.js";
import { FiveMinScalper } from "./lib/five-min-scalper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── Safe logging (Windows stdout can crash process) ─
function slog(msg) { try { process.stdout.write(msg + "\n"); } catch {} }
function serr(msg) { try { process.stderr.write(msg + "\n"); } catch {} }

// ─── Intervals ────────────────────────────────────
const FAST_TICK_MS = 500;        // 500ms — fast tick (in-memory only, reacts to CLOB WS data)
const FULL_TICK_MS = 15000;      // 15s — full tick (API prices + signals)
const MARKET_REFRESH_MS = 60000; // 60s — re-fetch markets from Gamma
const DASHBOARD_WS_MS = 1000;    // 1s — push state to dashboard

// ─── Core ─────────────────────────────────────────
const scalper = new Scalper();
const fiveMinScalper = new FiveMinScalper();
let binance = null;
let chainlink = null;
let multiExchange = null;
let polyWs = null;               // Polymarket CLOB WebSocket — live UP/DOWN prices (~100ms)
let dashboardClients = [];       // WebSocket clients for live dashboard
let started = false;

// ─── Startup ──────────────────────────────────────
async function boot() {
  slog("╔══════════════════════════════════════╗");
  slog("║   PolyWhale v2 — Localhost Scalper   ║");
  slog("╚══════════════════════════════════════╝");

  // 1. Start HTTP server FIRST (so dashboard is available immediately)
  startHttpServer();
  slog(`[Server] Dashboard: http://localhost:${PORT}`);
  slog(`[Server] API:       http://localhost:${PORT}/api/state`);

  // 2. Init scalper (loads saved state)
  await scalper.init();
  slog(`[Server] Scalper ready: ${scalper.totalBets} bets, ${scalper.positions.length} open`);
  if (supa.isConnected()) {
    const poolBal = await supa.getPoolBalance();
    slog(`[Server] Supabase connected — pool balance: $${poolBal.toFixed(2)}`);
  } else {
    slog("[Server] Supabase not connected — running without pool sync");
  }

  // 2.5. Init CLOB order client (real trading)
  const liveTrading = process.env.LIVE_TRADING === "true";
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (liveTrading && privateKey) {
    try {
      const clobOrders = new ClobOrders();
      await clobOrders.init(privateKey);
      scalper.setOrderClient(clobOrders, true);
      slog("[Server] LIVE TRADING ENABLED — real orders will be placed");
      // Read actual wallet balance from Polymarket
      try {
        const walletBal = await clobOrders.getBalance();
        slog(`[Server] Polymarket wallet balance: $${walletBal >= 0 ? walletBal.toFixed(2) : "unknown"}`);
        scalper._walletBalance = walletBal;
        // Update bankroll if pool was empty and wallet has funds
        if (walletBal > 0 && scalper.positions.length === 0) {
          scalper.bankroll = walletBal;
          scalper.startingBankroll = walletBal;
          slog(`[Server] Bankroll set to wallet balance: $${walletBal.toFixed(2)}`);
        }
      } catch {}
      // Init 5m scalper with the same CLOB client (before reconcile — can't be blocked)
      fiveMinScalper.init(clobOrders);
      slog("[Server] 5m scalper initialized with CLOB client");
      // Reconcile tracked positions against on-chain token balances
      await scalper.reconcileOnChain();
    } catch (e) {
      const msg = e instanceof Error ? e.message : (typeof e === "string" ? e : JSON.stringify(e));
      serr(`[Server] CLOB init failed, falling back to paper: ${msg}`);
      if (e instanceof Error && e.stack) serr(e.stack);
      scalper.setOrderClient(null, false);
    }
  } else {
    slog("[Server] Paper trading mode (set LIVE_TRADING=true in .env for real)");
  }

  // 3. Connect Binance WebSocket (fast signal detection — leads by 2-5s)
  binance = new BinanceWS((data) => {
    scalper.updateLiveBinance(data);
    // Feed Binance prices to multi-exchange aggregator
    if (multiExchange) multiExchange.updateBinance(data);
    // Feed BTC price to 5m scalper
    if (data.BTC) fiveMinScalper.updatePrice(data.BTC.price);
  });
  binance.connect();

  // 4. Connect Chainlink WebSocket (resolution truth — what markets resolve against)
  chainlink = new ChainlinkWS((prices) => {
    scalper.updateLiveChainlink(prices);
  });
  chainlink.connect();

  // 5. Connect multi-exchange feeds (Coinbase + Kraken → predicted Chainlink price)
  multiExchange = new MultiExchange((predicted) => {
    scalper.updatePredictedChainlink(predicted);
  });
  multiExchange.connect();

  // 6. Connect Polymarket CLOB WebSocket — live UP/DOWN token prices (~100ms)
  polyWs = new PolymarketWS((tokenId, mid, bookData) => {
    scalper.updateLiveCLOB(tokenId, mid, bookData);
  });
  polyWs.connect();

  // 7. Start tick loops (run even before markets load)
  startLoops();
  started = true;
  slog("[Server] Running. Press Ctrl+C to stop.\n");

  // 8. Fetch markets in background (may be slow if VPN is off)
  slog("[Server] Fetching Polymarket crypto markets...");
  await scalper.refreshMarkets().catch(e => serr("[Server] Market fetch:", e.message));
  slog(`[Server] ${scalper.markets.length} markets loaded`);
  fiveMinScalper.updateMarkets(scalper.markets);

  // 9. Subscribe CLOB WS to market token IDs for live prices
  subscribeClobTokens();

  // 10. Run first full tick if we got markets
  if (scalper.markets.length > 0) {
    await scalper.tick().catch(e => serr("[Server] First tick:", e.message));
  }
}

// ─── CLOB Token Subscription ─────────────────────
function subscribeClobTokens() {
  if (!polyWs || scalper.markets.length === 0) return;
  const tokenIds = [];
  for (const m of scalper.markets) {
    if (m.upToken) tokenIds.push(m.upToken);
    if (m.downToken) tokenIds.push(m.downToken);
  }
  if (tokenIds.length > 0) {
    polyWs.subscribe(tokenIds);
    slog(`[Server] CLOB WS subscribed to ${tokenIds.length} tokens from ${scalper.markets.length} markets`);
  }
}

// ─── Tick Loops ───────────────────────────────────
let fastInterval, fullInterval, refreshInterval, dashboardInterval;

function startLoops() {
  // Fast tick every 2s (uses cached prices, no API calls)
  fastInterval = setInterval(async () => {
    try {
      await scalper.fastTick();
    } catch (e) {
      serr("[Server] Fast tick error:", e.message);
    }
  }, FAST_TICK_MS);

  // Full tick every 15s (API prices + full scan)
  fullInterval = setInterval(async () => {
    try {
      await scalper.tick();
    } catch (e) {
      serr("[Server] Full tick error:", e.message);
    }
  }, FULL_TICK_MS);

  // Market refresh every 60s — also re-subscribe CLOB WS to new tokens
  refreshInterval = setInterval(async () => {
    try {
      await scalper.refreshMarkets();
      subscribeClobTokens();
      fiveMinScalper.updateMarkets(scalper.markets);
    } catch (e) {
      serr("[Server] Market refresh error:", e.message);
    }
  }, MARKET_REFRESH_MS);

  // 5m scalper tick every 1s
  setInterval(async () => {
    try { await fiveMinScalper.tick(); } catch (e) {
      serr("[Server] 5m scalp tick error:", e.message);
    }
  }, 1000);

  // Flush bot logs to Supabase every 3s
  setInterval(async () => {
    if (!supa.isConnected() || !scalper._logQueue || scalper._logQueue.length === 0) return;
    const batch = scalper._logQueue.splice(0);
    try { await supa.pushLogsBatch(batch); } catch {}
  }, 3000);

  // Heartbeat every 10s
  setInterval(() => {
    if (supa.isConnected()) supa.sendHeartbeat().catch(() => {});
  }, 10000);

  // Clean old logs hourly
  setInterval(() => {
    if (supa.isConnected()) supa.cleanOldLogs(24).catch(() => {});
  }, 3600000);

  // Refresh wallet balance from CLOB every 60s
  setInterval(async () => {
    if (scalper._orderClient && scalper._orderClient.ready) {
      try {
        const bal = await scalper._orderClient.getBalance();
        if (bal >= 0) scalper._walletBalance = bal;
      } catch {}
    }
  }, 60000);

  // Push state to dashboard WebSocket clients every 1s
  dashboardInterval = setInterval(() => {
    // Pass Chainlink lag stats to scalper (measured in ChainlinkWS)
    if (chainlink) {
      const clStats = chainlink.getStats();
      if (clStats.lag) scalper.updateChainlinkLag(clStats.lag);
    }
    if (dashboardClients.length === 0) return;
    const state = buildState();
    const json = JSON.stringify(state);
    const dead = [];
    for (const ws of dashboardClients) {
      try { ws.send(json); } catch { dead.push(ws); }
    }
    if (dead.length > 0) {
      dashboardClients = dashboardClients.filter(c => !dead.includes(c));
    }
  }, DASHBOARD_WS_MS);
}

function buildState() {
  return {
    scalper: scalper.getStats(),
    binance: binance ? binance.getStats() : null,
    chainlink: chainlink ? chainlink.getStats() : null,
    multiExchange: multiExchange ? multiExchange.getStats() : null,
    polyWs: polyWs ? polyWs.getStats() : null,
    fiveMin: fiveMinScalper.getState(),
    uptime: process.uptime(),
    ts: Date.now(),
  };
}

// ─── HTTP Server ──────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function startHttpServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // API endpoints
    if (path === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(buildState()));
      return;
    }

    if (path === "/api/reset" && req.method === "POST") {
      scalper.positions = [];
      scalper.history = [];
      scalper.totalPnl = 0;
      scalper.totalBets = 0;
      scalper.wins = 0;
      scalper.losses = 0;
      scalper.bankroll = 4.0;
      scalper.startingBankroll = 4.0;
      scalper._priceHistory = {};
      scalper._tickCount = 0;
      scalper._dailyPnl = 0;
      scalper._probeResults = {};
      scalper._executionStats = { fills: 0, failures: 0, totalSlippage: 0, totalSpreadCost: 0 };
      scalper._orderbooks = {};
      scalper.logs = [];
      scalper.log("INIT", "Scalper reset via dashboard — bankroll: $4.00 (CLOB execution ON)");
      scalper.save();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (path === "/api/manual-trade" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { asset, side, betSize } = JSON.parse(body);
          const result = await scalper.manualTrade(asset, side, betSize);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (path === "/api/clear-logs" && req.method === "POST") {
      scalper.logs = [];
      scalper.save();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Serve static files from public/
    let filePath = path === "/" ? "/index.html" : path;
    const fullPath = join(__dirname, "public", filePath);

    if (!existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(fullPath);
    const mime = MIME[ext] || "application/octet-stream";
    try {
      const content = readFileSync(fullPath);
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("Server error");
    }
  });

  // WebSocket upgrade for live dashboard
  const wss = new WebSocketServer({ server });

  wss.on("error", (err) => {
    crashLog(`[WSS-ERROR] ${err.message}`);
  });

  wss.on("connection", (ws) => {
    dashboardClients.push(ws);
    slog(`[Server] Dashboard client connected (${dashboardClients.length} total)`);

    // CRITICAL: must handle 'error' — unhandled 'error' event kills the process instantly
    ws.on("error", (err) => {
      crashLog(`[WS-CLIENT-ERROR] ${err.message}`);
      dashboardClients = dashboardClients.filter(c => c !== ws);
    });

    // Send initial state immediately
    try { ws.send(JSON.stringify(buildState())); } catch {}

    ws.on("close", () => {
      dashboardClients = dashboardClients.filter(c => c !== ws);
      slog(`[Server] Dashboard client disconnected (${dashboardClients.length} total)`);
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleDashboardMessage(msg, ws);
      } catch {}
    });
  });

  server.on("error", (err) => {
    crashLog(`[HTTP-ERROR] ${err.message}`);
  });

  server.listen(PORT, "0.0.0.0", () => {
    slog(`[Server] HTTP + WS listening on port ${PORT}`);
  });
}

async function handleDashboardMessage(msg, ws) {
  switch (msg.type) {
    case "RESET":
      scalper.positions = [];
      scalper.history = [];
      scalper.totalPnl = 0;
      scalper.totalBets = 0;
      scalper.wins = 0;
      scalper.losses = 0;
      scalper.bankroll = 4.0;
      scalper.startingBankroll = 4.0;
      scalper._priceHistory = {};
      scalper._tickCount = 0;
      scalper._dailyPnl = 0;
      scalper._probeResults = {};
      scalper._executionStats = { fills: 0, failures: 0, totalSlippage: 0, totalSpreadCost: 0 };
      scalper._orderbooks = {};
      scalper.logs = [];
      scalper.log("INIT", "Scalper reset via dashboard — bankroll: $4.00 (CLOB execution ON)");
      await scalper.refreshMarkets();
      await scalper.save();
      ws.send(JSON.stringify({ type: "RESET_OK" }));
      break;
    case "CLEAR_LOGS":
      scalper.logs = [];
      await scalper.save();
      break;
    case "REFRESH_MARKETS":
      api.clearCache();
      await scalper.refreshMarkets();
      subscribeClobTokens();
      break;
    case "MANUAL_TRADE": {
      const result = await scalper.manualTrade(msg.asset, msg.side, msg.betSize);
      ws.send(JSON.stringify({ type: "MANUAL_TRADE_RESULT", ...result }));
      break;
    }
  }
}

// ─── Graceful Shutdown ────────────────────────────
async function shutdown() {
  slog("\n[Server] Shutting down...");
  clearInterval(fastInterval);
  clearInterval(fullInterval);
  clearInterval(refreshInterval);
  clearInterval(dashboardInterval);
  if (binance) binance.close();
  if (chainlink) chainlink.close();
  if (multiExchange) multiExchange.close();
  if (polyWs) polyWs.close();
  // Flush remaining logs to Supabase
  if (supa.isConnected() && scalper._logQueue && scalper._logQueue.length > 0) {
    try { await supa.pushLogsBatch(scalper._logQueue.splice(0)); } catch {}
  }
  await scalper.save();
  slog("[Server] State saved. Bye!");
  process.exit(0);
}

// ─── Crash protection: log to FILE (survives stdout close) ───
import { appendFileSync } from "fs";
const CRASH_LOG = join(__dirname, "data", "crash.log");
function crashLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(CRASH_LOG, line); } catch {}
  serr(msg);
}

// EPIPE handler — prevents crash when terminal pipe disconnects (VSCode bug)
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") return; // silently ignore broken pipe
  try { appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] [STDOUT-ERROR] ${err.message}\n`); } catch {}
});
process.stderr.on("error", (err) => {
  if (err.code === "EPIPE") return;
  try { appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] [STDERR-ERROR] ${err.message}\n`); } catch {}
});

process.on("unhandledRejection", (err) => {
  crashLog(`[UNHANDLED-REJECTION] ${err?.message || err}`);
  crashLog(err?.stack || "no stack");
});
process.on("uncaughtException", (err) => {
  crashLog(`[UNCAUGHT-EXCEPTION] ${err?.message || err}`);
  crashLog(err?.stack || "no stack");
});
process.on("exit", (code) => {
  crashLog(`[EXIT] code=${code} handles=${process._getActiveHandles().length} requests=${process._getActiveRequests().length}`);
});
process.on("SIGINT", () => { crashLog("[SIGNAL] SIGINT"); shutdown(); });
process.on("SIGTERM", () => { crashLog("[SIGNAL] SIGTERM"); shutdown(); });

// Keepalive — prevents event loop from emptying
setInterval(() => {}, 30000);

// ─── Go ───────────────────────────────────────────
boot().catch(e => {
  crashLog(`[FATAL] ${e.message}\n${e.stack}`);
  process.exit(1);
});
