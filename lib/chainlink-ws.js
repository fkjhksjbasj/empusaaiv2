// Chainlink Price WebSocket — via Polymarket RTDS
// Connects to Polymarket's Real-Time Data Socket for Chainlink oracle prices
// These are the ACTUAL resolution prices for UP/DOWN crypto markets
// Free, no authentication required

import WebSocket from "ws";

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

const WS_URL = "wss://ws-live-data.polymarket.com";
const PING_INTERVAL = 5000;    // 5s keep-alive (Polymarket requires this)
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;
const STALE_TIMEOUT = 60000;   // 60s without data = stale (Chainlink updates every ~27s)

// Chainlink symbol → our asset name
const SYMBOL_MAP = {
  "btc/usd": "BTC",
  "eth/usd": "ETH",
  "sol/usd": "SOL",
};

export class ChainlinkWS {
  constructor(onPrices) {
    this.onPrices = onPrices;       // callback: (prices) => void
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = RECONNECT_BASE;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastDataTs = 0;
    this.prices = {};               // { BTC: 97123.45, ETH: 3456.78, SOL: 189.12 }
    this._reconnects = 0;
    this._messagesReceived = 0;
    // Lag tracking — measure how far behind Chainlink is
    this._lastUpdateTs = {};        // { BTC: chainlinkTimestamp } — the oracle's own timestamp
    this._updateIntervals = {};     // { BTC: [interval1, interval2...] } — time between updates
    this._lagMs = {};               // { BTC: lagMs } — how far the oracle timestamp is behind now
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    _slog("[ChainlinkWS] Connecting to Polymarket RTDS...");
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE;
      this._reconnects = 0;
      _slog("[ChainlinkWS] Connected — subscribing to Chainlink prices");

      // Subscribe to Chainlink prices for all crypto assets
      this.ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: "",
          },
        ],
      }));

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
      _slog(`[ChainlinkWS] Disconnected (code ${code})`);
      this._scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      _slog(`[ChainlinkWS] Error: ${err.message}`);
    });
  }

  _handleMessage(msg) {
    // Handle both single updates and batch/history dumps
    if (msg.topic === "crypto_prices_chainlink") {
      const payload = msg.payload;
      if (!payload) return;

      // Single price update
      if (payload.symbol && payload.value != null) {
        this._updatePrice(payload.symbol, payload.value, payload.timestamp);
        return;
      }

      // Batch/array of prices (initial dump)
      if (Array.isArray(payload)) {
        for (const p of payload) {
          if (p.symbol && p.value != null) {
            this._updatePrice(p.symbol, p.value, p.timestamp);
          }
        }
      }
    }
  }

  _updatePrice(symbol, value, timestamp) {
    const asset = SYMBOL_MAP[symbol.toLowerCase()];
    if (!asset) return;

    const price = typeof value === "number" ? value : parseFloat(value);
    if (!price || isNaN(price)) return;

    const now = Date.now();

    // Track lag — how far Chainlink's own timestamp is behind wall clock
    if (timestamp) {
      const oracleTs = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
      if (oracleTs > 0) {
        this._lagMs[asset] = now - oracleTs;

        // Track update interval (time between Chainlink price changes)
        const prevTs = this._lastUpdateTs[asset];
        if (prevTs && oracleTs > prevTs) {
          if (!this._updateIntervals[asset]) this._updateIntervals[asset] = [];
          this._updateIntervals[asset].push(oracleTs - prevTs);
          // Keep last 10 intervals
          if (this._updateIntervals[asset].length > 10) this._updateIntervals[asset].shift();
        }
        this._lastUpdateTs[asset] = oracleTs;
      }
    }

    this.prices[asset] = price;
    this.lastDataTs = now;
    this._messagesReceived++;

    if (this.onPrices) {
      this.onPrices({ ...this.prices });
    }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this._reconnects++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this._reconnects - 1), RECONNECT_MAX);
    _slog(`[ChainlinkWS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this._reconnects})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  isLive() {
    return this.connected && (Date.now() - this.lastDataTs) < STALE_TIMEOUT;
  }

  // Average update interval for an asset (how often Chainlink publishes)
  getAvgInterval(asset) {
    const intervals = this._updateIntervals[asset];
    if (!intervals || intervals.length === 0) return null;
    return intervals.reduce((a, b) => a + b, 0) / intervals.length;
  }

  // Current lag in ms (how far behind wall clock the oracle price is)
  getLag(asset) {
    return this._lagMs[asset] || null;
  }

  getStats() {
    // Compute per-asset lag and update frequency
    const lagInfo = {};
    for (const asset of ["BTC", "ETH", "SOL"]) {
      const lag = this._lagMs[asset];
      const avgInterval = this.getAvgInterval(asset);
      if (lag != null || avgInterval != null) {
        lagInfo[asset] = {
          lagMs: lag || 0,
          lagSec: lag ? (lag / 1000).toFixed(1) : "--",
          avgIntervalMs: avgInterval || 0,
          avgIntervalSec: avgInterval ? (avgInterval / 1000).toFixed(1) : "--",
        };
      }
    }

    return {
      connected: this.connected,
      live: this.isLive(),
      lastDataTs: this.lastDataTs,
      prices: { ...this.prices },
      messagesReceived: this._messagesReceived,
      reconnects: this._reconnects,
      lag: lagInfo,
    };
  }

  close() {
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    _slog("[ChainlinkWS] Closed");
  }
}
