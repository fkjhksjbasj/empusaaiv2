// 5m Pre-Resolution Scalper — "First Profit, Exit"
// Strategy: Enter NEXT 5m market at ~$0.50 before price-to-beat is set.
// Use mean-reversion from previous window's BTC momentum to pick direction.
// Place GTC sell at entry + 2¢ immediately after fill — auto-exits on oscillation.
// Hold to resolution as fallback (50/50 = breakeven EV at $0.50 entry).

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

// ─── Config ──────────────────────────────────────
const TRADE_SIZE = 1.10;          // Just above $1 minimum
const PROFIT_TARGET = 0.02;       // Sell at entry + 2¢
const MAX_BANKROLL = 2.00;        // Don't use more than $2 for 5m
const WINDOW_SECS = 300;          // 5 minutes
const WATCH_START = 60;           // Start watching BTC at 60s before window end
const ENTRY_TRIGGER = 30;         // Place order at 30s before window end
const HOLD_DEADLINE = 15;         // Cancel sell at 15s before market end — hold to resolution
const MIN_BTC_MOVE = 0.0003;      // 0.03% min BTC move to trigger entry (else skip)

// ─── States ──────────────────────────────────────
const IDLE = "IDLE";
const WATCHING = "WATCHING";
const ENTERING = "ENTERING";
const HOLDING = "HOLDING";

