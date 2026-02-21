// Crypto Scalping Engine v9 — Real-time Node.js edition with Trader Brain
// v9: MarketIntelligence module for regime detection, trap avoidance,
//     structure analysis, smart money tracking, exhaustion detection
// Based on market microstructure research (Kyle 1985, Cont 2014, Bouchaud 2004)

import * as api from "./polymarket-api.js";
import * as store from "./storage.js";
import * as supa from "./supabase.js";
import { MarketIntelligence } from "./market-intelligence.js";

// ─── Config ──────────────────────────────────────
const PROBE_SIZE = 1.0;              // Polymarket minimum bet
const STARTING_BANKROLL = 8.25;      // Current on-chain balance
const MAX_POSITIONS = 1;             // 1d only — 5m proven unprofitable

// ═══ MARKET FILTERS ═══
const ONLY_BTC = true;               // ONLY trade BTC — no ETH/SOL (most liquid, best data)
const MAX_SINGLE_BET = 10.00;        // Cap for 1d BTC bets
const MAX_5M_BET = 2.00;            // Cap for 5m latency-arb bets (small, fast, high-frequency)
const ENTRY_LOCK_MS = 2000;          // 2 second lock after any entry (prevents double-entry)
const MIN_ENTRY_SECS = 60;
const MAX_LOGS = 200;
const PRICE_BUFFER = 7200;        // ~2 hours at 1/s — enough for chart patterns on 1h+ TF

// ═══ v10: TIMEFRAME-ADAPTIVE TRADING ═══
// Research-backed: stops scale with sqrt(time) volatility (Black-Scholes framework)
// BTC annualized vol ~50%, 5m 1-sigma ~0.15%, 1d 1-sigma ~2.1%
const STOP_LOSS_BY_TF =     { "5m": 0.12, "15m": 0.18, "1h": 0.28, "4h": 0.35, "1d": 0.40 };
const TRAILING_LOCK_BY_TF = { "5m": 0.50, "15m": 0.45, "1h": 0.35, "4h": 0.30, "1d": 0.25 };
const PROFIT_TARGET_BY_TF = { "5m": 0.08, "15m": 0.12, "1h": 0.20, "4h": 0.28, "1d": 0.45 };

// v10: Hold-through-dips on longer timeframes (mean reversion dominates on 1h/1d)
// On daily markets: BTC dip = buy opportunity, NOT panic sell signal
const HOLD_THROUGH_DIPS =   { "5m": false, "15m": false, "1h": true, "4h": true, "1d": true };

// v10: Annualized volatility for binary probability calculation (N(d2))
const ANNUAL_VOL = { "BTC": 0.50, "ETH": 0.60, "SOL": 0.80 };

// v10: Latency-aware exit delay — wait for Poly to catch up to Binance
const LATENCY_DELAY_MS = 5000;      // 5s delay for CLOB to reflect Binance move

// Liquidity-aware exit timing (CRITICAL — avoids FAK failures)
const LIQUIDITY_EXIT_BY_TF = { "5m": 30, "15m": 60, "1h": 120, "4h": 240, "1d": 600 };
const FORCE_EXIT_BY_TF = { "5m": 15, "15m": 30, "1h": 60, "4h": 120, "1d": 300 };
// Minimum seconds left to ENTER — need enough time for price to recover/move
// ~50% of 5m, ~47% of 15m, ~33% of 1h, ~25% of 4h, ~17% of 1d
const ENTRY_BUFFER_BY_TF = { "5m": 150, "15m": 420, "1h": 1200, "4h": 3600, "1d": 72000 };
const SLIPPAGE_PENALTY = 0.02;    // 2% slippage on forced late exits

// ─── v9.3: CLOB Execution Simulation ────────────
// Realistic Polymarket execution using live CLOB orderbook data
// GTC limit orders = maker = 0% fees + rebates. Taker (FAK/FOK) has dynamic fees up to 3.15% at 50c.
// Our bot uses GTC exclusively → we pay ZERO fees.
const USE_CLOB_PRICES = true;           // Use live CLOB midpoint instead of Gamma cache
const SPREAD_COST_ENTRY = 0.5;          // Pay 50% of spread on entry (buy at ask = mid + half spread)
const SPREAD_COST_EXIT = 0.5;           // Pay 50% of spread on exit (sell at bid = mid - half spread)
const SIZE_IMPACT_THRESHOLD = 100;      // Market impact only matters above $100 bets
const SIZE_IMPACT_FACTOR = 0.0001;      // 0.01% per $1 above threshold (negligible for small bets)
const LATE_EXIT_SPREAD_MULT = 2.0;      // Spread widens 2x in last 15s (liquidity dries up)

// Entry price bands
const ENTRY_MIN = 0.15;
const ENTRY_MAX = 0.85;
const SWEET_MIN = 0.30;
const SWEET_MAX = 0.70;

// Momentum thresholds
const MOM_WEAK = 0.0002;
const MOM_STRONG = 0.002;

// Predictive edge — Binance leads Polymarket by 2-5s
const PRED_EDGE_MIN = 0.03;       // min 3% edge to enter predictively
const PRED_CATCH_UP = 0.01;       // exit when gap closes to <1%

// Research-backed constants
const BEAR_BOOST = 1.2;
const VOL_HIGH_MULT = 2.0;
const KELLY_FRACTION = 0.25;
const DAILY_LOSS_LIMIT = 6.0;      // Full bankroll daily loss limit
const HEALTH_WINDOW = 30;
const HEALTH_MIN_WINRATE = 0.45;
const ARB_THRESHOLD = 0.97;
const RSI_PERIOD = 4;
const RSI_OB = 80;
const RSI_OS = 20;
const BB_PERIOD = 20;
const BB_MULT = 2.0;

// Stale timeouts
const STALE_BY_TF = { "5m": 240000, "1h": 1800000, "4h": 7200000, "1d": 43200000 };
const DEFAULT_STALE = 1800000;
const ALLOWED_TF = new Set(["1h", "4h", "1d"]);  // 5m removed — no edge, proven unprofitable

// ─── Probe/Test System ──────────────────────────
// Like real traders: test hypotheses with small bets first, then scale when proven
const PROBE_WINDOW = 20;            // track last 20 results per pattern
const PROBE_MIN_SAMPLES = 3;        // v9.1: lowered from 5 — graduate faster
const PROBE_WIN_THRESHOLD = 0.55;   // v9.1: lowered from 0.60 — less strict
const GLOBAL_MIN_TRADES = 8;        // v9.1: global track record for fast-track scaling
const GLOBAL_MIN_WR = 0.55;         // v9.1: 55%+ overall WR allows scaling on new patterns

// ─── Conviction Tiers ($6 bankroll — simple mode) ──
// With $6, bet tiers are small — auto-entry uses full bankroll anyway
const BET_TIERS = [
  { name: "SCOUT",      minConv: 0.00, maxConv: 0.30, minWR: 0,    pctMin: 0,    pctMax: 0,    fixed: PROBE_SIZE },
  { name: "SMALL",      minConv: 0.30, maxConv: 0.50, minWR: 0,    pctMin: 0.15, pctMax: 0.35, fixed: 0 },
  { name: "MEDIUM",     minConv: 0.50, maxConv: 0.70, minWR: 0,    pctMin: 0.35, pctMax: 0.60, fixed: 0 },
  { name: "HIGH",       minConv: 0.70, maxConv: 0.85, minWR: 0,    pctMin: 0.60, pctMax: 0.85, fixed: 0 },
  { name: "AGGRESSIVE", minConv: 0.85, maxConv: 0.95, minWR: 0,    pctMin: 0.85, pctMax: 0.98, fixed: 0 },
  { name: "ALL-IN",     minConv: 0.95, maxConv: 1.00, minWR: 0,    pctMin: 0.90, pctMax: 0.98, fixed: 0 },
];

export class Scalper {
  constructor() {
    this.positions = [];
    this.history = [];
    this.markets = [];
    this.totalPnl = 0;
    this.totalBets = 0;
    this.wins = 0;
    this.losses = 0;
    this.running = false;
    this.lastLog = "";
    this.logs = [];
    // Bankroll tracking — $100 starting
    this.bankroll = STARTING_BANKROLL;
    this.startingBankroll = STARTING_BANKROLL;
    this._lastRefresh = 0;
    this._priceHistory = {};
    this._realPrices = {};
    this._tickCount = 0;
    this._dailyPnl = 0;
    this._dailyResetDate = null;
    this._kellyWealth = 0;
    this._liveDataTs = 0;
    this._lastSignalLog = 0;
    this._lastSave = 0;
    this._refreshing = false;  // mutex for refreshMarkets
    this._ticking = false;     // mutex for tick
    this._lastEntryTime = 0;   // Entry lock timestamp — prevents double-entry bug
    // Probe/test system — tracks win/loss per signal pattern
    // Key: pattern string (e.g. "BTC-UP-PRED-bull-strong+RSI+CROSS")
    // Value: { wins: N, losses: N, results: [true/false...last 20] }
    this._probeResults = {};
    // v9: Market Intelligence — the "Trader Brain"
    this._mi = new MarketIntelligence();
    // v9.3: CLOB execution tracking
    this._orderbooks = {};          // tokenId → { mid, bestBid, bestAsk, spread, bidDepth, askDepth }
    this._executionStats = { fills: 0, failures: 0, totalSlippage: 0, totalSpreadCost: 0 };
    // v9.4: Chainlink oracle prices — resolution truth for UP/DOWN markets
    // Polymarket resolves against Chainlink, NOT Binance
    this._chainlinkPrices = {};     // { BTC: 97123.45, ETH: 3456.78, SOL: 189.12 }
    this._chainlinkTs = 0;          // last update timestamp
    this._chainlinkLag = {};        // { BTC: { lagMs, avgIntervalMs } } — oracle lag data
    // v9.5: Multi-exchange predicted Chainlink price (median of Binance+Coinbase+Kraken)
    this._predictedChainlink = {};  // { BTC: 97105, ETH: 3456, SOL: 189 }
    this._predictedTs = 0;
    // v9.6: CLOB WebSocket live pricing timestamp
    this._clobLiveTs = 0;
    // v11: Real order execution via CLOB client
    this._orderClient = null;  // ClobOrders instance (null = paper trading)
    this._liveTading = false;
    this._entryLock = false;   // mutex: prevents double-entry from concurrent ticks
    this._walletBalance = 0;   // actual USDC balance on Polymarket (set by server after CLOB init)
    this._logQueue = [];       // queued logs for Supabase batch push
  }

  // Set the real order execution client (called from server.js)
  setOrderClient(client, live = true) {
    this._orderClient = client;
    this._liveTading = live;
    this.log("INIT", `Order execution: ${live ? "LIVE (real money)" : "PAPER (simulation)"}`);
  }

  // ═══ ON-CHAIN RECONCILIATION ═══
  // Call after CLOB client is ready. Verifies tracked positions have tokens on-chain.
  // Removes ghost positions that were sold/resolved outside the bot.
  async reconcileOnChain() {
    if (!this._orderClient || !this._orderClient.ready || this.positions.length === 0) return;

    const beforeCount = this.positions.length;
    const reconciled = [];
    for (const p of this.positions) {
      if (!p.tokenId) { reconciled.push(p); continue; }
      try {
        const bal = await this._orderClient.client.getBalanceAllowance({
          asset_type: "CONDITIONAL", token_id: p.tokenId,
        });
        const onChainShares = parseFloat(bal.balance) / 1e6;
        if (onChainShares >= 0.5) {
          if (Math.abs(onChainShares - p.size) > 0.1) {
            this.log("RECONCILE", `${p.asset} ${p.side} [${p.timeframe}]: size ${p.size.toFixed(2)} → ${onChainShares.toFixed(2)} (on-chain)`);
            p.size = onChainShares;
          }
          reconciled.push(p);
        } else {
          this.log("RECONCILE", `${p.asset} ${p.side} [${p.timeframe}]: REMOVED (0 tokens on-chain, was ${p.size.toFixed(2)} shares)`);
        }
      } catch (e) {
        this.log("RECONCILE", `${p.asset} ${p.side} [${p.timeframe}]: check failed (${e.message}), keeping`);
        reconciled.push(p);
      }
    }
    this.positions = reconciled;
    if (reconciled.length !== beforeCount) {
      this.log("RECONCILE", `Removed ${beforeCount - reconciled.length} ghost position(s)`);
      // Recalc bankroll from wallet balance
      const walletBal = await this._orderClient.getBalance();
      if (walletBal > 0) {
        this.bankroll = walletBal;
        this.startingBankroll = walletBal + this.positions.reduce((s, p) => s + (p.costBasis || PROBE_SIZE), 0);
        this.log("RECONCILE", `Bankroll synced to wallet: $${walletBal.toFixed(2)}`);
      }
      await this.save();
    } else {
      this.log("RECONCILE", `All ${beforeCount} position(s) verified on-chain`);
    }
  }

  log(type, msg) {
    const entry = { ts: Date.now(), type, msg };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.lastLog = msg;
    // Only print important logs to stdout — reduces Windows stdout buffer pressure
    // TICK/SIGNAL/MARKET are high-frequency noise; only print every Nth or skip
    if (type === "TICK" || type === "SIGNAL" || type === "MARKET") {
      this._logSkipCount = (this._logSkipCount || 0) + 1;
      if (this._logSkipCount % 20 === 0) {
        try { process.stdout.write(`[Scalper][${type}] ${msg}\n`); } catch {}
      }
    } else {
      try { process.stdout.write(`[Scalper][${type}] ${msg}\n`); } catch {}
    }
    // Queue for Supabase batch push (flushed by server.js every 1s)
    if (!this._logQueue) this._logQueue = [];
    this._logQueue.push(entry);
  }

  async init() {
    // Try loading from Supabase first (primary), fall back to file (backup)
    let saved = null;
    if (supa.isConnected()) {
      const supaState = await supa.loadState();
      if (supaState && (supaState.total_bets > 0 || (supaState.positions && supaState.positions.length > 0))) {
        saved = {
          positions: supaState.positions || [],
          history: supaState.history || [],
          totalPnl: supaState.total_pnl || 0,
          totalBets: supaState.total_bets || 0,
          wins: supaState.wins || 0,
          losses: supaState.losses || 0,
          tickCount: supaState.tick_count || 0,
          dailyPnl: supaState.daily_pnl || 0,
          dailyResetDate: supaState.daily_reset_date || null,
          bankroll: supaState.bankroll || 0,
          startingBankroll: supaState.starting_bankroll || 0,
          probeResults: supaState.probe_results || {},
          executionStats: supaState.execution_stats || { fills: 0, failures: 0, totalSlippage: 0, totalSpreadCost: 0 },
          logs: [],
        };
        this.log("INIT", "Loaded state from Supabase");
      }
    }
    if (!saved) {
      saved = await store.get("scalperState");
      if (saved) this.log("INIT", "Loaded state from local file");
    }
    if (saved) {
      this.positions = saved.positions || [];
      this.history = saved.history || [];
      this.totalPnl = saved.totalPnl || 0;
      this.totalBets = saved.totalBets || 0;
      this.wins = saved.wins || 0;
      this.losses = saved.losses || 0;
      this._priceHistory = {};
      this._realPrices = {};
      this._tickCount = saved.tickCount || 0;
      this._dailyPnl = saved.dailyPnl || 0;
      this._dailyResetDate = saved.dailyResetDate || null;
      this._kellyWealth = saved.kellyWealth || 0;
      this.logs = saved.logs || [];
      this.bankroll = typeof saved.bankroll === "number" ? saved.bankroll : STARTING_BANKROLL;
      this.startingBankroll = saved.startingBankroll || STARTING_BANKROLL;
      this._probeResults = saved.probeResults || {};
      this._executionStats = saved.executionStats || { fills: 0, failures: 0, totalSlippage: 0, totalSpreadCost: 0 };
    }

    // Override bankroll with live pool balance from Supabase (primary)
    // OR wallet balance from Polymarket CLOB (fallback if no pool deposits yet)
    if (supa.isConnected()) {
      const poolBalance = await supa.getPoolBalance();
      if (poolBalance > 0) {
        this.bankroll = poolBalance;
        this.startingBankroll = poolBalance;
        this.log("INIT", `Pool balance from Supabase: $${poolBalance.toFixed(2)}`);
      } else if (this._walletBalance > 0) {
        this.bankroll = this._walletBalance;
        this.startingBankroll = this._walletBalance;
        this.log("INIT", `Wallet balance from Polymarket: $${this._walletBalance.toFixed(2)} (no pool deposits yet)`);
      } else {
        this.log("INIT", "Pool balance: $0 — waiting for user deposits via EmpusaAI");
      }
    } else if (this._walletBalance > 0) {
      this.bankroll = this._walletBalance;
      this.startingBankroll = this._walletBalance;
      this.log("INIT", `Wallet balance from Polymarket: $${this._walletBalance.toFixed(2)}`);
    }
    this.positions = this.positions.filter(p => p.conditionId !== "test-url-check");
    // Migrate old YES/NO → UP/DOWN
    for (const p of this.positions) {
      if (p.side === "YES") p.side = "UP";
      else if (p.side === "NO") p.side = "DOWN";
    }
    for (const h of this.history) {
      if (h.side === "YES") h.side = "UP";
      else if (h.side === "NO") h.side = "DOWN";
    }

    // Recalculate bankroll from positions if not saved (migration)
    if (!saved || typeof saved.bankroll !== "number") {
      const locked = this.positions.reduce((s, p) => s + (p.costBasis || PROBE_SIZE), 0);
      this.bankroll = STARTING_BANKROLL + this.totalPnl - locked;
    }
    this._checkDailyReset();
    this.running = true;
    const locked = this.positions.reduce((s, p) => s + (p.costBasis || PROBE_SIZE), 0);
    this.log("INIT", `v9+MI ready: $${this.bankroll.toFixed(2)} available | $${locked.toFixed(2)} locked | ${this.totalBets} bets | P&L $${this.totalPnl.toFixed(2)} | ${Object.keys(this._probeResults).length} patterns | TraderBrain ON`);
  }

