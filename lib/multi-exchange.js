// Multi-Exchange WebSocket — Coinbase + Kraken real-time prices
// Combined with Binance data to compute a median = predicted Chainlink price
// Chainlink uses "median of medians of volume-weighted averages" from 16 oracle nodes,
// each pulling from premium data aggregators (CoinGecko, BraveNewCoin, Tiingo, etc.)
// which themselves aggregate from exchanges. Our median of 3 major exchanges
// approximates this for close-call resolution prediction.

import WebSocket from "ws";

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;
const STALE_TIMEOUT = 15000;   // 15s — exchanges are fast, stale quickly

// ─── Coinbase WebSocket ──────────────────────────
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const COINBASE_PAIRS = {
  "BTC-USD": "BTC",
  "ETH-USD": "ETH",
  "SOL-USD": "SOL",
};

// ─── Kraken WebSocket v2 ─────────────────────────
const KRAKEN_WS = "wss://ws.kraken.com/v2";
const KRAKEN_PAIRS = {
  "XBT/USD": "BTC",
  "ETH/USD": "ETH",
  "SOL/USD": "SOL",
};

class ExchangeFeed {
  constructor(name, wsUrl, onPrice) {
    this.name = name;
    this.wsUrl = wsUrl;
    this.onPrice = onPrice;     // (exchange, asset, price) => void
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = RECONNECT_BASE;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastDataTs = 0;
    this.prices = {};
    this._reconnects = 0;
    this._messagesReceived = 0;
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    _slog(`[${this.name}] Connecting to ${this.wsUrl.slice(0, 50)}...`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE;
      this._reconnects = 0;
      _slog(`[${this.name}] Connected`);
      this._subscribe();
      this._startPing();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleMessage(msg);
      } catch {}
    });

    this.ws.on("close", (code) => {
      this.connected = false;
      this._stopPing();
      _slog(`[${this.name}] Disconnected (code ${code})`);
      this._scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      _slog(`[${this.name}] Error: ${err.message}`);
    });
  }

  _subscribe() { /* override in subclass */ }
  _handleMessage(msg) { /* override in subclass */ }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this._reconnects++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this._reconnects - 1), RECONNECT_MAX);
    _slog(`[${this.name}] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this._reconnects})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _emitPrice(asset, price) {
    if (!price || isNaN(price) || price <= 0) return;
    this.prices[asset] = price;
    this.lastDataTs = Date.now();
    this._messagesReceived++;
    if (this.onPrice) this.onPrice(this.name, asset, price);
  }

  isLive() {
    return this.connected && (Date.now() - this.lastDataTs) < STALE_TIMEOUT;
  }

  close() {
    this._stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.removeAllListeners(); try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
    _slog(`[${this.name}] Closed`);
  }
}

// ─── Coinbase Feed ───────────────────────────────
class CoinbaseFeed extends ExchangeFeed {
  constructor(onPrice) {
    super("Coinbase", COINBASE_WS, onPrice);
  }

  _subscribe() {
    this.ws.send(JSON.stringify({
      type: "subscribe",
      product_ids: Object.keys(COINBASE_PAIRS),
      channels: ["ticker"],
    }));
    _slog(`[Coinbase] Subscribed to ${Object.keys(COINBASE_PAIRS).join(", ")}`);
  }

  _handleMessage(msg) {
    if (msg.type !== "ticker") return;
    const asset = COINBASE_PAIRS[msg.product_id];
    if (!asset) return;
    const price = parseFloat(msg.price);
    this._emitPrice(asset, price);
  }
}

// ─── Kraken Feed ─────────────────────────────────
class KrakenFeed extends ExchangeFeed {
  constructor(onPrice) {
    super("Kraken", KRAKEN_WS, onPrice);
  }

  _subscribe() {
    this.ws.send(JSON.stringify({
      method: "subscribe",
      params: {
        channel: "ticker",
        symbol: Object.keys(KRAKEN_PAIRS),
      },
    }));
    _slog(`[Kraken] Subscribed to ${Object.keys(KRAKEN_PAIRS).join(", ")}`);
  }

  _handleMessage(msg) {
    // Kraken v2: { channel: "ticker", type: "update", data: [{ symbol, last, ... }] }
    if (msg.channel !== "ticker" || msg.type !== "update") return;
    if (!Array.isArray(msg.data)) return;
    for (const d of msg.data) {
      const asset = KRAKEN_PAIRS[d.symbol];
      if (!asset) continue;
      const price = parseFloat(d.last);
      this._emitPrice(asset, price);
    }
  }
}

// ─── Multi-Exchange Aggregator ───────────────────
// Combines Binance (from main BinanceWS) + Coinbase + Kraken
// Computes median = best approximation of Chainlink's aggregated price
export class MultiExchange {
  constructor(onPredicted) {
    this.onPredicted = onPredicted;   // (predictions) => void  { BTC: 97123, ETH: 3456, SOL: 189 }
    this.coinbase = null;
    this.kraken = null;

    // Per-exchange prices: { BTC: { binance: 97100, coinbase: 97105, kraken: 97098 } }
    this._prices = { BTC: {}, ETH: {}, SOL: {} };
    this._predicted = {};  // { BTC: 97101, ETH: 3455, SOL: 189 } — median of all exchanges
    this._lastUpdate = 0;
  }

  connect() {
    const handler = (exchange, asset, price) => {
      this._prices[asset][exchange.toLowerCase()] = price;
      this._recalculate(asset);
    };

    this.coinbase = new CoinbaseFeed(handler);
    this.kraken = new KrakenFeed(handler);

    this.coinbase.connect();
    this.kraken.connect();
  }

  // Call this from server when Binance prices update
  updateBinance(prices) {
    for (const [asset, data] of Object.entries(prices)) {
      const price = typeof data === "object" ? data.price : data;
      if (price && price > 0 && this._prices[asset]) {
        this._prices[asset].binance = price;
        this._recalculate(asset);
      }
    }
  }

  _recalculate(asset) {
    const sources = this._prices[asset];
    if (!sources) return;

    const vals = Object.values(sources).filter(v => v > 0);
    if (vals.length === 0) return;

    // Median — same approach Chainlink uses at the consensus layer
    vals.sort((a, b) => a - b);
    const mid = vals.length % 2 === 1
      ? vals[Math.floor(vals.length / 2)]
      : (vals[Math.floor(vals.length / 2) - 1] + vals[Math.floor(vals.length / 2)]) / 2;

    this._predicted[asset] = mid;
    this._lastUpdate = Date.now();

    if (this.onPredicted) {
      this.onPredicted({ ...this._predicted });
    }
  }

  // Get predicted Chainlink price for an asset
  getPredicted(asset) {
    return this._predicted[asset] || null;
  }

  // Get all exchange prices for an asset (for dashboard display)
  getExchangePrices(asset) {
    return { ...this._prices[asset] };
  }

  getStats() {
    const exchangeCount = (this.coinbase && this.coinbase.isLive() ? 1 : 0)
                        + (this.kraken && this.kraken.isLive() ? 1 : 0);
    return {
      coinbase: this.coinbase ? { live: this.coinbase.isLive(), messages: this.coinbase._messagesReceived } : null,
      kraken: this.kraken ? { live: this.kraken.isLive(), messages: this.kraken._messagesReceived } : null,
      exchangeCount: exchangeCount + 1, // +1 for Binance (always there)
      predicted: { ...this._predicted },
      prices: {
        BTC: { ...this._prices.BTC },
        ETH: { ...this._prices.ETH },
        SOL: { ...this._prices.SOL },
      },
      lastUpdate: this._lastUpdate,
    };
  }

  close() {
    if (this.coinbase) this.coinbase.close();
    if (this.kraken) this.kraken.close();
    _slog("[MultiExchange] Closed");
  }
}