export class FiveMinScalper {
  constructor() {
    this.state = IDLE;
    this.clobClient = null;     // ClobOrders instance
    this.markets = [];          // All loaded markets (shared with main scalper)
    this.btcPrice = 0;          // Live BTC price from WS
    this.btcPrices = [];        // BTC prices during WATCHING phase [{ts, price}]
    this.position = null;       // { tokenId, side, shares, entryPrice, buyOrderId, sellOrderId, market }
    this.lastTradeWindow = 0;   // Prevents re-entry in same window
    this.stats = { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
    this._busy = false;         // Mutex for async operations
  }

  init(clobClient) {
    this.clobClient = clobClient;
    _slog("[5mScalp] Initialized — waiting for 5m windows");
  }

  updateMarkets(markets) {
    this.markets = markets || [];
  }

  updatePrice(btcPrice) {
    if (btcPrice && btcPrice > 0) this.btcPrice = btcPrice;
  }

  // ─── Main tick (called every 1s from server.js) ─
  async tick() {
    if (this._busy) return;
    if (!this.clobClient || !this.clobClient.ready) return;
    if (this.btcPrice <= 0) return;

    try {
      this._busy = true;
      switch (this.state) {
        case IDLE:     await this._tickIdle(); break;
        case WATCHING: await this._tickWatching(); break;
        case ENTERING: break; // Handled inline
        case HOLDING:  await this._tickHolding(); break;
      }
    } catch (e) {
      _slog(`[5mScalp] Tick error: ${e.message}`);
    } finally {
      this._busy = false;
    }
  }

  // ─── IDLE: Wait for entry window ───────────────
  async _tickIdle() {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
    const windowEnd = windowStart + WINDOW_SECS;
    const secsLeft = windowEnd - now;

    // Don't re-enter the same window we just traded
    const nextWindowStart = windowStart + WINDOW_SECS;
    if (this.lastTradeWindow >= nextWindowStart) return;

    // Check bankroll
    if (this.clobClient) {
      const bal = await this.clobClient.getBalance();
      if (bal < TRADE_SIZE || bal > MAX_BANKROLL) return; // Not enough or over cap
    }

    // Enter watching phase 60s before current window ends
    if (secsLeft <= WATCH_START && secsLeft > ENTRY_TRIGGER) {
      this.state = WATCHING;
      this.btcPrices = [{ ts: now, price: this.btcPrice }];
      _slog(`[5mScalp] WATCHING — ${secsLeft}s left in current window, BTC=$${this.btcPrice.toFixed(0)}`);
    }
  }

  // ─── WATCHING: Collect BTC prices, then enter ──
  async _tickWatching() {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
    const windowEnd = windowStart + WINDOW_SECS;
    const secsLeft = windowEnd - now;

    // Record BTC price
    this.btcPrices.push({ ts: now, price: this.btcPrice });

    // Time to enter
    if (secsLeft <= ENTRY_TRIGGER) {
      const firstPrice = this.btcPrices[0].price;
      const lastPrice = this.btcPrice;
      const delta = (lastPrice - firstPrice) / firstPrice;

      // Need minimum movement to have a signal
      if (Math.abs(delta) < MIN_BTC_MOVE) {
        _slog(`[5mScalp] SKIP — BTC delta ${(delta * 100).toFixed(3)}% too small (need ${(MIN_BTC_MOVE * 100).toFixed(2)}%)`);
        this.state = IDLE;
        this.lastTradeWindow = windowStart + WINDOW_SECS; // Skip this cycle
        return;
      }

      // Mean reversion: BTC up → buy DOWN, BTC down → buy UP
      const side = delta > 0 ? "DOWN" : "UP";
      _slog(`[5mScalp] SIGNAL — BTC ${delta > 0 ? "UP" : "DOWN"} ${(Math.abs(delta) * 100).toFixed(3)}% → buying ${side} (mean reversion)`);

      this.state = ENTERING;
      await this._enter(side, windowStart + WINDOW_SECS); // Enter the NEXT window
    }
  }

  // ─── ENTER: Find market, buy, place sell ───────
  async _enter(side, nextWindowStart) {
    try {
      // Find BTC 5m market with the most time remaining (= the NEXT window)
      const btc5mMarkets = this.markets
        .filter(m => m.asset === "BTC" && m.timeframe === "5m" && m.upToken && m.secsLeft > 60)
        .sort((a, b) => b.secsLeft - a.secsLeft);

      const market = btc5mMarkets[0];
      if (!market) {
        _slog(`[5mScalp] No BTC 5m market found with >60s remaining`);
        this.state = IDLE;
        this.lastTradeWindow = nextWindowStart;
        return;
      }

      await this._executeBuy(market, side, nextWindowStart);
    } catch (e) {
      _slog(`[5mScalp] Entry error: ${e.message}`);
      this.state = IDLE;
    }
  }

  async _executeBuy(market, side, nextWindowStart) {
    const tokenId = side === "UP" ? market.upToken : market.downToken;
    const askPrice = side === "UP"
      ? (market.gammaUpPrice || 0.50)
      : (market.gammaDownPrice || 0.50);

    // Don't buy if token is already expensive (price-to-beat is known, market has moved)
    if (askPrice > 0.60) {
      _slog(`[5mScalp] SKIP — ${side} token too expensive @$${askPrice.toFixed(2)} (want ~$0.50)`);
      this.state = IDLE;
      this.lastTradeWindow = nextWindowStart;
      return;
    }

    const buyPrice = Math.min(askPrice + 0.01, 0.55); // Slightly above ask to ensure fill, cap at 55¢
    _slog(`[5mScalp] BUYING ${side} @$${buyPrice.toFixed(2)} — ${market.question || market.slug}`);

    const result = await this.clobClient.buyShares(tokenId, TRADE_SIZE, buyPrice);
    if (!result.success) {
      _slog(`[5mScalp] BUY FAILED: ${result.error}`);
      this.state = IDLE;
      this.lastTradeWindow = nextWindowStart;
      return;
    }

    // Wait 3s for fill
    await _sleep(3000);
    const verify = await this.clobClient.verifyOrder(result.orderId);
    if (!verify.matched) {
      _slog(`[5mScalp] BUY not matched — cancelling`);
      await this.clobClient.cancelOrder(result.orderId);
      this.state = IDLE;
      this.lastTradeWindow = nextWindowStart;
      return;
    }

    const shares = verify.sizeMatched || result.shares;
    const entryPrice = result.execPrice;
    _slog(`[5mScalp] BOUGHT ${shares} shares ${side} @$${entryPrice.toFixed(2)}`);

    // Immediately place GTC sell at entry + profit target
    const sellPrice = Math.round((entryPrice + PROFIT_TARGET) * 100) / 100;
    let sellOrderId = null;

    // Need allowance update + sell
    const sellResult = await this.clobClient.sellShares(tokenId, shares, sellPrice, false);
    if (sellResult.success) {
      sellOrderId = sellResult.orderId;
      _slog(`[5mScalp] SELL ORDER placed @$${sellPrice.toFixed(2)} (profit target +$${PROFIT_TARGET})`);
    } else {
      _slog(`[5mScalp] SELL ORDER failed: ${sellResult.error} — will monitor manually`);
    }

    this.position = {
      tokenId, side, shares, entryPrice, buyOrderId: result.orderId,
      sellOrderId, market, openedAt: Date.now(),
      windowEnd: nextWindowStart + WINDOW_SECS,
    };
    this.lastTradeWindow = nextWindowStart;
    this.state = HOLDING;
    this.stats.trades++;
  }

  // ─── HOLDING: Monitor sell order fill ──────────
  async _tickHolding() {
    if (!this.position) { this.state = IDLE; return; }

    const now = Math.floor(Date.now() / 1000);
    const secsLeft = this.position.windowEnd - now;

    // Check if sell order filled
    if (this.position.sellOrderId) {
      const check = await this.clobClient.checkOrderFilled(this.position.sellOrderId);
      if (check.filled) {
        const profit = PROFIT_TARGET * this.position.shares;
        this.stats.wins++;
        this.stats.totalPnl += profit;
        _slog(`[5mScalp] PROFIT! Sold ${this.position.side} @$${(this.position.entryPrice + PROFIT_TARGET).toFixed(2)} — +$${profit.toFixed(3)}`);
        this.position = null;
        this.state = IDLE;
        return;
      }
    }

    // Approaching market close — cancel sell, hold to resolution
    if (secsLeft <= HOLD_DEADLINE) {
      if (this.position.sellOrderId) {
        await this.clobClient.cancelOrder(this.position.sellOrderId);
        _slog(`[5mScalp] Cancelled sell — holding to resolution (${secsLeft}s left)`);
      }
      // Position resolves at $1 or $0. At ~$0.50 entry, EV ≈ breakeven.
      _slog(`[5mScalp] RESOLUTION HOLD — ${this.position.side} ${this.position.shares} shares, entry $${this.position.entryPrice.toFixed(2)}`);
      this.position = null;
      this.state = IDLE;
      return;
    }

    // Log status every 30s
    if (Date.now() - (this.position._lastLog || 0) > 30000) {
      _slog(`[5mScalp] HOLDING ${this.position.side} — ${secsLeft}s left, waiting for fill @$${(this.position.entryPrice + PROFIT_TARGET).toFixed(2)}`);
      this.position._lastLog = Date.now();
    }
  }

  // ─── State for dashboard ───────────────────────
  getState() {
    return {
      state: this.state,
      position: this.position ? {
        side: this.position.side,
        shares: this.position.shares,
        entryPrice: this.position.entryPrice,
        target: this.position.entryPrice + PROFIT_TARGET,
        secsLeft: Math.max(0, this.position.windowEnd - Math.floor(Date.now() / 1000)),
      } : null,
      stats: { ...this.stats },
      btcPrice: this.btcPrice,
    };
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