  async save() {
    // Local file backup (always works, even offline)
    await store.set("scalperState", {
      positions: this.positions,
      history: this.history.slice(0, 500),
      totalPnl: this.totalPnl,
      totalBets: this.totalBets,
      wins: this.wins,
      losses: this.losses,
      bankroll: this.bankroll,
      startingBankroll: this.startingBankroll,
      tickCount: this._tickCount,
      dailyPnl: this._dailyPnl,
      dailyResetDate: this._dailyResetDate,
      kellyWealth: this._kellyWealth,
      probeResults: this._probeResults,
      executionStats: this._executionStats,
      logs: this.logs.slice(-MAX_LOGS),
    });
    // Supabase state (primary — for dashboard visibility + crash recovery)
    supa.saveState({
      status: this.positions.length > 0 ? "trading" : "idle",
      positions: this.positions,
      history: this.history.slice(0, 100),
      total_pnl: this.totalPnl,
      total_bets: this.totalBets,
      wins: this.wins,
      losses: this.losses,
      bankroll: this.bankroll,
      starting_bankroll: this.startingBankroll,
      daily_pnl: this._dailyPnl,
      daily_reset_date: this._dailyResetDate,
      tick_count: this._tickCount,
      probe_results: this._probeResults,
      execution_stats: this._executionStats,
    }).catch(() => {});
    this._lastSave = Date.now();
  }

  _checkDailyReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (this._dailyResetDate !== today) {
      if (this._dailyResetDate) this.log("INIT", `New day — yesterday P&L: $${this._dailyPnl.toFixed(2)}`);
      this._dailyPnl = 0;
      this._dailyResetDate = today;
    }
  }

  // ═══════════════════════════════════════════════
  //  LIVE PRICE INGESTION (from Binance WS)
  // ═══════════════════════════════════════════════

  // data: { BTC: { price, vol }, ETH: { price, vol }, SOL: { price, vol } }
  // or legacy: { BTC: 69000, ETH: 2050, SOL: 85 }
  updateLiveBinance(data) {
    this._updateRealPrices(data);
    this._liveDataTs = Date.now();
  }

  // v9.4: Chainlink oracle prices from Polymarket RTDS
  // These are the RESOLUTION TRUTH — what UP/DOWN markets actually resolve against
  // prices: { BTC: 97123.45, ETH: 3456.78, SOL: 189.12 }
  updateLiveChainlink(prices) {
    for (const [asset, price] of Object.entries(prices)) {
      if (price && price > 0) this._chainlinkPrices[asset] = price;
    }
    this._chainlinkTs = Date.now();
  }

  // Called from server to pass lag stats from ChainlinkWS
  updateChainlinkLag(lagInfo) {
    this._chainlinkLag = lagInfo || {};
  }

  // v9.6: Live CLOB prices from Polymarket WebSocket (~100ms latency)
  // Replaces 15s HTTP polling with streaming orderbook data
  // tokenId: CLOB token ID, mid: midpoint price, bookData: { bestBid, bestAsk, spread, bidDepth, askDepth, lastTrade }
  updateLiveCLOB(tokenId, mid, bookData) {
    if (!tokenId || !mid || mid <= 0) return;

    // Update orderbook data for execution simulation
    this._orderbooks[tokenId] = {
      mid,
      bestBid: bookData.bestBid || 0,
      bestAsk: bookData.bestAsk || 0,
      spread: bookData.spread || 0,
      bidDepth: bookData.bidDepth || 0,
      askDepth: bookData.askDepth || 0,
    };

    // Update price history (same structure as _updatePolyPrices)
    const now = Date.now();
    if (!this._priceHistory[tokenId]) this._priceHistory[tokenId] = [];
    const hist = this._priceHistory[tokenId];

    // Deduplicate: if last entry < 200ms ago, update in place
    if (hist.length > 0 && now - hist[hist.length - 1].ts < 200) {
      hist[hist.length - 1].price = mid;
      hist[hist.length - 1].ts = now;
    } else {
      hist.push({ price: mid, ts: now });
    }
    if (hist.length > 20) hist.splice(0, hist.length - 20);

    // Update gammaUpPrice/gammaDownPrice on matching markets (so fastTick sees fresh prices)
    for (const m of this.markets) {
      if (m.upToken === tokenId) m.gammaUpPrice = mid;
      else if (m.downToken === tokenId) m.gammaDownPrice = mid;
    }

    this._clobLiveTs = now;
  }

  // v9.5: Multi-exchange predicted Chainlink price (median of Binance+Coinbase+Kraken)
  updatePredictedChainlink(prices) {
    for (const [asset, price] of Object.entries(prices)) {
      if (price && price > 0) this._predictedChainlink[asset] = price;
    }
    this._predictedTs = Date.now();
  }

  // Get predicted Chainlink resolution price (multi-exchange median)
  _getPredictedChainlink(asset) {
    if (this._predictedTs === 0 || Date.now() - this._predictedTs > 15000) return null;
    return this._predictedChainlink[asset] || null;
  }

  // Get the current Chainlink price for an asset (resolution oracle)
  _getChainlinkPrice(asset) {
    if (this._chainlinkTs === 0 || Date.now() - this._chainlinkTs > 60000) return null;
    return this._chainlinkPrices[asset] || null;
  }

  // Get Chainlink oracle lag in seconds for an asset
  _getChainlinkLagSecs(asset) {
    const info = this._chainlinkLag[asset];
    if (!info || !info.lagMs) return 30; // default assumption: 30s lag
    return info.lagMs / 1000;
  }

  // v9.4: Price divergence between Binance (fast) and Chainlink (resolution)
  // Positive = Binance ahead of Chainlink, Negative = Binance behind
  _getPriceDivergence(asset) {
    const hist = this._realPrices[asset];
    if (!hist || hist.length === 0) return null;
    const binancePrice = hist[hist.length - 1].price;
    const chainlinkPrice = this._getChainlinkPrice(asset);
    if (!chainlinkPrice) return null;
    const diff = binancePrice - chainlinkPrice;
    const pct = diff / chainlinkPrice;
    return { binance: binancePrice, chainlink: chainlinkPrice, diff, pct };
  }

  // ═══════════════════════════════════════════════
  //  v10: BINARY PROBABILITY & PRICE DISTANCE
  //  Black-Scholes N(d2) for binary options
  // ═══════════════════════════════════════════════

  // Get current crypto price from best available source
  _getCryptoPrice(asset) {
    // Priority: multi-exchange predicted > Binance WS > Chainlink
    const predicted = this._getPredictedChainlink(asset);
    if (predicted) return predicted;
    const hist = this._realPrices[asset];
    if (hist && hist.length > 0) return hist[hist.length - 1].price;
    return this._getChainlinkPrice(asset);
  }

  // Binary option probability using N(d2) from Black-Scholes
  // Returns probability that price will be ABOVE startPrice at expiry
  _binaryProbability(currentPrice, startPrice, secsRemaining, asset = "BTC") {
    if (!currentPrice || !startPrice || startPrice <= 0) return 0.5;
    if (secsRemaining <= 0) return currentPrice > startPrice ? 0.99 : 0.01;
    const T = secsRemaining / (365.25 * 24 * 3600); // seconds to years
    const sigma = ANNUAL_VOL[asset] || 0.50;
    const logRatio = Math.log(currentPrice / startPrice);
    const d2 = (logRatio + (-0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    return this._normalCDF(d2);
  }

  // Standard normal CDF (Abramowitz & Stegun approximation)
  _normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return 0.5 * (1.0 + sign * y);
  }

  // Calculate how strongly the crypto price supports our position direction
  // Uses TWO probability sources:
  //   1. LIVE TOKEN PRICE — the CLOB market IS the probability (best source)
  //   2. CRYPTO PRICE vs entry — Black-Scholes N(d2) as backup/confirmation
  // The token price reflects what ALL market participants think, including
  // the resolution source (Chainlink), time decay, and liquidity.
  _getPriceSupport(pos) {
    const cryptoNow = this._getCryptoPrice(pos.asset);
    const cryptoAtEntry = pos.cryptoPriceAtEntry;
    const now = Date.now();

    // BEST SOURCE: current token price IS the market's implied win probability
    // Token at $0.85 = market says 85% chance this side wins
    // This already factors in Chainlink resolution, time decay, everything
    const tokenProb = pos.currentPrice || pos.entryPrice;

    // BACKUP: Black-Scholes probability from crypto price movement
    let bsProb = 0.5;
    if (cryptoNow && cryptoAtEntry) {
      const secsLeft = pos.endDate ? Math.max(0, (pos.endDate - now) / 1000) : 99999;
      const rawProb = this._binaryProbability(cryptoNow, cryptoAtEntry, secsLeft, pos.asset);
      bsProb = pos.side === "UP" ? rawProb : 1 - rawProb;
    }

    // Blend: trust token price more (it sees what we can't — Chainlink, smart money)
    // But if we have fresh crypto data, use it to confirm
    const probability = cryptoNow && cryptoAtEntry
      ? tokenProb * 0.6 + bsProb * 0.4  // 60% token price, 40% Black-Scholes
      : tokenProb;                         // no crypto data, trust token 100%

    const distance = cryptoNow && cryptoAtEntry ? Math.abs(cryptoNow - cryptoAtEntry) : 0;
    const distancePct = cryptoAtEntry ? distance / cryptoAtEntry : 0;
    const directionMatch = cryptoNow && cryptoAtEntry
      ? (pos.side === "UP" && cryptoNow > cryptoAtEntry) || (pos.side === "DOWN" && cryptoNow < cryptoAtEntry)
      : false;

    return {
      probability,
      distance,
      distancePct,
      directionMatch,
      supports: probability > 0.55,
      cryptoNow: cryptoNow || 0,
      cryptoAtEntry: cryptoAtEntry || 0,
      tokenProb,
      bsProb,
    };
  }

  // ═══════════════════════════════════════════════
  //  PRE-ENTRY VIABILITY CHECK
  //  "Before you buy, ask: can I sell if this goes wrong?"
  // ═══════════════════════════════════════════════

  // Calculates whether a trade is worth entering based on:
  // 1. How far is crypto from the resolution threshold? (is this side even realistic?)
  // 2. How much time is left? (can BTC move enough to win/lose?)
  // 3. If it goes wrong, will there be liquidity to exit? (FAK risk)
  // 4. Expected value: probability * payout vs cost
  //
  // Returns { viable: bool, reason: string, winProb, maxMove, expectedPnl }
  _assessEntryViability(asset, _side, entryPrice, secsLeft) {
    const cryptoNow = this._getCryptoPrice(asset);
    if (!cryptoNow) return { viable: true, reason: "no-crypto-data" }; // can't assess, allow

    const sigma = ANNUAL_VOL[asset] || 0.50;
    const secsInYear = 365.25 * 24 * 3600;

    // Max realistic BTC move in remaining time (3-sigma = 99.7% of moves)
    const T = secsLeft / secsInYear;
    const oneSigmaMove = cryptoNow * sigma * Math.sqrt(T);
    const maxRealisticMove = oneSigmaMove * 3; // 3-sigma

    // For UP/DOWN markets, resolution is: did crypto go UP or DOWN from market start?
    // We use cryptoPriceAtEntry as proxy for market start price
    // But for pre-entry, we use current crypto price to check if we're already on the wrong side

    // What's the probability this side wins? (Black-Scholes N(d2))
    // For now, use current price as both "current" and "start" — the question is
    // whether crypto will be above/below current level at expiry
    // Actually, what matters is: above/below the MARKET's reference price
    // We approximate: our side's token price reflects the market's implied probability
    // Token at $0.50 = 50/50, token at $0.04 = market says 4% chance
    const marketImpliedProb = entryPrice; // token price IS the probability

    // How much can crypto move vs how much it NEEDS to move for us to win?
    // If token is at $0.04, market says 96% chance we lose
    // Is there a realistic scenario where we win? Only if crypto can move enough
    const minsLeft = secsLeft / 60;

    // RULE 1: Don't buy tokens the market prices at <15% if <2h left
    // At that point, the market is saying "this almost certainly won't happen"
    // and near expiry you CAN'T SELL because no one will buy a dying token
    if (marketImpliedProb < 0.15 && minsLeft < 120) {
      return {
        viable: false,
        reason: `token@${(marketImpliedProb * 100).toFixed(0)}%+${minsLeft.toFixed(0)}min=dead-money`,
        winProb: marketImpliedProb, maxMove: maxRealisticMove,
      };
    }

    // RULE 2: Don't buy tokens at <8% regardless of time — market is screaming "no"
    if (marketImpliedProb < 0.08) {
      return {
        viable: false,
        reason: `token@${(marketImpliedProb * 100).toFixed(0)}%=market-says-no`,
        winProb: marketImpliedProb, maxMove: maxRealisticMove,
      };
    }

    // RULE 3: FAK risk — if the token is cheap AND time is running out,
    // you WON'T find buyers if it drops further. Your $1 is gone.
    // Cheap tokens near expiry = 100% FAK failure on exit
    if (entryPrice < 0.25 && minsLeft < 60) {
      return {
        viable: false,
        reason: `cheap-token+${minsLeft.toFixed(0)}min=guaranteed-FAK`,
        winProb: marketImpliedProb, maxMove: maxRealisticMove,
      };
    }

    // RULE 4: Expected value check
    // If we win: payout is $1 per token, so profit = (1 - entryPrice) / entryPrice * betSize
    // If we lose: token goes to ~$0, lose entire bet
    // EV = winProb * (1 - entryPrice) - (1 - winProb) * entryPrice
    //    = winProb - entryPrice  (simplified)
    // Need positive EV to enter
    // EV = winProb - entryPrice (simplified). We trust momentum over market price
    // so don't strictly enforce, but it informs the sigma check below.

    // RULE 5: Check if crypto price makes this side mathematically hopeless
    // Example: BTC at $68k, we want DOWN, market resolves based on whether BTC
    // goes below the reference price. If BTC needs to drop $2k in 15 min,
    // that's $2000 / $141 (1-sigma for 15min) = 14 sigma = impossible
    // We calculate the number of sigmas the required move represents
    if (oneSigmaMove > 0) {
      // How many sigmas would be needed for the losing side to recover?
      // This is a conservative check: if the current token price says we have X% chance,
      // and the math says we need >4 sigma move, it's not happening
      const impliedEdgeSigmas = Math.abs(Math.log(1 / marketImpliedProb)) / (sigma * Math.sqrt(T));
      // If we need > 4 sigma AND < 30 min left, definitely don't enter
      if (impliedEdgeSigmas > 4 && minsLeft < 30) {
        return {
          viable: false,
          reason: `need-${impliedEdgeSigmas.toFixed(1)}σ-in-${minsLeft.toFixed(0)}min=impossible`,
          winProb: marketImpliedProb, maxMove: maxRealisticMove,
        };
      }
    }

    return {
      viable: true,
      reason: "OK",
      winProb: marketImpliedProb,
      maxMove: maxRealisticMove,
      oneSigma: oneSigmaMove,
      minsLeft,
    };
  }

  // ═══════════════════════════════════════════════
  //  SIGNAL ENGINE — Time-based (any tick frequency)
  // ═══════════════════════════════════════════════

  _updateRealPrices(data) {
    const now = Date.now();
    for (const [asset, value] of Object.entries(data)) {
      // Support both { price, vol } and raw number formats
      const price = typeof value === "object" ? value.price : value;
      const vol = typeof value === "object" ? (value.vol || 0) : 0;
      if (!price || price <= 0) continue;
      if (!this._realPrices[asset]) this._realPrices[asset] = [];
      const hist = this._realPrices[asset];
      // Deduplicate: if last entry < 500ms ago, update instead of adding
      if (hist.length > 0 && now - hist[hist.length - 1].ts < 500) {
        hist[hist.length - 1].price = price;
        hist[hist.length - 1].vol = (hist[hist.length - 1].vol || 0) + vol;
        hist[hist.length - 1].ts = now;
      } else {
        hist.push({ price, vol, ts: now });
      }
      if (hist.length > PRICE_BUFFER) hist.splice(0, hist.length - PRICE_BUFFER);
    }
  }

  // Time-based price lookup — works regardless of tick frequency
  _getPriceAtTime(asset, secsAgo) {
    const hist = this._realPrices[asset];
    if (!hist || hist.length === 0) return null;
    const targetTs = Date.now() - secsAgo * 1000;
    let best = null, bestDist = Infinity;
    for (let i = hist.length - 1; i >= 0; i--) {
      const dist = Math.abs(hist[i].ts - targetTs);
      if (dist < bestDist) { bestDist = dist; best = hist[i]; }
      else break;
    }
    return best && bestDist < 120000 ? best.price : null;
  }

  // v10: Get momentum (price change %) over a lookback period
  _getMomentum(asset, secsAgo) {
    const now = this._realPrices[asset];
    if (!now || now.length === 0) return 0;
    const current = now[now.length - 1].price;
    const past = this._getPriceAtTime(asset, secsAgo);
    if (!past || past <= 0) return 0;
    return (current - past) / past;
  }

  _getRSI(asset) {
    const prices = [];
    for (let i = RSI_PERIOD; i >= 0; i--) {
      const p = this._getPriceAtTime(asset, i * 30);
      if (p) prices.push(p);
    }
    if (prices.length < 3) return 50;
    const changes = [];
    for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
    // Cold-start guard: if all changes are near-zero, return neutral
    const maxChange = Math.max(...changes.map(Math.abs));
    if (maxChange < 0.01) return 50;
    let avgGain = 0, avgLoss = 0;
    for (const c of changes) { if (c > 0) avgGain += c; else avgLoss += Math.abs(c); }
    avgGain /= changes.length; avgLoss /= changes.length;
    if (avgLoss === 0) return avgGain === 0 ? 50 : 85;
    if (avgGain === 0) return 15;
    const rsi = 100 - (100 / (1 + avgGain / avgLoss));
    return Math.max(15, Math.min(85, rsi));  // always clamp [15, 85]
  }

  _getBollinger(asset) {
    const prices = [];
    for (let i = BB_PERIOD - 1; i >= 0; i--) {
      const p = this._getPriceAtTime(asset, i * 30);
      if (p) prices.push(p);
    }
    if (prices.length < 5) return { position: 0, percentB: 0.5 };
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
    const sd = Math.sqrt(variance);
    // Cold-start guard: if sd is tiny relative to price, bands are meaningless
    if (sd < mean * 0.00005) return { position: 0, percentB: 0.5, upper: mean, lower: mean, mean, sd: 0 };
    const upper = mean + BB_MULT * sd, lower = mean - BB_MULT * sd;
    const current = prices[prices.length - 1];
    const percentB = (current - lower) / (upper - lower);
    const position = current > upper ? 1 : current < lower ? -1 : 0;
    return { position, percentB, upper, lower, mean, sd };
  }

  _getVolatility(asset) {
    const recentPrices = [];
    for (let i = 5; i >= 0; i--) { const p = this._getPriceAtTime(asset, i * 30); if (p) recentPrices.push(p); }
    if (recentPrices.length < 3) return { current: 0, average: 0, regime: "unknown" };
    const recentReturns = [];
    for (let i = 1; i < recentPrices.length; i++) recentReturns.push((recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1]);
    const recentVol = Math.sqrt(recentReturns.reduce((a, r) => a + r * r, 0) / recentReturns.length);
    const allPrices = [];
    for (let i = 20; i >= 0; i--) { const p = this._getPriceAtTime(asset, i * 30); if (p) allPrices.push(p); }
    const allReturns = [];
    for (let i = 1; i < allPrices.length; i++) allReturns.push((allPrices[i] - allPrices[i - 1]) / allPrices[i - 1]);
    const avgVol = allReturns.length > 0 ? Math.sqrt(allReturns.reduce((a, r) => a + r * r, 0) / allReturns.length) : 0;
    const regime = avgVol > 0 && recentVol > avgVol * VOL_HIGH_MULT ? "high" : "low";
    return { current: recentVol, average: avgVol, regime };
  }

  // Paper 1.2: Volume-weighted momentum — high volume confirms trend reliability
  _getVolumeRatio(asset) {
    const hist = this._realPrices[asset];
    if (!hist || hist.length < 20) return { ratio: 1, recent: 0, average: 0 };
    const recentCount = Math.min(10, Math.floor(hist.length / 4));
    const recent = hist.slice(-recentCount);
    const older = hist.slice(0, -recentCount);
    const recentAvgVol = recent.reduce((s, e) => s + (e.vol || 0), 0) / recentCount;
    const olderAvgVol = older.reduce((s, e) => s + (e.vol || 0), 0) / older.length;
    if (olderAvgVol <= 0) return { ratio: 1, recent: recentAvgVol, average: 0 };
    return { ratio: recentAvgVol / olderAvgVol, recent: recentAvgVol, average: olderAvgVol };
  }

  _getCrossAssetConsensus() {
    const signals = {};
    for (const asset of ["BTC", "ETH", "SOL"]) signals[asset] = this._getSignalRaw(asset).direction;
    const dirs = Object.values(signals).filter(d => d !== 0);
    if (dirs.length < 2) return { consensus: 0, agreement: 0 };
    const sum = dirs.reduce((a, b) => a + b, 0);
    return { consensus: sum > 0 ? 1 : sum < 0 ? -1 : 0, agreement: Math.abs(sum) / dirs.length, signals };
  }

  _getSignalRaw(asset) {
    const hist = this._realPrices[asset];
    if (!hist || hist.length < 3) return { direction: 0, strength: 0, reason: "no-data" };
    // Cold-start guard: need at least 30s of price data for meaningful signals
    const dataAge = (Date.now() - hist[0].ts) / 1000;
    if (dataAge < 30) return { direction: 0, strength: 0, reason: "warming-up" };
    const now = hist[hist.length - 1].price;
    const p30s = this._getPriceAtTime(asset, 30) || now;
    const p90s = this._getPriceAtTime(asset, 90) || p30s;
    const p3m  = this._getPriceAtTime(asset, 180) || p90s;
    const p5m  = this._getPriceAtTime(asset, 300) || p3m;
    const p10m = this._getPriceAtTime(asset, 600) || p5m;

    const mom30s = (now - p30s) / p30s;
    const mom90s = (now - p90s) / p90s;
    const mom3m  = (now - p3m) / p3m;
    const mom5m  = (now - p5m) / p5m;
    const mom10m = (now - p10m) / p10m;

    const signal = mom30s * 0.30 + mom90s * 0.25 + mom3m * 0.20 + mom5m * 0.15 + mom10m * 0.10;
    const absSignal = Math.abs(signal);
    const signs = [mom30s, mom90s, mom3m, mom5m].map(m => m > 0 ? 1 : m < 0 ? -1 : 0);
    const consistency = Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length;
    if (absSignal < MOM_WEAK) return { direction: 0, strength: 0, reason: "flat" };
    const direction = signal > 0 ? 1 : -1;
    let strength = Math.min(absSignal / MOM_STRONG, 1.0) * 0.6 + consistency * 0.4;
    // Cap strength by data maturity: <90s = max 0.4, <180s = max 0.7
    if (dataAge < 90) strength = Math.min(strength, 0.4);
    else if (dataAge < 180) strength = Math.min(strength, 0.7);
    return { direction, strength, reason: "" };
  }

  _getSignal(asset) {
    const raw = this._getSignalRaw(asset);
    if (raw.direction === 0) return { direction: 0, strength: 0, reason: "flat" };
    let strength = raw.strength;
    const boosts = [];

    const rsi = this._getRSI(asset);
    if (raw.direction > 0 && rsi > RSI_OB) { strength *= 1.15; boosts.push("RSI"); }
    else if (raw.direction < 0 && rsi < RSI_OS) { strength *= 1.15; boosts.push("RSI"); }
    else if ((raw.direction > 0 && rsi < 35) || (raw.direction < 0 && rsi > 65)) strength *= 0.7;

    const bb = this._getBollinger(asset);
    if (raw.direction > 0 && bb.position > 0) { strength *= 1.1; boosts.push("BB"); }
    else if (raw.direction < 0 && bb.position < 0) { strength *= 1.1; boosts.push("BB"); }

    const cross = this._getCrossAssetConsensus();
    if (cross.consensus === raw.direction && cross.agreement >= 0.66) { strength *= 1.15; boosts.push("CROSS"); }
    else if (cross.consensus !== 0 && cross.consensus !== raw.direction) strength *= 0.8;

    // Paper 11.2: Asymmetric volatility — bear signals more reliable
    if (raw.direction < 0) { strength *= BEAR_BOOST; boosts.push("ASYM"); }

    // Paper 1.2: Volume-weighted momentum — high volume confirms trend
    const volRatio = this._getVolumeRatio(asset);
    if (volRatio.ratio > 2.0 && volRatio.average > 0) { strength *= 1.2; boosts.push("VOL"); }
    else if (volRatio.ratio < 0.3 && volRatio.average > 0) strength *= 0.7;

    strength = Math.min(strength, 1.0);

    const label = strength > 0.7 ? "strong" : strength > 0.4 ? "mid" : "weak";
    const boostStr = boosts.length > 0 ? `+${boosts.join("+")}` : "";
    return { direction: raw.direction, strength, reason: `${raw.direction > 0 ? "bull" : "bear"}-${label}${boostStr}`, rsi, bb };
  }

  _checkModelHealth() {
    if (this.history.length < HEALTH_WINDOW) return true;
    const recent = this.history.slice(0, HEALTH_WINDOW);
    const wr = recent.filter(t => t.pnl >= 0).length / recent.length;
    if (wr < HEALTH_MIN_WINRATE) { this.log("WARN", `Model health: ${(wr * 100).toFixed(0)}% — PAUSING`); return false; }
    return true;
  }

  _estimateProbability(asset, side, marketPrice, secsLeft, totalSecs) {
    const sig = this._getSignal(asset);
    const dir = side === "UP" ? 1 : -1;
    let prob = marketPrice;
    if (sig.direction === dir) prob = Math.min(0.95, marketPrice + sig.strength * 0.15);
    else if (sig.direction !== 0 && sig.direction !== dir) prob = Math.max(0.05, marketPrice - sig.strength * 0.10);
    if (totalSecs > 0) {
      const elapsed = 1 - (secsLeft / totalSecs);
      if (elapsed > 0.6 && marketPrice > 0.7) prob = Math.min(0.95, prob + (elapsed - 0.6) * 0.1);
      else if (elapsed > 0.6 && marketPrice < 0.3) prob = Math.max(0.05, prob - (elapsed - 0.6) * 0.1);
    }
    return prob;
  }

  _kellySize(modelProb, marketPrice) {
    if (modelProb <= marketPrice) return 0;
    const Q = modelProb / (1 - modelProb), P = marketPrice / (1 - marketPrice);
    return Math.max(0, ((Q - P) / (1 + Q)) * KELLY_FRACTION);
  }

  // ═══════════════════════════════════════════════
  //  v9.3: CLOB EXECUTION SIMULATION
  //  Realistic Polymarket execution: spread, slippage, fills
  // ═══════════════════════════════════════════════

  // Simulate buying shares on CLOB
  // ─── ENTRY: Buy shares on CLOB ───────────────────
  // LIVE: Places a real GTC limit order via SDK
  // PAPER: Simulates with spread + slippage estimation
  async _simulateEntry(tokenId, betSize, midPrice) {
    // ═══ LIVE TRADING: Real order ═══
    if (this._liveTading && this._orderClient && this._orderClient.ready) {
      const book = this._orderbooks[tokenId];
      // Use best ask if available, otherwise mid + 0.5 cent
      const askPrice = (book && book.bestAsk > 0) ? book.bestAsk : midPrice + 0.005;
      const result = await this._orderClient.buyShares(tokenId, betSize, askPrice);
      if (result.success) {
        // ═══ VERIFY ORDER ACTUALLY MATCHED ═══
        // Wait 2s then check — don't trust "success" alone
        await new Promise(r => setTimeout(r, 2000));
        const verify = await this._orderClient.verifyOrder(result.orderId);
        if (!verify.matched) {
          this.log("VERIFY-FAIL", `Order placed but NOT matched: ${result.orderId.slice(0, 16)}... status:${verify.status || verify.error} — cancelling`);
          await this._orderClient.cancelOrder(result.orderId);
          this._executionStats.failures++;
          return null;
        }
        this._executionStats.fills++;
        this.log("LIVE-BUY", `VERIFIED ORDER: ${tokenId.slice(0, 12)}... $${betSize} @$${result.execPrice} orderId:${result.orderId.slice(0, 16)}... [MATCHED]`);
        return {
          filled: true,
          execPrice: result.execPrice,
          midPrice,
          slippage: result.execPrice - midPrice,
          spreadCost: 0,
          spread: book ? book.spread : 0,
          askDepth: book ? book.askDepth : 0,
          orderId: result.orderId,
          live: true,
        };
      } else {
        this._executionStats.failures++;
        this.log("LIVE-FAIL", `BUY failed: ${result.error}`);
        return null;
      }
    }

    // ═══ PAPER TRADING: Simulation ═══
    const book = this._orderbooks[tokenId];
    const spread = book ? book.spread : 0.01;
    const askDepth = book ? book.askDepth : 100;

    if (book && book.askDepth === 0 && book.asks && book.asks.length === 0) {
      return null;
    }

    const spreadCost = spread * SPREAD_COST_ENTRY;
    let execPrice = midPrice + spreadCost;

    if (betSize > SIZE_IMPACT_THRESHOLD && askDepth > 0) {
      const excess = betSize - SIZE_IMPACT_THRESHOLD;
      execPrice += excess * SIZE_IMPACT_FACTOR;
    }

    const totalSlippage = execPrice - midPrice;
    this._executionStats.fills++;
    this._executionStats.totalSlippage += totalSlippage;
    this._executionStats.totalSpreadCost += spreadCost;

    return {
      filled: true,
      execPrice: Math.round(execPrice * 10000) / 10000,
      midPrice,
      slippage: Math.round(totalSlippage * 10000) / 10000,
      spreadCost: Math.round(spreadCost * 10000) / 10000,
      spread,
      askDepth,
    };
  }

  // ─── EXIT: Sell shares on CLOB ──────────────────
  // LIVE: Places a real sell order (GTC normal, FOK if urgent/near expiry)
  // PAPER: Simulates with spread + slippage estimation
  async _simulateExit(tokenId, position, midPrice, isForced = false) {
    // ═══ LIVE TRADING: Real order ═══
    if (this._liveTading && this._orderClient && this._orderClient.ready) {
      const secsToEnd = position.endDate ? (position.endDate - Date.now()) / 1000 : 99999;
      const urgent = isForced || secsToEnd < 120; // FOK if < 2 min left or forced
      const book = this._orderbooks[tokenId];
      // Use best bid if available, otherwise mid - 0.5 cent
      const bidPrice = (book && book.bestBid > 0) ? book.bestBid : Math.max(0.01, midPrice - 0.005);
      const shares = Math.floor(position.size * 100) / 100;

      if (shares < 1) {
        // Too few shares to sell — let it resolve
        this.log("LIVE-SKIP", `Can't sell ${shares} shares (min 1) — holding to resolution`);
        return null;
      }

      const result = await this._orderClient.sellShares(tokenId, shares, bidPrice, urgent);
      if (result.success) {
        // ═══ VERIFY SELL ORDER ACTUALLY MATCHED ═══
        await new Promise(r => setTimeout(r, 2000));
        const verify = await this._orderClient.verifyOrder(result.orderId);
        if (!verify.matched) {
          this.log("VERIFY-FAIL", `SELL placed but NOT matched: ${result.orderId.slice(0, 16)}... status:${verify.status || verify.error} — cancelling`);
          await this._orderClient.cancelOrder(result.orderId);
          this._executionStats.failures++;
          return null; // Position stays — will retry next tick
        }
        this._executionStats.fills++;
        this.log("LIVE-SELL", `VERIFIED SELL: ${tokenId.slice(0, 12)}... ${shares} shares @$${result.execPrice} ${urgent ? "FOK" : "GTC"} orderId:${result.orderId.slice(0, 16)}... [MATCHED]`);
        return {
          filled: true,
          execPrice: result.execPrice,
          midPrice,
          slippage: midPrice - result.execPrice,
          spreadCost: 0,
          spread: book ? book.spread : 0,
          bidDepth: book ? book.bidDepth : 0,
          orderId: result.orderId,
          live: true,
        };
      } else {
        this._executionStats.failures++;
        this.log("LIVE-FAIL", `SELL failed: ${result.error} — keeping position, will retry`);
        return null; // Position stays — never fake a fill
      }
    }

    // ═══ PAPER TRADING: Simulation ═══
    const book = this._orderbooks[tokenId];
    const spread = book ? book.spread : 0.01;
    const bidDepth = book ? book.bidDepth : 100;
    const secsToEnd = position.endDate ? (position.endDate - Date.now()) / 1000 : 99999;

    if (book && book.bidDepth === 0 && book.bids && book.bids.length === 0 && !isForced) {
      this._executionStats.failures++;
      return null;
    }

    let effectiveSpread = spread;
    if (secsToEnd < 15) effectiveSpread *= LATE_EXIT_SPREAD_MULT;

    const spreadCost = effectiveSpread * SPREAD_COST_EXIT;
    let execPrice = midPrice - spreadCost;

    const posValue = position.size * midPrice;
    if (posValue > SIZE_IMPACT_THRESHOLD && bidDepth > 0) {
      const excess = posValue - SIZE_IMPACT_THRESHOLD;
      execPrice -= excess * SIZE_IMPACT_FACTOR;
    }

    execPrice = Math.max(0.001, execPrice);

    const totalSlippage = midPrice - execPrice;
    this._executionStats.fills++;
    this._executionStats.totalSlippage += totalSlippage;
    this._executionStats.totalSpreadCost += spreadCost;

    return {
      filled: true,
      execPrice: Math.round(execPrice * 10000) / 10000,
      midPrice,
      slippage: Math.round(totalSlippage * 10000) / 10000,
      spreadCost: Math.round(spreadCost * 10000) / 10000,
      spread: effectiveSpread,
      bidDepth,
    };
  }

  // ═══════════════════════════════════════════════
  //  PROBE / TEST SYSTEM
  //  Like real traders: small bets first to test hypothesis,
  //  then scale up when pattern proves profitable
  // ═══════════════════════════════════════════════

  // Build a pattern key from signal data — groups similar setups
  // v9.1: Simplified key — old keys were too specific (every trade unique, never graduated)
  // Now groups by: asset + side + base signal (bull-strong, bear-mid, etc.)
  _probeKey(asset, side, reason) {
    // Extract base signal: "PRED-bull-strong+BB+CROSS+EARLY+MI[...]" → "bull-strong"
    const match = reason.match(/(bull|bear)-(strong|mid|weak)/);
    const base = match ? match[0] : "unknown";
    const hasPred = reason.includes("PRED") ? "PRED-" : "";
    return `${asset}-${side}-${hasPred}${base}`;
  }

  // Record a trade result for a probe pattern
  _recordProbeResult(patternKey, won) {
    if (!this._probeResults[patternKey]) {
      this._probeResults[patternKey] = { wins: 0, losses: 0, results: [] };
    }
    const p = this._probeResults[patternKey];
    p.results.push(won);
    if (p.results.length > PROBE_WINDOW) p.results.shift();
    if (won) p.wins++; else p.losses++;
  }

  // Get probe track record for a pattern
  _getProbeRecord(patternKey) {
    const p = this._probeResults[patternKey];
    if (!p || p.results.length === 0) return { samples: 0, winRate: 0, recentWR: 0, proven: false };
    const samples = p.results.length;
    const totalWR = p.wins / (p.wins + p.losses);
    const recentWins = p.results.filter(r => r).length;
    const recentWR = recentWins / samples;
    const proven = samples >= PROBE_MIN_SAMPLES && recentWR >= PROBE_WIN_THRESHOLD;
    return { samples, winRate: totalWR, recentWR, proven };
  }

  // v9.1: Global track record across ALL patterns — for fast-track scaling
  _getGlobalTrackRecord() {
    let totalSamples = 0, totalWins = 0;
    for (const p of Object.values(this._probeResults)) {
      totalSamples += p.results.length;
      totalWins += p.results.filter(r => r).length;
    }
    const wr = totalSamples > 0 ? totalWins / totalSamples : 0;
    return { samples: totalSamples, winRate: wr, proven: totalSamples >= GLOBAL_MIN_TRADES && wr >= GLOBAL_MIN_WR };
  }

  // ═══════════════════════════════════════════════
  //  CONVICTION SCORING
  //  Combines ALL data sources into 0-1 conviction score
  //  This is the brain — decides how much to bet
  // ═══════════════════════════════════════════════

  _calculateConviction(asset, side, sig, market, entryPrice, secsLeft) {
    let score = 0;
    let maxScore = 0;
    const factors = [];

    // 1. Signal strength (0-1) — weight: 25%
    maxScore += 25;
    const sigScore = sig.strength * 25;
    score += sigScore;
    if (sig.strength > 0.7) factors.push(`sig:${(sig.strength * 100).toFixed(0)}%`);

    // 2. RSI confirmation — weight: 15%
    maxScore += 15;
    const rsi = this._getRSI(asset);
    const rsiDir = side === "UP" ? 1 : -1;
    if (rsiDir > 0 && rsi > RSI_OB) { score += 15; factors.push("RSI-OB"); }
    else if (rsiDir < 0 && rsi < RSI_OS) { score += 15; factors.push("RSI-OS"); }
    else if (rsiDir > 0 && rsi > 55) { score += 8; }
    else if (rsiDir < 0 && rsi < 45) { score += 8; }
    else if ((rsiDir > 0 && rsi < 35) || (rsiDir < 0 && rsi > 65)) { score += 0; factors.push("RSI-against"); }
    else { score += 5; }

    // 3. Bollinger confirmation — weight: 10%
    maxScore += 10;
    const bb = this._getBollinger(asset);
    if (side === "UP" && bb.position > 0) { score += 10; factors.push("BB-break"); }
    else if (side === "DOWN" && bb.position < 0) { score += 10; factors.push("BB-break"); }
    else if (bb.percentB > 0.3 && bb.percentB < 0.7) { score += 5; }
    else { score += 2; }

    // 4. Cross-asset consensus — weight: 15%
    maxScore += 15;
    const cross = this._getCrossAssetConsensus();
    const crossDir = side === "UP" ? 1 : -1;
    if (cross.consensus === crossDir && cross.agreement >= 0.66) { score += 15; factors.push("CROSS-agree"); }
    else if (cross.consensus === crossDir) { score += 10; }
    else if (cross.consensus === 0) { score += 5; }
    else { score += 0; factors.push("CROSS-disagree"); }

    // 5. Volume confirmation — weight: 10%
    maxScore += 10;
    const volRatio = this._getVolumeRatio(asset);
    if (volRatio.ratio > 2.0 && volRatio.average > 0) { score += 10; factors.push("VOL-surge"); }
    else if (volRatio.ratio > 1.2) { score += 7; }
    else if (volRatio.ratio < 0.3 && volRatio.average > 0) { score += 0; factors.push("VOL-dead"); }
    else { score += 4; }

    // 6. Predictive edge (Binance leads Poly) — weight: 15%
    maxScore += 15;
    const predEdge = this._getPredictiveEdge(asset, side, entryPrice);
    if (predEdge.edge >= 0.05) { score += 15; factors.push(`PRED:${(predEdge.edge * 100).toFixed(0)}%`); }
    else if (predEdge.edge >= PRED_EDGE_MIN) { score += 10; factors.push("PRED-edge"); }
    else if (predEdge.edge >= 0.01) { score += 5; }
    else if (predEdge.edge < 0) { score += 0; factors.push("PRED-against"); }
    else { score += 3; }

    // 7. Probe track record for this pattern — weight: 10%
    maxScore += 10;
    const patternKey = this._probeKey(asset, side, sig.reason);
    const probeRec = this._getProbeRecord(patternKey);
    if (probeRec.samples >= PROBE_MIN_SAMPLES) {
      if (probeRec.recentWR >= 0.80) { score += 10; factors.push(`probed:${(probeRec.recentWR * 100).toFixed(0)}%`); }
      else if (probeRec.recentWR >= 0.70) { score += 8; }
      else if (probeRec.recentWR >= 0.60) { score += 5; }
      else { score += 0; factors.push(`probe-bad:${(probeRec.recentWR * 100).toFixed(0)}%`); }
    } else {
      // Not enough data — neutral, stays at probe level
      score += 2;
      if (probeRec.samples > 0) factors.push(`probing:${probeRec.samples}/${PROBE_MIN_SAMPLES}`);
    }

    const conviction = Math.min(score / maxScore, 1.0);
    return { conviction, factors, patternKey, probeRecord: probeRec };
  }

  // ═══════════════════════════════════════════════
  //  TIERED BET SIZING
  //  Probe ($1) → Scale up with conviction + track record
  // ═══════════════════════════════════════════════

  _calculateBetSize(conviction, probeRecord, bankroll) {
    // v9.2: Pure conviction-driven sizing — no probe gatekeeping
    let tier = BET_TIERS[0];
    for (const t of BET_TIERS) {
      if (conviction >= t.minConv && conviction < t.maxConv) { tier = t; break; }
    }
    if (conviction >= 0.95) tier = BET_TIERS[BET_TIERS.length - 1];

    let betSize;
    if (tier.fixed > 0) {
      betSize = tier.fixed; // PROBE: always $1
    } else {
      // Scale within tier based on where conviction falls in the range
      const range = tier.maxConv - tier.minConv;
      const pos = range > 0 ? (conviction - tier.minConv) / range : 0.5;
      const pctOfBankroll = tier.pctMin + pos * (tier.pctMax - tier.pctMin);
      betSize = bankroll * pctOfBankroll;
    }

    // Floor at $1 (Polymarket minimum), cap at 98% of bankroll
    betSize = Math.max(PROBE_SIZE, Math.min(betSize, bankroll * 0.98));
    // Round to 2 decimals
    betSize = Math.round(betSize * 100) / 100;

    return { betSize, tier: tier.name };
  }

  // ═══════════════════════════════════════════════
  //  MARKET DISCOVERY
  // ═══════════════════════════════════════════════

  async refreshMarkets() {
    if (this._refreshing) return;  // skip if already fetching
    this._refreshing = true;
    try {
      this.log("SCAN", "Fetching crypto markets...");
      const raw = await api.fetchCryptoMarkets();
      if (!raw || raw.length === 0) { this.log("WARN", "No markets — check VPN"); return; }
      this.log("SCAN", `API: ${raw.length} raw markets`);
      const now = Date.now();
      this.markets = [];

      for (const m of raw) {
        const endDate = m.end_date_iso ? new Date(m.end_date_iso).getTime() : m.endDate ? new Date(m.endDate).getTime() : 0;
        const secsLeft = endDate > 0 ? (endDate - now) / 1000 : 999999;
        if (secsLeft < MIN_ENTRY_SECS || m.closed || m.resolved) continue;

        let tokenIds = m.clobTokenIds;
        if (typeof tokenIds === "string") { try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; } }
        const upToken = tokenIds?.[0] || m.tokens?.[0]?.token_id;
        const downToken = tokenIds?.[1] || m.tokens?.[1]?.token_id;
        if (!upToken) continue;

        const q = (m.question || "").toLowerCase();
        const eventSlug = m.events?.[0]?.slug || "";
        const slugLower = eventSlug.toLowerCase();

        // Asset detection — handle both short (btc-) and full (bitcoin-) prefixes
        let asset = null;
        if (slugLower.startsWith("btc-") || slugLower.startsWith("bitcoin-")) asset = "BTC";
        else if (slugLower.startsWith("eth-") || slugLower.startsWith("ethereum-")) asset = "ETH";
        else if (slugLower.startsWith("sol-") || slugLower.startsWith("solana-")) asset = "SOL";
        if (!asset) {
          if (/\bbitcoin\b|\bbtc\b/.test(q)) asset = "BTC";
          else if (/\bethereum\b|\beth\b/.test(q)) asset = "ETH";
          else if (/\bsolana\b|\bsol\b/.test(q)) asset = "SOL";
        }
        if (!asset) continue;

        // Timeframe detection — handle all slug formats:
        //   5m/15m: btc-updown-5m-{ts}
        //   4h:     btc-updown-4h-{ts}
        //   hourly: bitcoin-up-or-down-february-14-3am-et
        //   daily:  bitcoin-up-or-down-on-february-15
        let timeframe = "other";
        if (slugLower.includes("-5m-")) timeframe = "5m";
        else if (slugLower.includes("-15m-")) timeframe = "15m";
        else if (slugLower.includes("-4h-")) timeframe = "4h";
        else if (/\d+(am|pm)-et$/.test(slugLower)) timeframe = "1h";
        else if (/up-or-down-on-/.test(slugLower)) timeframe = "1d";
        if (timeframe === "other") {
          if (/5 ?min/.test(q)) timeframe = "5m";
          else if (/15 ?min/.test(q)) timeframe = "15m";
          else if (/4 ?hour|4h/.test(q)) timeframe = "4h";
          else if (/1 ?hour|hourly|\d+(am|pm)/.test(q)) timeframe = "1h";
          else if (/daily|24h|1 ?day|today|on (january|february|march|april|may|june|july|august|september|october|november|december)/i.test(q)) timeframe = "1d";
        }
        if (!ALLOWED_TF.has(timeframe)) continue;

        const marketSlug = m.slug || m.market_slug || "";
        let polyUrl = "";
        if (eventSlug && marketSlug) polyUrl = `https://polymarket.com/event/${eventSlug}/${marketSlug}`;
        else if (eventSlug) polyUrl = `https://polymarket.com/event/${eventSlug}`;

        let outPrices = m.outcomePrices;
        if (typeof outPrices === "string") { try { outPrices = JSON.parse(outPrices); } catch { outPrices = null; } }
        const gammaUpPrice = outPrices?.[0] ? parseFloat(outPrices[0]) : 0;
        const gammaDownPrice = outPrices?.[1] ? parseFloat(outPrices[1]) : 0;

        if (gammaUpPrice > 0 && upToken) {
          if (!this._priceHistory[upToken]) this._priceHistory[upToken] = [];
          if (this._priceHistory[upToken].length === 0) this._priceHistory[upToken].push({ price: gammaUpPrice, ts: now });
        }
        if (gammaDownPrice > 0 && downToken) {
          if (!this._priceHistory[downToken]) this._priceHistory[downToken] = [];
          if (this._priceHistory[downToken].length === 0) this._priceHistory[downToken].push({ price: gammaDownPrice, ts: now });
        }

        const TF_SECS = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
        this.markets.push({
          conditionId: m.condition_id || m.conditionId, question: m.question, asset, timeframe,
          upToken, downToken, endDate, secsLeft: Math.floor(secsLeft), totalSecs: TF_SECS[timeframe] || 900,
          polyUrl, gammaUpPrice, gammaDownPrice,
        });
      }

      // Sort: 5m first (time-critical latency arb), then 4h, 1h, 1d — closest to expiry first within TF
      this.markets.sort((a, b) => {
        const R = { "5m": 0, "4h": 1, "1h": 2, "1d": 3 };
        const ta = R[a.timeframe] ?? 99, tb = R[b.timeframe] ?? 99;
        return ta !== tb ? ta - tb : a.secsLeft - b.secsLeft;
      });

      this._lastRefresh = Date.now();
      for (const m of this.markets) {
        const yp = m.gammaUpPrice ? `UP$${m.gammaUpPrice.toFixed(2)}` : "";
        const np = m.gammaDownPrice ? `DN$${m.gammaDownPrice.toFixed(2)}` : "";
        this.log("MARKET", `${m.asset} [${m.timeframe}] ${yp} ${np} | ${m.question.slice(0, 45)}`);
      }
      this.log("SCAN", `${this.markets.length} markets ready`);
    } catch (e) {
      this.log("ERROR", `Refresh failed: ${e.message}`);
    } finally {
      this._refreshing = false;
    }
  }

  // ═══════════════════════════════════════════════
  //  MAIN TICK (full — API prices + signals + trade)
  // ═══════════════════════════════════════════════

  async tick() {
    if (!this.running) return;
    if (this._ticking) return;  // skip if previous tick still running
    this._ticking = true;
    if (this.markets.length === 0) { this.log("WAIT", "No markets"); this._ticking = false; return; }
    this._tickCount++;
    this._checkDailyReset();

    try {
      // Sync bankroll with pool balance (picks up new deposits/withdrawals)
      // Only sync when no open positions (during trades, bankroll is managed internally)
      if (this.positions.length === 0) {
        if (supa.isConnected()) {
          const poolBalance = await supa.getPoolBalance();
          if (poolBalance > 0) {
            this.bankroll = poolBalance;
          } else if (this._walletBalance > 0) {
            this.bankroll = this._walletBalance;
          }
        } else if (this._walletBalance > 0) {
          this.bankroll = this._walletBalance;
        }
      }

      // Skip Binance HTTP if we have fresh WS data
      if (!this._liveDataTs || Date.now() - this._liveDataTs > 5000) {
        const realPrices = await api.fetchRealPrices();
        if (Object.keys(realPrices).length > 0) this._updateRealPrices(realPrices);
      }
      this._logSignals();

      const tokenIds = new Set();
      for (const m of this.markets) { if (m.upToken) tokenIds.add(m.upToken); if (m.downToken) tokenIds.add(m.downToken); }
      for (const p of this.positions) tokenIds.add(p.tokenId);
      const tokenArr = [...tokenIds];

      // v9.3: Fetch CLOB live prices + orderbooks (not Gamma cache)
      let prices;
      if (USE_CLOB_PRICES) {
        // Parallel: CLOB midpoints + orderbooks for open positions
        const posTokens = this.positions.map(p => p.tokenId);
        const [clobPrices, books] = await Promise.all([
          api.fetchCLOBPrices(tokenArr),
          posTokens.length > 0 ? api.fetchOrderbooks(posTokens) : Promise.resolve({}),
        ]);
        // Merge: CLOB first, fallback to Gamma
        prices = clobPrices;
        if (Object.keys(prices).length < tokenArr.length / 2) {
          const gammaPrices = await api.fetchPrices(tokenArr);
          for (const [id, p] of Object.entries(gammaPrices)) {
            if (!prices[id]) prices[id] = p;
          }
        }
        // Store orderbooks for execution simulation
        Object.assign(this._orderbooks, books);
        // Also fetch books for tokens we might enter
        const entryTokens = tokenArr.filter(t => !posTokens.includes(t)).slice(0, 8);
        if (entryTokens.length > 0) {
          const entryBooks = await api.fetchOrderbooks(entryTokens);
          Object.assign(this._orderbooks, entryBooks);
        }
      } else {
        prices = await api.fetchPrices(tokenArr);
      }
      if (Object.keys(prices).length === 0) { this.log("WARN", "No Polymarket prices"); return; }
      this._updatePolyPrices(prices);
      this._checkArbitrage(prices);

      const closed = await this._managePositions(prices);
      const opened = await this._scanEntries(prices);
      // Auto-enter daily/hourly market if no position exists
      const autoOpened = await this._autoEntryDaily();
      const unreal = this.positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
      const locked = this.positions.reduce((s, p) => s + (p.costBasis || PROBE_SIZE), 0);
      this.log("TICK", `#${this._tickCount} | bank:$${this.bankroll.toFixed(2)} locked:$${locked.toFixed(2)} | ${this.positions.length} open | +${opened + autoOpened}/-${closed} | P&L $${(this.totalPnl + unreal).toFixed(2)}`);
      await this.save();
    } catch (e) {
      this.log("ERROR", `Tick: ${e.message}`);
    } finally {
      this._ticking = false;
    }
  }

  // ═══════════════════════════════════════════════
  //  FAST TICK (live data — no API calls, every 1-2s)
  // ═══════════════════════════════════════════════

  async fastTick() {
    if (!this.running || this.markets.length === 0) return;
    if (this._ticking) return; // Block if tick() is running — prevents race condition
    this._ticking = true;
    this._tickCount++;
    this._checkDailyReset();

    const now = Date.now();
    const clobLive = this._clobLiveTs > 0 && now - this._clobLiveTs < 5000;

    // Build price map — prefer live CLOB prices (100ms) over stale Gamma cache (15s)
    const prices = {};
    for (const m of this.markets) {
      if (m.upToken && m.gammaUpPrice > 0) prices[m.upToken] = m.gammaUpPrice;
      if (m.downToken && m.gammaDownPrice > 0) prices[m.downToken] = m.gammaDownPrice;
    }
    // Override with latest from price history (CLOB WS writes here in real-time)
    for (const [tokenId, hist] of Object.entries(this._priceHistory)) {
      if (hist.length > 0) prices[tokenId] = hist[hist.length - 1].price;
    }
    if (Object.keys(prices).length === 0) return;

    if (!this._lastSignalLog || now - this._lastSignalLog > 10000) {
      this._logSignals();
      this._lastSignalLog = now;
    }

    this._checkArbitrage(prices);
    const closed = await this._managePositions(prices);
    const opened = await this._scanEntries(prices);
    // Auto-enter daily/hourly market if no position exists
    const autoOpened = await this._autoEntryDaily();

    if (!this._lastSave || now - this._lastSave > 2000) {
      const unreal = this.positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
      const locked = this.positions.reduce((s, p) => s + (p.costBasis || PROBE_SIZE), 0);
      const src = clobLive ? "CLOB" : this._liveDataTs && now - this._liveDataTs < 3000 ? "LIVE" : "API";
      this.log("TICK", `#${this._tickCount} ${src} | bank:$${this.bankroll.toFixed(2)} locked:$${locked.toFixed(2)} | ${this.positions.length} open | +${opened + autoOpened}/-${closed} | P&L $${(this.totalPnl + unreal).toFixed(2)}`);
      await this.save();
      this._lastSave = now;
    }
    this._ticking = false; // Release lock
  }

  _logSignals() {
    for (const asset of ["BTC", "ETH", "SOL"]) {
      const hist = this._realPrices[asset];
      if (!hist || hist.length === 0) continue;
      const sig = this._getSignal(asset);
      const vol = this._getVolatility(asset);
      if (sig.direction !== 0) {
        this.log("SIGNAL", `${asset} $${hist[hist.length - 1].price.toFixed(0)} → ${sig.reason} (${(sig.strength * 100).toFixed(0)}%) RSI:${this._getRSI(asset).toFixed(0)} vol:${vol.regime}`);
      }
    }
  }

  _checkArbitrage(prices) {
    for (const m of this.markets) {
      const yp = prices[m.upToken] || m.gammaUpPrice;
      const np = prices[m.downToken] || m.gammaDownPrice;
      if (!yp || !np) continue;
      if (yp + np < ARB_THRESHOLD) {
        this.log("ARB", `${m.asset} [${m.timeframe}] UP+DN=$${(yp + np).toFixed(3)} → +$${(1 - yp - np).toFixed(3)} free`);
      }
    }
  }

  _updatePolyPrices(prices) {
    const now = Date.now();
    for (const [tokenId, price] of Object.entries(prices)) {
      if (!this._priceHistory[tokenId]) this._priceHistory[tokenId] = [];
      const hist = this._priceHistory[tokenId];
      hist.push({ price, ts: now });
      if (hist.length > 20) hist.splice(0, hist.length - 20);
    }
    for (const tokenId of Object.keys(this._priceHistory)) {
      const hist = this._priceHistory[tokenId];
      if (hist.length > 0 && now - hist[hist.length - 1].ts > DEFAULT_STALE) delete this._priceHistory[tokenId];
    }
  }

  // ═══════════════════════════════════════════════
  //  POSITION MANAGEMENT
  // ═══════════════════════════════════════════════

  // v9.5: Predictive edge — multi-exchange median predicts Chainlink resolution
  // KEY INSIGHT: Chainlink Data Streams aggregates from 16 oracle nodes, each pulling
  // from premium data aggregators that themselves aggregate exchange prices.
  // Our median of Binance+Coinbase+Kraken ≈ where Chainlink will resolve.
  // The RTDS relay has ~27s lag, so we see the resolution price before Polymarket updates.
  _getPredictiveEdge(asset, side, currentPolyPrice) {
    const sig = this._getSignalRaw(asset);
    if (sig.direction === 0) return { edge: 0, catching_up: false, source: "none" };

    // v9.5: Use multi-exchange predicted Chainlink price if available
    const predicted = this._getPredictedChainlink(asset);
    const chainlinkNow = this._getChainlinkPrice(asset);

    if (predicted && chainlinkNow) {
      const signalFavors = sig.direction > 0 ? "UP" : "DOWN";
      // How far our predicted price diverges from the stale Chainlink price
      const predDiv = (predicted - chainlinkNow) / chainlinkNow;
      const predBullish = predDiv > 0;
      const predStrength = Math.abs(predDiv);
      const lagSecs = this._getChainlinkLagSecs(asset);

      // Edge = signal strength + multi-exchange divergence confirmation
      let impliedProb = 0.50 + sig.strength * 0.20;

      // Multi-exchange median is more reliable than Binance alone
      // 3 exchanges agreeing on direction = stronger conviction
      const lagFactor = Math.min(lagSecs / 30, 1.5);
      const exchangeBoost = 1.3; // 30% boost for multi-exchange vs single

      if ((signalFavors === "UP" && predBullish) || (signalFavors === "DOWN" && !predBullish)) {
        const boost = Math.min(predStrength * 5 * lagFactor * exchangeBoost, 0.25);
        impliedProb += boost;
      } else if (predStrength > 0.001) {
        impliedProb -= Math.min(predStrength * 3, 0.10);
      }

      impliedProb = Math.max(0.30, Math.min(0.95, impliedProb));

      if (signalFavors === side) {
        const edge = impliedProb - currentPolyPrice;
        return { edge, catching_up: edge < PRED_CATCH_UP, source: "multi-exchange", divergence: predDiv, lagSecs };
      } else {
        const edge = currentPolyPrice - (1 - impliedProb);
        return { edge: -Math.abs(edge), catching_up: false, source: "multi-exchange", divergence: predDiv, lagSecs };
      }
    }

    // Fallback: Binance vs Chainlink divergence (no multi-exchange data)
    const div = this._getPriceDivergence(asset);
    if (div) {
      const signalFavors = sig.direction > 0 ? "UP" : "DOWN";
      const binanceBullish = div.pct > 0;
      const divergenceStrength = Math.abs(div.pct);
      const lagSecs = this._getChainlinkLagSecs(asset);

      let impliedProb = 0.50 + sig.strength * 0.20;
      const lagFactor = Math.min(lagSecs / 30, 1.5);

      if ((signalFavors === "UP" && binanceBullish) || (signalFavors === "DOWN" && !binanceBullish)) {
        const boost = Math.min(divergenceStrength * 5 * lagFactor, 0.20);
        impliedProb += boost;
      } else if (divergenceStrength > 0.001) {
        impliedProb -= Math.min(divergenceStrength * 3, 0.10);
      }

      impliedProb = Math.max(0.30, Math.min(0.95, impliedProb));

      if (signalFavors === side) {
        const edge = impliedProb - currentPolyPrice;
        return { edge, catching_up: edge < PRED_CATCH_UP, source: "chainlink", divergence: div.pct, lagSecs };
      } else {
        const edge = currentPolyPrice - (1 - impliedProb);
        return { edge: -Math.abs(edge), catching_up: false, source: "chainlink", divergence: div.pct, lagSecs };
      }
    }

    // Last fallback: Binance-only signal
    const signalFavors = sig.direction > 0 ? "UP" : "DOWN";
    const impliedProb = 0.50 + sig.strength * 0.25;

    if (signalFavors === side) {
      const edge = impliedProb - currentPolyPrice;
      return { edge, catching_up: edge < PRED_CATCH_UP, source: "binance" };
    } else {
      const edge = currentPolyPrice - (1 - impliedProb);
      return { edge: -Math.abs(edge), catching_up: false, source: "binance" };
    }
  }

  async _managePositions(prices) {
    const toClose = [];
    const now = Date.now();

    for (let i = this.positions.length - 1; i >= 0; i--) {
      const pos = this.positions[i];
      const cp = prices[pos.tokenId];
      if (!cp) continue;
      pos.currentPrice = cp; // Update BEFORE probability calc so it uses latest CLOB price
      const unrealized = (cp - pos.entryPrice) * pos.size;
      if (!pos.peakGain || unrealized > pos.peakGain) pos.peakGain = unrealized;
      const secsToEnd = pos.endDate ? (pos.endDate - now) / 1000 : 99999;
      const tf = pos.timeframe || "5m";
      const holdAge = (now - pos.openedAt) / 1000;
      const isLongTF = (tf === "1d" || tf === "4h" || tf === "1h");

      // PRICE SUPPORT: blends live token price (=market probability) + crypto price (Black-Scholes)
      const support = this._getPriceSupport(pos);
      const canHoldDips = HOLD_THROUGH_DIPS[tf] || false;

      // ── MARKET RESOLUTION — position expired, resolve based on crypto price ──
      if (pos.endDate && secsToEnd <= 0) {
        const resolved = support.supports && support.probability > 0.50;
        const resolvePrice = resolved ? 0.95 : 0.05;
        const pnl = (resolvePrice - pos.entryPrice) * pos.size;
        this.log("RESOLVE", `${pos.asset} ${pos.side} [${tf}] RESOLVED ${resolved ? "WIN" : "LOSS"} — crypto prob=${(support.probability * 100).toFixed(0)}% → $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
        toClose.push({ index: i, reason: resolved ? "WIN-RESOLVE" : "LOSS-RESOLVE", exitPrice: resolvePrice, pnl });
        continue;
      }

      // ── SIGMA-BASED EXIT INTELLIGENCE ──
      // Real math: how many standard deviations does crypto need to move for us to win?
      // BTC annualized vol ~50%. In 15min, 1-sigma ≈ 0.21% ≈ $141 at $67k
      // If crypto needs to move 14 sigmas in 15 min → mathematically impossible → sell NOW
      const minsLeft = secsToEnd / 60;
      const sigma = ANNUAL_VOL[pos.asset] || 0.50;
      const T = Math.max(secsToEnd, 1) / (365.25 * 24 * 3600);
      const oneSigmaMove = (support.cryptoNow || 0) * sigma * Math.sqrt(T);
      const sigmasNeeded = oneSigmaMove > 0 && support.distance > 0 && !support.directionMatch
        ? support.distance / oneSigmaMove : 0;

      const forceExit = FORCE_EXIT_BY_TF[tf] || 30;

      // ═══ 5M HOLD-TO-RESOLUTION: Don't exit, let Chainlink settle it ═══
      // On 5m markets, resolution happens in minutes. Hold when:
      // 1. Our token is winning (>55¢) → token resolves to $1 = max profit
      // 2. Our token is dead (<10¢) → no buyers, accept resolution to $0
      // Only exit if clearly losing AND there's still time + liquidity to sell
      if (tf === "5m" && secsToEnd > 0 && secsToEnd < 120) {
        if (cp > 0.55) {
          // Winning — hold for $1 resolution
          if (!pos._5mHoldLogged || now - pos._5mHoldLogged > 15000) {
            this.log("5M-HOLD", `${pos.asset} ${pos.side} [5m] token:$${cp.toFixed(3)} prob=${(support.probability * 100).toFixed(0)}% | ${secsToEnd.toFixed(0)}s left → HOLDING TO $1 RESOLUTION`);
            pos._5mHoldLogged = now;
          }
          pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
          continue;
        }
        if (cp < 0.10) {
          // Dead — no buyers, hold for resolution (accept $0)
          if (!pos._5mDeadLogged || now - pos._5mDeadLogged > 15000) {
            this.log("5M-DEAD", `${pos.asset} ${pos.side} [5m] token:$${cp.toFixed(3)} → holding to resolution (no buyers)`);
            pos._5mDeadLogged = now;
          }
          pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
          continue;
        }
        // In between (10¢-55¢) with <120s: let normal exit logic decide
      }

      // ── FORCE EXIT ZONE (< 30s for short TF, < 300s for 1d) ──
      if (secsToEnd < forceExit && secsToEnd > 0) {
        if ((isLongTF || tf === "5m") && support.supports && support.probability > 0.55) {
          // Winning — hold to resolution for $1
          if (!pos._resolveLogged || now - pos._resolveLogged > 60000) {
            this.log("RESOLVE-HOLD", `${pos.asset} ${pos.side} [${tf}] holding to resolution — prob=${(support.probability * 100).toFixed(0)}%`);
            pos._resolveLogged = now;
          }
          pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
          continue;
        }
        // Token < 3¢ = no buyers exist, FAK guaranteed fail → accept resolution
        if (isLongTF && cp < 0.03) {
          pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
          continue;
        }
        const slippage = Math.abs(unrealized) * SLIPPAGE_PENALTY;
        toClose.push({ index: i, reason: "LIQ-FORCE", exitPrice: cp, pnl: unrealized - slippage });
        continue;
      }

      // ── SMART SALVAGE: Sell EARLY while liquidity exists ──
      // Don't wait until 30s left when FAK will fail. Sell at 60-90 min out
      // if the math says recovery is impossible (>3 sigma needed)
      if (isLongTF && unrealized <= 0 && sigmasNeeded > 0) {
        // >4 sigma needed + <60 min = mathematically impossible, sell NOW
        if (sigmasNeeded > 4 && minsLeft < 60 && cp > 0.03) {
          this.log("SALVAGE", `${pos.asset} ${pos.side} [${tf}] need ${sigmasNeeded.toFixed(1)}σ in ${minsLeft.toFixed(0)}min (impossible) — salvaging $${(cp * pos.size).toFixed(2)} while buyers exist`);
          toClose.push({ index: i, reason: "SALVAGE-SIGMA", exitPrice: cp, pnl: unrealized });
          continue;
        }
        // >3 sigma needed + <30 min = extremely unlikely, sell
        if (sigmasNeeded > 3 && minsLeft < 30 && cp > 0.03) {
          this.log("SALVAGE", `${pos.asset} ${pos.side} [${tf}] need ${sigmasNeeded.toFixed(1)}σ in ${minsLeft.toFixed(0)}min — salvaging $${(cp * pos.size).toFixed(2)}`);
          toClose.push({ index: i, reason: "SALVAGE-SIGMA", exitPrice: cp, pnl: unrealized });
          continue;
        }
        // >2 sigma + <15 min + token still worth something → last chance to sell
        if (sigmasNeeded > 2 && minsLeft < 15 && cp > 0.05) {
          this.log("SALVAGE", `${pos.asset} ${pos.side} [${tf}] ${sigmasNeeded.toFixed(1)}σ+${minsLeft.toFixed(0)}min — last-chance salvage $${(cp * pos.size).toFixed(2)}`);
          toClose.push({ index: i, reason: "SALVAGE-LAST", exitPrice: cp, pnl: unrealized });
          continue;
        }
        // Token < 3¢ = already dead, no buyers, just hold for resolution
        if (cp < 0.03) {
          pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
          continue;
        }
      }

      // ── LONG-TF PROFITABLE NEAR EXPIRY ──
      if (isLongTF && secsToEnd > 0 && unrealized > 0) {
        const liqExit = LIQUIDITY_EXIT_BY_TF[tf] || 60;
        if (secsToEnd < liqExit && support.supports && support.probability > 0.75) {
          // Strong support — hold for $1 resolution
          pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
          continue;
        }
        if (secsToEnd < liqExit) {
          toClose.push({ index: i, reason: "LIQ-SAFE", exitPrice: cp, pnl: unrealized });
          continue;
        }
      }

      // ── LONG-TF HOLD GATE: never sell at a loss mid-market ──
      if (isLongTF && unrealized <= 0) {
        // If winning is mathematically hopeless (prob < 10%) but lots of time left,
        // still hold — Black-Scholes may underestimate tail moves
        if (!pos._holdLogged || now - pos._holdLogged > 120000) {
          const hoursLeft = secsToEnd / 3600;
          const sigmaStr = sigmasNeeded > 0 ? ` need:${sigmasNeeded.toFixed(1)}σ` : "";
          this.log("HOLD", `${pos.asset} ${pos.side} [${tf}] down $${Math.abs(unrealized).toFixed(2)} | ${hoursLeft.toFixed(1)}h left | prob=${(support.probability * 100).toFixed(0)}%${sigmaStr}`);
          pos._holdLogged = now;
        }
        pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
        continue;
      }

      // ═══ 1D DIAMOND HANDS: Hold to resolution or 45%+ profit ═══
      // Only 2 exits allowed on daily markets:
      //   1. PROFIT: 45%+ gain → take profit
      //   2. DEAD:   our token drops to $0.02 (other side at 98¢+) → cut losses
      // Everything else → HOLD to resolution. No panic selling.
      if (tf === "1d") {
        const pctGain = unrealized / (pos.costBasis || 1);
        // EXIT 1: Profit target — 45%+ gain
        if (pctGain >= 0.45) {
          toClose.push({ index: i, reason: "PROFIT-1D-45%", exitPrice: cp, pnl: unrealized });
          continue;
        }
        // EXIT 2: Our side is dead — token at $0.02 or less (other side 98¢+)
        if (cp <= 0.02) {
          toClose.push({ index: i, reason: "DEAD-1D-2¢", exitPrice: cp, pnl: unrealized });
          continue;
        }
        // OTHERWISE: HOLD — log status every 60s
        if (!pos._statusLogged || now - pos._statusLogged > 60000) {
          const hoursLeft = secsToEnd / 3600;
          const pnlStr = unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized).toFixed(2)}`;
          const pctStr = (pctGain * 100).toFixed(1);
          const probStr = support.probability ? `${(support.probability * 100).toFixed(0)}%` : "??";
          const cryptoStr = support.cryptoNow ? `${support.cryptoNow.toFixed(0)}` : "";
          this.log("DIAMOND", `${pos.asset} ${pos.side} [1d] ${pnlStr} (${pctStr}%) | token:$${cp.toFixed(3)} | crypto:$${cryptoStr} | prob:${probStr} | ${hoursLeft.toFixed(1)}h left | HOLDING TO RESOLUTION`);
          pos._statusLogged = now;
        }
        pos.unrealizedPnl = unrealized; pos.currentPrice = cp;
        if (unrealized > pos.peakGain) pos.peakGain = unrealized;
        continue; // SKIP all other exit logic — hold to resolution
      }

      // ── PREDICTIVE EXIT: Polymarket caught up to Binance ──
      const predEdge = this._getPredictiveEdge(pos.asset, pos.side, cp);
      if (pos.entryReason && pos.entryReason.includes("PRED") && predEdge.catching_up && unrealized > 0) {
        toClose.push({ index: i, reason: "PRED-EXIT", exitPrice: cp, pnl: unrealized });
        continue;
      }

      // ── v9: MARKET INTELLIGENCE EXIT ANALYSIS ──
      const miExit = this._mi.analyzeExit(
        pos.asset, pos.side, pos.entryPrice, cp,
        pos.peakGain, unrealized, this._realPrices[pos.asset]
      );

      // v10: On longer timeframes, MI force-exit is overridden if crypto price strongly supports us
      // If BTC is $300+ in our direction, don't let MI exhaustion/regime triggers force us out
      if (miExit.exitNow && unrealized !== 0) {
        // Chart pattern exit signal takes priority — patterns see what indicators miss
        const isChartExit = miExit.reason && miExit.reason.startsWith("chart-exit:");
        if (isChartExit && miExit.chart && miExit.chart.confidence > 0.6) {
          // Strong chart reversal pattern (H&S, double top, etc.) — respect it even with crypto support
          this.log("CHART-EXIT", `${pos.asset} ${pos.side} [${tf}] ${miExit.reason} conf=${(miExit.chart.confidence * 100).toFixed(0)}% — pattern overrides crypto support`);
          toClose.push({ index: i, reason: miExit.reason, exitPrice: cp, pnl: unrealized });
          continue;
        }
        if (canHoldDips && support.supports && support.probability > 0.65) {
          // Crypto price strongly supports us — override MI exit, just log it
          if (!pos._miOverrideLogged || now - pos._miOverrideLogged > 30000) {
            this.log("HOLD", `${pos.asset} ${pos.side} [${tf}] MI says exit (${miExit.reason}) but crypto supports us: prob=${(support.probability * 100).toFixed(0)}% dist=$${support.distance.toFixed(0)} — HOLDING`);
            pos._miOverrideLogged = now;
          }
        } else {
          toClose.push({ index: i, reason: `MI-${miExit.reason}`, exitPrice: cp, pnl: unrealized });
          continue;
        }
      }

      // ── CHART PATTERN HOLD: continuation pattern detected → let it run ──
      if (miExit.chart && miExit.chart.holdSignal && unrealized > 0 && miExit.chart.confidence > 0.45) {
        // Chart says hold — flag/channel/breakout in our direction
        if (!pos._chartHoldLogged || now - pos._chartHoldLogged > 60000) {
          const patternNames = miExit.chart.patterns.map(p => p.name).join(",");
          this.log("CHART-HOLD", `${pos.asset} ${pos.side} [${tf}] patterns=[${patternNames}] conf=${(miExit.chart.confidence * 100).toFixed(0)}% — holding for more upside`);
          pos._chartHoldLogged = now;
        }
      }

      // ── v10: TIMEFRAME-ADAPTIVE PROFIT TARGET ──
      const tfTargetPct = PROFIT_TARGET_BY_TF[tf] || 0.08;
      const targetProfit = pos.targetProfit || (pos.costBasis * tfTargetPct);
      if (unrealized >= targetProfit) {
        // Chart continuation pattern (flag, channel, breakout) → let it run
        const chartHold = miExit.chart && miExit.chart.holdSignal && miExit.chart.confidence > 0.45;
        // On long-TF with strong support or chart continuation, let profits run
        if (isLongTF && (chartHold || (support.probability > 0.70 && unrealized < targetProfit * 2.5))) {
          if (!pos._runLogged || now - pos._runLogged > 60000) {
            const chartInfo = chartHold ? ` chart:${miExit.chart.reason}` : "";
            this.log("RUN", `${pos.asset} ${pos.side} [${tf}] profit $${unrealized.toFixed(2)} at target but prob=${(support.probability * 100).toFixed(0)}%${chartInfo} — letting it run`);
            pos._runLogged = now;
          }
        } else {
          toClose.push({ index: i, reason: "PROFIT", exitPrice: cp, pnl: unrealized });
          continue;
        }
      }

      // ── v10: TIMEFRAME-ADAPTIVE TRAILING STOP ──
      const trailLock = TRAILING_LOCK_BY_TF[tf] || 0.45;
      if (pos.peakGain > 0.015 && unrealized < pos.peakGain * trailLock) {
        // Chart continuation pattern → widen trailing stop, let it breathe
        const chartContinuation = miExit.chart && miExit.chart.holdSignal && miExit.chart.confidence > 0.45;
        // v10: On longer timeframes, check if crypto still supports us before trailing out
        if (canHoldDips && (chartContinuation || (support.supports && support.probability > 0.60))) {
          // Crypto or chart supports us — widen the emergency stop for longer TF
          const emergencyLock = (tf === "1d" || tf === "4h") ? 0.05 : 0.10;
          if (unrealized < pos.peakGain * emergencyLock) {
            toClose.push({ index: i, reason: "TRAIL-WIDE", exitPrice: cp, pnl: unrealized });
            continue;
          }
          // Hold through — healthy retracement on supported position
        } else if (miExit.holdThrough) {
          if (unrealized < pos.peakGain * 0.1) {
            toClose.push({ index: i, reason: "TRAIL-WIDE", exitPrice: cp, pnl: unrealized });
            continue;
          }
        } else {
          toClose.push({ index: i, reason: "TRAIL", exitPrice: cp, pnl: unrealized });
          continue;
        }
      }

      // ── v10: FLIP SIGNAL — timeframe-aware ──
      const sig = this._getSignal(pos.asset);
      const rev = (pos.side === "UP" && sig.direction < 0 && sig.strength > 0.6) || (pos.side === "DOWN" && sig.direction > 0 && sig.strength > 0.6);
      // On daily markets, don't flip based on short-term momentum — it's noise
      const flipMinAge = tf === "1d" ? 300 : tf === "4h" ? 180 : tf === "1h" ? 120 : 30;
      if (rev && unrealized < 0.005 && holdAge > flipMinAge) {
        // v10: On longer TF, only flip if crypto price also confirms the reversal
        if (canHoldDips && support.supports) {
          // Momentum says flip but crypto still supports us — ignore the flip signal
        } else {
          toClose.push({ index: i, reason: "FLIP", exitPrice: cp, pnl: unrealized });
          continue;
        }
      }

      // ── v10: STOP LOSS — only for short timeframes ──
      // Long TF (1h/4h/1d) losses are already handled by the NEVER-SELL-AT-LOSS gate above
      {
        // SHORT TF (5m/15m): Classic adaptive stop loss
        const baseStop = STOP_LOSS_BY_TF[tf] || 0.15;
        let effectiveStop = baseStop;
        if (support.supports && support.probability > 0.70) {
          effectiveStop = baseStop * 1.5;
        } else if (!support.supports && support.probability < 0.40) {
          effectiveStop = baseStop * 0.7;
        }

        if (cp < pos.entryPrice * (1 - effectiveStop)) {
          if (canHoldDips && support.directionMatch) {
            if (!pos._latencyHoldTs) {
              pos._latencyHoldTs = now;
              this.log("HOLD", `${pos.asset} ${pos.side} [${tf}] stop triggered but Binance supports us (prob=${(support.probability * 100).toFixed(0)}%) — waiting ${LATENCY_DELAY_MS / 1000}s for CLOB catch-up`);
            } else if (now - pos._latencyHoldTs > LATENCY_DELAY_MS) {
              pos._latencyHoldTs = null;
              toClose.push({ index: i, reason: "STOP", exitPrice: cp, pnl: unrealized });
              continue;
            }
          } else {
            toClose.push({ index: i, reason: "STOP", exitPrice: cp, pnl: unrealized });
            continue;
          }
        } else {
          if (pos._latencyHoldTs) pos._latencyHoldTs = null;
        }
      }

      // Stale position check — but NOT on long-TF (those are meant to be held)
      if (!isLongTF) {
        const staleMs = STALE_BY_TF[tf] || DEFAULT_STALE;
        if (now - pos.openedAt > staleMs && Math.abs(unrealized) < 0.005) { toClose.push({ index: i, reason: "STALE", exitPrice: cp, pnl: unrealized }); continue; }
      }

      pos.unrealizedPnl = unrealized; pos.currentPrice = cp;

      // ── PERIODIC STATUS LOG (every 60s) — so dashboard shows activity ──
      if (!pos._statusLogged || now - pos._statusLogged > 60000) {
        const hoursLeft = secsToEnd / 3600;
        const pnlStr = unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized).toFixed(2)}`;
        const pctStr = ((unrealized / (pos.costBasis || 1)) * 100).toFixed(1);
        const probStr = support.probability ? `${(support.probability * 100).toFixed(0)}%` : "??";
        const cryptoStr = support.cryptoNow ? `$${support.cryptoNow.toFixed(0)}` : "";
        this.log("STATUS", `${pos.asset} ${pos.side} [${tf}] ${pnlStr} (${pctStr}%) | token:$${cp.toFixed(3)} | crypto:${cryptoStr} | prob:${probStr} | ${hoursLeft.toFixed(1)}h left`);
        pos._statusLogged = now;
        // Update live price in Supabase for dashboard
        if (pos.poolTradeId && supa.isConnected()) {
          supa.updatePoolTradePrice(pos.poolTradeId, cp).catch(() => {});
        }
      }
    }

    let closed = 0;
    for (const c of toClose.sort((a, b) => b.index - a.index)) {
      const pos = this.positions.splice(c.index, 1)[0];
      const isForced = c.reason === "LIQ-FORCE" || c.reason === "STOP" || c.reason === "WIN-RESOLVE" || c.reason === "LOSS-RESOLVE";

      // v9.3: Simulate real CLOB exit execution
      const exitSim = await this._simulateExit(pos.tokenId, pos, c.exitPrice, isForced);
      if (!exitSim && !isForced) {
        // FAK failure — put position back, retry next tick
        this.positions.splice(c.index, 0, pos);
        this._executionStats.failures++;
        this.log("FAK-FAIL", `Exit failed: ${pos.asset} ${pos.side} [${pos.timeframe}] — retrying next tick`);
        continue;
      }

      // Use simulated execution price (with spread + slippage) or forced mid-price
      const realExitPrice = exitSim ? exitSim.execPrice : c.exitPrice;
      const pnl = (realExitPrice - pos.entryPrice) * pos.size;
      const slippageCost = exitSim ? exitSim.slippage * pos.size : 0;

      this.totalPnl += pnl; this._dailyPnl += pnl;
      this.bankroll += (pos.costBasis || PROBE_SIZE) + pnl;
      this._kellyWealth += pnl >= 0 ? Math.log(1 + Math.abs(pnl)) : -Math.log(1 + Math.abs(pnl));
      // W/L: Only count real outcomes — flips, scratches, and tiny exits are NOT losses
      // $0.05 threshold = meaningful outcome, not just spread cost or repositioning
      if (pnl > 0.05) this.wins++;
      else if (pnl < -0.05) this.losses++;
      closed++;

      if (pos.patternKey) {
        this._recordProbeResult(pos.patternKey, pnl >= 0);
      }

      // v9: Record exit for flip cooldown
      this._mi.recordExit(pos.conditionId);

      const tierStr = pos.betTier ? ` [${pos.betTier}]` : "";
      const convStr = pos.conviction ? ` conv:${(pos.conviction * 100).toFixed(0)}%` : "";
      const slipStr = exitSim ? ` slip:$${slippageCost.toFixed(3)} spr:${(exitSim.spread * 100).toFixed(1)}c` : "";
      this.log("EXIT", `${c.reason}: ${pos.asset} ${pos.side} ${pos.timeframe}${tierStr} $${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}${convStr}${slipStr} | bank:$${this.bankroll.toFixed(2)}`);
      this.history.unshift({ ...pos, exitPrice: realExitPrice, pnl, reason: c.reason, closedAt: Date.now(), slippage: slippageCost });

      // ═══ POOL SYNC: Distribute P&L to users ═══
      if (pos.poolTradeId && supa.isConnected()) {
        try {
          await supa.distributeTradePnl(pos.poolTradeId, realExitPrice, pnl, c.reason);
          this.log("POOL", `Distributed $${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} to users for pool trade ${pos.poolTradeId.slice(0, 8)}`);
        } catch (e) { this.log("WARN", `Pool distribute failed: ${e.message}`); }
      }
    }
    return closed;
  }

  // ═══════════════════════════════════════════════
  //  ENTRY SCANNER
  // ═══════════════════════════════════════════════

  async _scanEntries(prices) {
    if (this.positions.length >= MAX_POSITIONS) return 0;
    if (this.bankroll < PROBE_SIZE) {
      if (this._tickCount % 5 === 0) this.log("WARN", `Bankroll $${this.bankroll.toFixed(2)} < $${PROBE_SIZE.toFixed(2)} — can't trade`);
      return 0;
    }
    if (this._dailyPnl <= -DAILY_LOSS_LIMIT) return 0;
    if (!this._checkModelHealth()) return 0;

    // ═══ ENTRY LOCK — prevents double-entry bug ═══
    const now = Date.now();
    if (this._lastEntryTime && (now - this._lastEntryTime) < ENTRY_LOCK_MS) {
      return 0; // Still in cooldown from last entry
    }

    let opened = 0;

    for (const market of this.markets) {
      if (this.positions.length >= MAX_POSITIONS) break;
      if (this.bankroll < PROBE_SIZE) break;

      // ═══ HARD FILTER: BTC ONLY ═══
      if (ONLY_BTC && market.asset !== "BTC") {
        continue; // SKIP all non-BTC markets
      }

      const secsLeft = market.endDate ? (market.endDate - now) / 1000 : 99999;
      if (secsLeft < MIN_ENTRY_SECS) continue;
      const entryBuffer = ENTRY_BUFFER_BY_TF[market.timeframe] || 90;
      if (secsLeft < entryBuffer) continue;
      if (this.positions.find(p => p.conditionId === market.conditionId)) continue;
      // Already have position on this asset+timeframe
      if (this.positions.find(p => p.asset === market.asset && p.timeframe === market.timeframe)) continue;

      const upPrice = prices[market.upToken] || market.gammaUpPrice;
      const downPrice = prices[market.downToken] || market.gammaDownPrice;
      if (!upPrice) continue;

      const sig = this._getSignal(market.asset);
      const tf = market.timeframe;

      let side = null, tokenId = null, entryPrice = 0, reason = "";

      // ── PREDICTIVE ENTRY: Binance leads Polymarket ──
      // On 5m: This IS the primary strategy (latency arb). Lower threshold, higher aggression.
      // Bot sees BTC move on Binance → buys correct side before Polymarket adjusts (30-90s lag)
      // GTC maker order = 0% fee. Hold to resolution → Chainlink settles based on real price.
      {
        const predMinStrength = tf === "5m" ? 0.35 : 0.4;
        const predMinEdge = tf === "5m" ? 0.02 : PRED_EDGE_MIN; // 2% edge for 5m (0% fees), 3% for others
        if (sig.direction !== 0 && sig.strength > predMinStrength) {
          const favSide = sig.direction > 0 ? "UP" : "DOWN";
          const favPrice = favSide === "UP" ? upPrice : (downPrice || 0);
          const favToken = favSide === "UP" ? market.upToken : market.downToken;

          if (favPrice > 0 && favPrice >= ENTRY_MIN && favPrice <= ENTRY_MAX) {
            const impliedProb = 0.50 + sig.strength * 0.25;
            const edge = impliedProb - favPrice;
            if (edge >= predMinEdge) {
              side = favSide; tokenId = favToken; entryPrice = favPrice;
              reason = tf === "5m" ? `5M-ARB-${sig.reason}` : `PRED-${sig.reason}`;
            }
          }
        }
      }

      // ── v10: MEAN REVERSION ENTRY for 1h/1d markets ──
      // On longer timeframes, buy dips — if token price dropped but crypto still supports direction
      if (!side && (tf === "1d" || tf === "4h" || tf === "1h")) {
        const cryptoNow = this._getCryptoPrice(market.asset);
        if (cryptoNow) {
          // Check if UP token is cheap (dip) but crypto price is actually up
          if (upPrice && upPrice < 0.45 && upPrice >= ENTRY_MIN) {
            // UP token is cheap — is BTC actually up? (mean reversion opportunity)
            // If we had the market start price, we'd check crypto > start
            // Estimate: if BTC momentum is positive over 10m+, it's likely above today's open
            const mom10m = this._getMomentum(market.asset, 600);
            if (mom10m > 0.001) {
              side = "UP"; tokenId = market.upToken; entryPrice = upPrice;
              reason = `MREV-dip-buy+mom${(mom10m * 10000).toFixed(0)}bp`;
            }
          }
          // Check if DOWN token is cheap but crypto is actually down
          if (!side && downPrice && downPrice < 0.45 && downPrice >= ENTRY_MIN) {
            const mom10m = this._getMomentum(market.asset, 600);
            if (mom10m < -0.001) {
              side = "DOWN"; tokenId = market.downToken; entryPrice = downPrice;
              reason = `MREV-dip-buy+mom${(Math.abs(mom10m) * 10000).toFixed(0)}bp`;
            }
          }
        }
      }

      // ── Standard signal-based entry ──
      if (!side) {
        // v10: Timeframe-adaptive signal thresholds
        // 5m requires strong signal (latency arb should come via PRED entry above, not here)
        // 1d is lowest threshold (mean reversion plays need less momentum)
        const minStrength = (tf === "5m") ? 0.55 : (tf === "1d") ? 0.3 : (tf === "4h") ? 0.33 : (tf === "1h") ? 0.35 : 0.4;
        if (sig.strength < minStrength) continue;
        if (sig.direction === 0 && upPrice > SWEET_MIN && upPrice < SWEET_MAX) continue;

        if (sig.direction > 0 && upPrice >= ENTRY_MIN && upPrice <= ENTRY_MAX) {
          side = "UP"; tokenId = market.upToken; entryPrice = upPrice; reason = sig.reason;
        } else if (sig.direction < 0 && downPrice && downPrice >= ENTRY_MIN && downPrice <= ENTRY_MAX) {
          side = "DOWN"; tokenId = market.downToken; entryPrice = downPrice; reason = sig.reason;
        }
      }

      if (!side || !tokenId || entryPrice < ENTRY_MIN) continue;

      // v9: FLIP COOLDOWN — don't re-enter a market we just exited
      if (!this._mi.canReenter(market.conditionId)) continue;

      const elapsed = market.totalSecs > 0 ? 1 - (secsLeft / market.totalSecs) : 0;
      if (elapsed < 0.30) reason += "+EARLY";
      if (elapsed > 0.70 && sig.strength < 0.6) continue;
      if (elapsed > 0.70 && entryPrice > 0.75) reason += "+DECAY";

      // ═══ v9: MARKET INTELLIGENCE GATE ═══
      // Consult the trader brain before committing to any entry
      const mi = this._mi.analyze(market.asset, side, this._realPrices[market.asset]);

      // VETO — MI says don't trade (trap, wrong regime, exhausted, at S/R wall)
      if (mi.veto) {
        this.log("MI-VETO", `${market.asset} ${side} [${market.timeframe}]: ${mi.vetoReason}`);
        continue;
      }

      const modelProb = this._estimateProbability(market.asset, side, entryPrice, secsLeft, market.totalSecs);
      const kellyFrac = this._kellySize(modelProb, entryPrice);
      if (kellyFrac <= 0) continue;

      // ═══ CONVICTION + TIERED BET SIZING ═══
      const conv = this._calculateConviction(market.asset, side, sig, market, entryPrice, secsLeft);

      // v9: Apply MI conviction multiplier
      // MI adjusts conviction based on regime, structure, smart money, etc.
      let adjustedConviction = conv.conviction * mi.convictionMult;
      adjustedConviction = Math.max(0, Math.min(1, adjustedConviction));

      const { betSize: rawBet, tier } = this._calculateBetSize(adjustedConviction, conv.probeRecord, this.bankroll);

      // In high volatility, reduce non-probe bets by 50%
      const vol = this._getVolatility(market.asset);
      let betSize = rawBet;
      if (vol.regime === "high" && tier !== "PROBE") {
        betSize = Math.max(PROBE_SIZE, betSize * 0.5);
        reason += "+LVOL";
      }

      // Don't bet more than fair share — leave room for other markets
      const openSlots = Math.max(1, MAX_POSITIONS - this.positions.length);
      const maxPerSlot = openSlots > 1 ? Math.max(PROBE_SIZE, this.bankroll / openSlots) : this.bankroll * 0.98;
      betSize = Math.min(betSize, maxPerSlot, this.bankroll * 0.98);

      // ═══ HARD CAP: Timeframe-aware bet limits ═══
      // 5m: Small bets ($2 max) — high-frequency latency arb, manage risk per trade
      // 1d: Full send ($10 max) — high-conviction daily plays
      betSize = Math.min(betSize, tf === "5m" ? MAX_5M_BET : MAX_SINGLE_BET);

      betSize = Math.max(PROBE_SIZE, betSize);
      betSize = Math.round(betSize * 100) / 100;

      // v10: Timeframe-adaptive profit targets
      const baseTfTarget = PROFIT_TARGET_BY_TF[tf] || 0.08;
      let targetPct = sig.strength > 0.7 ? baseTfTarget * 1.5 : sig.strength > 0.4 ? baseTfTarget : baseTfTarget * 0.7;
      if (reason.includes("PRED")) targetPct = Math.min(targetPct, baseTfTarget * 1.2);
      if (reason.includes("MREV")) targetPct = baseTfTarget * 1.3; // Mean reversion plays have wider targets
      if (adjustedConviction > 0.85) targetPct = Math.min(targetPct * 1.5, 0.40);

      // v9: Add MI context to reason string
      if (mi.boosts.length > 0) reason += `+MI[${mi.boosts[0]}]`;
      if (mi.penalties.length > 0) reason += `+MI[${mi.penalties[0]}]`;

      // PRE-ENTRY VIABILITY: Can we exit if this goes wrong?
      const viability = this._assessEntryViability(market.asset, side, entryPrice, secsLeft);
      if (!viability.viable) {
        this.log("SKIP", `${market.asset} [${market.timeframe}] ${side} @$${entryPrice.toFixed(3)} — ${viability.reason}`);
        continue;
      }

      // ═══ FINAL CHECK: still have room? (race condition guard) ═══
      if (this.positions.length >= MAX_POSITIONS) break;

      // v9.3: Real CLOB entry (or simulated if paper mode)
      const entrySim = await this._simulateEntry(tokenId, betSize, entryPrice);
      if (!entrySim) {
        // FAK failure — order not filled, skip this market
        this._executionStats.failures++;
        this.log("FAK-FAIL", `Entry failed: ${market.asset} ${side} [${market.timeframe}] $${betSize.toFixed(2)} — no fill`);
        continue;
      }

      // Use simulated execution price (worse than mid due to spread + slippage)
      const realEntryPrice = entrySim.execPrice;
      const entrySlippage = entrySim.slippage;

      // Recalculate target profit with real entry price
      const realMaxProfit = betSize * (1.0 - realEntryPrice) / realEntryPrice;
      const realTargetProfit = Math.max(realMaxProfit * targetPct, 0.005);

      // Deduct from bankroll (floor at 0)
      this.bankroll = Math.max(0, this.bankroll - betSize);

      const patternKey = conv.patternKey;
      // v10: Record crypto price at entry for distance tracking
      const cryptoPriceAtEntry = this._getCryptoPrice(market.asset) || 0;

      this.positions.push({
        conditionId: market.conditionId, question: market.question,
        asset: market.asset, timeframe: market.timeframe, polyUrl: market.polyUrl,
        side, tokenId, entryPrice: realEntryPrice, midPriceAtEntry: entryPrice,
        size: betSize / realEntryPrice, costBasis: betSize,
        targetProfit: realTargetProfit, endDate: market.endDate, totalSecs: market.totalSecs,
        openedAt: now, peakGain: 0, unrealizedPnl: 0, currentPrice: realEntryPrice,
        entryReason: reason, signalStrength: sig.strength, modelProb, kellyFrac, volRegime: vol.regime,
        // v10: Crypto price at entry for price-distance exit intelligence
        cryptoPriceAtEntry,
        // Probe/conviction data — v9 uses adjusted conviction
        conviction: adjustedConviction, betTier: tier, patternKey, convictionFactors: conv.factors,
        // v9: MI analysis snapshot
        miRegime: mi.regime.type, miTrapRisk: mi.trap.confidence,
        miExhaustion: mi.exhaustion.level, miStructure: mi.structure.entryQuality,
        // v9.3: Execution data
        entrySlippage, entrySpread: entrySim.spread,
      });
      this.totalBets++; opened++;
      this._lastEntryTime = Date.now(); // SET ENTRY LOCK
      const probeStr = conv.probeRecord.samples > 0 ? ` probe:${conv.probeRecord.samples}/${(conv.probeRecord.recentWR * 100).toFixed(0)}%` : "";
      const chartStr = mi.chart && mi.chart.patterns.length > 0 ? ` chart:[${mi.chart.patterns.join(",")}]` : "";
      const miStr = ` ${mi.regime.type.slice(0, 5)}|trap:${(mi.trap.confidence * 100).toFixed(0)}%|str:${(mi.structure.entryQuality * 100).toFixed(0)}%${chartStr}`;
      const slipStr = ` slip:$${entrySlippage.toFixed(4)} spr:${(entrySim.spread * 100).toFixed(1)}c`;
      const cryptoStr = cryptoPriceAtEntry ? ` crypto:$${cryptoPriceAtEntry.toFixed(0)}` : "";
      this.log("OPEN", `[${tier}] ${reason}: ${market.asset} [${market.timeframe}] ${side} @$${realEntryPrice.toFixed(3)} (mid:$${entryPrice.toFixed(3)}) $${betSize.toFixed(2)}${slipStr}${cryptoStr} | conv:${(adjustedConviction * 100).toFixed(0)}%${probeStr} |${miStr} | ${Math.floor(secsLeft)}s | bank:$${this.bankroll.toFixed(2)}`);

      // ═══ POOL SYNC: Lock user balances for this trade ═══
      if (supa.isConnected()) {
        try {
          const newPos = this.positions[this.positions.length - 1];
          const poolTradeId = await supa.createPoolTrade({
            condition_id: market.conditionId, token_id: tokenId,
            market_name: `${market.asset} ${market.timeframe} ${side}`,
            asset: market.asset, timeframe: market.timeframe, side,
            entry_price: realEntryPrice, total_size: betSize / realEntryPrice,
            total_cost: betSize, pool_balance_at_entry: this.bankroll + betSize,
            entry_reason: reason, bot_position_data: newPos,
          });
          if (poolTradeId) {
            newPos.poolTradeId = poolTradeId;
            await supa.lockBalancesForTrade(poolTradeId, betSize, `${market.asset} ${market.timeframe} ${side}`, side, realEntryPrice);
            this.log("POOL", `Locked $${betSize.toFixed(2)} across users for pool trade ${poolTradeId.slice(0, 8)}`);
          }
        } catch (e) { this.log("WARN", `Pool lock failed: ${e.message}`); }
      }

      this.save();
    }
    return opened;
  }

  // ─── Manual Trade — force open a position on a specific market ───
  async manualTrade(asset, side, betSize) {
    side = side.toUpperCase();
    if (side !== "UP" && side !== "DOWN") return { error: "Side must be UP or DOWN" };
    if (betSize < 1) return { error: "Minimum bet is $1" };
    if (betSize > this.bankroll) return { error: `Insufficient bankroll: $${this.bankroll.toFixed(2)}` };

    // Find matching market — prefer daily, then longest timeframe
    const tfPriority = ["1d", "4h", "1h", "15m", "5m"];
    let market = null;
    for (const tf of tfPriority) {
      market = this.markets.find(m => m.asset === asset && m.timeframe === tf && m.secsLeft > 60);
      if (market) break;
    }
    if (!market) return { error: `No active ${asset} market found` };

    const tokenId = side === "UP" ? market.upToken : market.downToken;
    if (!tokenId) return { error: `No ${side} token for ${asset} ${market.timeframe}` };

    // Get current price from CLOB WS orderbook or Gamma
    const clobBook = this._orderbooks[tokenId];
    let entryPrice = (clobBook && clobBook.mid > 0) ? clobBook.mid : (side === "UP" ? market.gammaUpPrice : market.gammaDownPrice);
    if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) return { error: `No valid price for ${side} token` };

    // Real CLOB execution (or simulated if paper mode)
    let entrySim = await this._simulateEntry(tokenId, betSize, entryPrice);
    if (!entrySim || !entrySim.filled) {
      return { error: "Order not matched on CLOB — no position created" };
    }

    const realEntryPrice = entrySim.execPrice;
    const now = Date.now();
    const secsLeft = market.endDate ? Math.floor((market.endDate - now) / 1000) : market.secsLeft;
    const maxProfit = betSize * (1.0 - realEntryPrice) / realEntryPrice;
    const targetPct = PROFIT_TARGET_BY_TF[market.timeframe] || 0.35;
    const targetProfit = Math.max(maxProfit * targetPct, 0.005);
    const cryptoPriceAtEntry = this._getCryptoPrice(asset) || 0;

    this.bankroll = Math.max(0, this.bankroll - betSize);
    this.positions.push({
      conditionId: market.conditionId, question: market.question,
      asset, timeframe: market.timeframe, polyUrl: market.polyUrl,
      side, tokenId, entryPrice: realEntryPrice, midPriceAtEntry: entryPrice,
      size: betSize / realEntryPrice, costBasis: betSize,
      targetProfit, endDate: market.endDate, totalSecs: market.totalSecs,
      openedAt: now, peakGain: 0, unrealizedPnl: 0, currentPrice: realEntryPrice,
      entryReason: "MANUAL", signalStrength: 0, modelProb: 0.5, kellyFrac: 0, volRegime: "unknown",
      cryptoPriceAtEntry,
      conviction: 1.0, betTier: "MANUAL", patternKey: `${asset}-${side}-MANUAL`,
      convictionFactors: {}, miRegime: "MANUAL", miTrapRisk: 0, miExhaustion: 0, miStructure: 0,
      entrySlippage: entrySim.slippage || 0, entrySpread: entrySim.spread || 0,
    });
    this.totalBets++;

    this.log("OPEN", `[MANUAL] ${asset} [${market.timeframe}] ${side} @$${realEntryPrice.toFixed(3)} $${betSize.toFixed(2)} crypto:$${cryptoPriceAtEntry.toFixed(0)} | ${Math.floor(secsLeft)}s left | bank:$${this.bankroll.toFixed(2)}`);

    // ═══ POOL SYNC: Lock user balances for this trade ═══
    if (supa.isConnected()) {
      try {
        const newPos = this.positions[this.positions.length - 1];
        const poolTradeId = await supa.createPoolTrade({
          condition_id: market.conditionId, token_id: tokenId,
          market_name: `${asset} ${market.timeframe} ${side}`,
          asset, timeframe: market.timeframe, side,
          entry_price: realEntryPrice, total_size: betSize / realEntryPrice,
          total_cost: betSize, pool_balance_at_entry: this.bankroll + betSize,
          entry_reason: "MANUAL", bot_position_data: newPos,
        });
        if (poolTradeId) {
          newPos.poolTradeId = poolTradeId;
          await supa.lockBalancesForTrade(poolTradeId, betSize, `${asset} ${market.timeframe} ${side}`, side, realEntryPrice);
          this.log("POOL", `Locked $${betSize.toFixed(2)} across users for pool trade ${poolTradeId.slice(0, 8)}`);
        }
      } catch (e) { this.log("WARN", `Pool lock failed: ${e.message}`); }
    }

    this.save();

    return {
      success: true,
      asset, side, timeframe: market.timeframe,
      entryPrice: realEntryPrice, betSize,
      secsLeft, cryptoPrice: cryptoPriceAtEntry,
      maxProfit: maxProfit.toFixed(2),
      targetProfit: targetProfit.toFixed(2),
    };
  }

  // ─── Auto-Entry: Spread bankroll across ALL valid markets ───
  // Never sit idle — put money to work on every market with a signal
  // Uses crypto momentum to pick the RIGHT side (not just cheapest)
  // Splits bankroll evenly across available markets (min $1 each)
  async _autoEntryDaily() {
    // MUTEX: prevent concurrent ticks from double-entering
    if (this._entryLock) return 0;
    this._entryLock = true;
    try {
      return await this._autoEntryDailyInner();
    } finally {
      this._entryLock = false;
    }
  }

  async _autoEntryDailyInner() {
    if (this.bankroll < 1.0) {
      if (this._tickCount % 20 === 0) this.log("AUTO", `Bankroll $${this.bankroll.toFixed(2)} too low for auto-entry`);
      return 0;
    }
    // Already have a position — don't enter another
    if (this.positions.length >= MAX_POSITIONS) return 0;

    // ═══ ENTRY LOCK — prevents double-entry with _scanEntries ═══
    const now2 = Date.now();
    if (this._lastEntryTime && (now2 - this._lastEntryTime) < ENTRY_LOCK_MS) {
      return 0;
    }

    const now = Date.now();
    const MIN_HOURS_LEFT = 20; // STRICT: need at least 20 hours of runway

    // ONLY look at BTC daily markets — safest, most liquid, most predictable
    const candidates = [];
    for (const market of this.markets) {
      if (market.asset !== "BTC") continue;        // BTC ONLY
      if (market.timeframe !== "1d") continue;      // Daily ONLY
      const secsLeft = market.endDate ? (market.endDate - now) / 1000 : 0;
      if (secsLeft < MIN_HOURS_LEFT * 3600) continue; // 6+ hours minimum
      if (this.positions.find(p => p.conditionId === market.conditionId)) continue;
      candidates.push({ ...market, secsLeft });
    }

    if (candidates.length === 0) {
      if (this._tickCount % 20 === 0) this.log("AUTO", "No BTC daily markets with 6h+ left");
      return 0;
    }

    // Pick the market with most time left (safest — more time = more room to be right)
    candidates.sort((a, b) => b.secsLeft - a.secsLeft);
    const market = candidates[0];
    const secsLeft = market.secsLeft;

    const asset = market.asset;
    const upPrice = market.gammaUpPrice || 0;
    const downPrice = market.gammaDownPrice || 0;
    if (!upPrice && !downPrice) return 0;

    // SIMPLE STRATEGY: buy the CHEAPEST side — maximum upside potential
    // If UP=$0.40 and DOWN=$0.60, buy UP ($0.40 → $1.00 = 150% gain if right)
    // On daily BTC, the market has hours to move in our favor
    let side, tokenId, entryPrice, reason;

    if (upPrice > 0 && downPrice > 0 && upPrice <= downPrice) {
      side = "UP"; tokenId = market.upToken; entryPrice = upPrice;
      reason = `DAILY-CHEAP-UP@$${upPrice.toFixed(3)}`;
    } else if (downPrice > 0) {
      side = "DOWN"; tokenId = market.downToken; entryPrice = downPrice;
      reason = `DAILY-CHEAP-DN@$${downPrice.toFixed(3)}`;
    } else {
      return 0;
    }

    if (!tokenId || !entryPrice) return 0;

    // Override with live CLOB price if available
    const clobBook = this._orderbooks[tokenId];
    if (clobBook && clobBook.mid > 0) entryPrice = clobBook.mid;

    if (entryPrice <= 0 || entryPrice >= 0.85) return 0; // Don't buy expensive side
    if (entryPrice < 0.05) return 0; // Too cheap = market says no chance

    // Bet size: use full bankroll (capped at MAX_SINGLE_BET)
    let betSize = Math.round(Math.min(this.bankroll * 0.98, this.bankroll - 0.01) * 100) / 100;
    betSize = Math.min(betSize, MAX_SINGLE_BET); // HARD CAP
    if (betSize < 1.0) return 0;

    // ═══ FINAL CHECK: still have room? (race condition guard) ═══
    if (this.positions.length >= MAX_POSITIONS) return 0;

    // Real CLOB entry (or simulated if paper mode)
    let entrySim = await this._simulateEntry(tokenId, betSize, entryPrice);
    if (!entrySim || !entrySim.filled) {
      this.log("AUTO-FAIL", `Entry failed for BTC [1d] ${side} $${betSize.toFixed(2)} — order not matched`);
      return 0; // DO NOT create ghost position
    }

    const realEntryPrice = entrySim.execPrice;
    const maxProfit = betSize * (1.0 - realEntryPrice) / realEntryPrice;
    const targetPct = PROFIT_TARGET_BY_TF[market.timeframe] || 0.35;
    const targetProfit = Math.max(maxProfit * targetPct, 0.01);
    const cryptoPriceAtEntry = this._getCryptoPrice(asset) || 0;

    this.bankroll = Math.max(0, this.bankroll - betSize);
    this.positions.push({
      conditionId: market.conditionId, question: market.question,
      asset, timeframe: market.timeframe, polyUrl: market.polyUrl,
      side, tokenId, entryPrice: realEntryPrice, midPriceAtEntry: entryPrice,
      size: betSize / realEntryPrice, costBasis: betSize,
      targetProfit, endDate: market.endDate, totalSecs: market.totalSecs,
      openedAt: now, peakGain: 0, unrealizedPnl: 0, currentPrice: realEntryPrice,
      entryReason: reason, signalStrength: 0, modelProb: 0.5, kellyFrac: 0, volRegime: "unknown",
      cryptoPriceAtEntry,
      conviction: 0.8, betTier: "AUTO", patternKey: `${asset}-${side}-AUTO`,
      convictionFactors: [reason], miRegime: "AUTO", miTrapRisk: 0, miExhaustion: 0, miStructure: 0,
      entrySlippage: entrySim.slippage || 0, entrySpread: entrySim.spread || 0,
    });
    this.totalBets++;
    this._lastEntryTime = Date.now(); // SET ENTRY LOCK

    const potentialReturn = ((1.0 / realEntryPrice) - 1) * 100;
    const hoursLeft = Math.floor(secsLeft / 3600);
    this.log("AUTO", `${reason}: BTC [1d] ${side} @$${realEntryPrice.toFixed(3)} (${potentialReturn.toFixed(0)}% upside) $${betSize.toFixed(2)} | crypto:$${cryptoPriceAtEntry.toFixed(0)} | ${hoursLeft}h left | bank:$${this.bankroll.toFixed(2)}`);

    // ═══ POOL SYNC: Lock user balances for this trade ═══
    if (supa.isConnected()) {
      try {
        const newPos = this.positions[this.positions.length - 1];
        const poolTradeId = await supa.createPoolTrade({
          condition_id: market.conditionId, token_id: tokenId,
          market_name: `BTC 1d ${side}`,
          asset: "BTC", timeframe: "1d", side,
          entry_price: realEntryPrice, total_size: betSize / realEntryPrice,
          total_cost: betSize, pool_balance_at_entry: this.bankroll + betSize,
          entry_reason: reason, bot_position_data: newPos,
        });
        if (poolTradeId) {
          newPos.poolTradeId = poolTradeId;
          await supa.lockBalancesForTrade(poolTradeId, betSize, `BTC 1d ${side}`, side, realEntryPrice);
          this.log("POOL", `Locked $${betSize.toFixed(2)} across users for pool trade ${poolTradeId.slice(0, 8)}`);
        }
      } catch (e) { this.log("WARN", `Pool lock failed: ${e.message}`); }
    }

    this.save();
    return 1;
  }

  getStats() {
    const unreal = this.positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
    const locked = this.positions.reduce((s, p) => s + (p.costBasis || PROBE_SIZE), 0);
    // Probe system summary
    const probePatterns = Object.keys(this._probeResults).length;
    const probeProven = Object.values(this._probeResults).filter(p => p.results.length >= PROBE_MIN_SAMPLES && p.results.filter(r => r).length / p.results.length >= PROBE_WIN_THRESHOLD).length;
    return {
      // Bankroll
      bankroll: this.bankroll,
      startingBankroll: this.startingBankroll,
      lockedInPositions: locked,
      totalBalance: this.bankroll + locked + unreal,
      // P&L
      totalPnl: this.totalPnl, unrealizedPnl: unreal,
      totalBets: this.totalBets, wins: this.wins, losses: this.losses,
      winRate: (this.wins + this.losses) > 0 ? ((this.wins / (this.wins + this.losses)) * 100) : 0,
      openPositions: this.positions.length, dailyPnl: this._dailyPnl, kellyWealth: this._kellyWealth,
      // Probe system
      probePatterns, probeProven,
      positions: this.positions.map(p => {
        // Run live chart analysis on crypto price data for each open position
        const chartAnalysis = this._mi.analyzeChart(this._realPrices[p.asset], p.side);
        return {
          ...p, unrealizedPnl: p.unrealizedPnl || 0, currentPrice: p.currentPrice || p.entryPrice,
          conviction: p.conviction || 0, betTier: p.betTier || "PROBE", convictionFactors: p.convictionFactors || [],
          liveChart: chartAnalysis.patterns.length > 0 ? {
            patterns: chartAnalysis.patterns.map(pt => pt.name),
            bias: chartAnalysis.bias,
            confidence: chartAnalysis.confidence,
            holdSignal: chartAnalysis.holdSignal,
            exitSignal: chartAnalysis.exitSignal,
          } : null,
        };
      }),
      recentHistory: this.history.slice(0, 30),
      marketCount: this.markets.length,
      marketList: this.markets.map(m => ({
        asset: m.asset, timeframe: m.timeframe, question: m.question,
        gammaUpPrice: m.gammaUpPrice, gammaDownPrice: m.gammaDownPrice,
        secsLeft: m.endDate ? Math.max(0, Math.floor((m.endDate - Date.now()) / 1000)) : 0,
        polyUrl: m.polyUrl,
      })),
      lastLog: this.lastLog, tickCount: this._tickCount,
      logs: this.logs.filter(l => !["TICK", "SIGNAL", "SCAN", "MARKET"].includes(l.type)).slice(-100),
      liveData: this._liveDataTs > 0 && Date.now() - this._liveDataTs < 5000,
      // v9.3: Execution stats
      executionStats: this._executionStats,
      clobActive: USE_CLOB_PRICES,
      orderbookCount: Object.keys(this._orderbooks).length,
      // v9.4: Chainlink oracle data
      chainlinkPrices: { ...this._chainlinkPrices },
      chainlinkLive: this._chainlinkTs > 0 && Date.now() - this._chainlinkTs < 60000,
      chainlinkLag: { ...this._chainlinkLag },
      priceDivergence: Object.fromEntries(
        ["BTC", "ETH", "SOL"].map(a => [a, this._getPriceDivergence(a)]).filter(([, v]) => v !== null)
      ),
      // v9.5: Multi-exchange predicted Chainlink price
      predictedChainlink: { ...this._predictedChainlink },
      predictedLive: this._predictedTs > 0 && Date.now() - this._predictedTs < 15000,
      // v9.6: CLOB WebSocket live prices
      clobWsLive: this._clobLiveTs > 0 && Date.now() - this._clobLiveTs < 5000,
    };
  }
}
