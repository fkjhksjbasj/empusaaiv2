// Binance WebSocket client — real-time BTC/ETH/SOL prices
// Uses miniTicker stream for ~1s updates with minimal bandwidth

import WebSocket from "ws";

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

const STREAMS = "btcusdt@miniTicker/ethusdt@miniTicker/solusdt@miniTicker";

// Fallback endpoints for geo-blocked regions (451 = US IP blocked by binance.com)
const ENDPOINTS = [
  { name: "Binance Global", url: `wss://stream.binance.com/ws/${STREAMS}`, type: "binance" },
  { name: "Binance US",     url: `wss://stream.binance.us/ws/${STREAMS}`, type: "binance" },
  { name: "Bybit",          url: `wss://stream.bybit.com/v5/public/spot`, type: "bybit" },
];

const RECONNECT_BASE = 1000;   // 1s initial reconnect delay
const RECONNECT_MAX = 30000;   // 30s max backoff
const PING_INTERVAL = 30000;   // 30s keep-alive ping
const STALE_TIMEOUT = 10000;   // 10s without data = stale
const GEO_BLOCK_THRESHOLD = 3; // switch endpoint after N consecutive 451/blocked failures

const SYMBOL_MAP = {
  BTCUSDT: "BTC",
  ETHUSDT: "ETH",
  SOLUSDT: "SOL",
};

export class BinanceWS {
  constructor(onPrices) {
    this.onPrices = onPrices;       // callback: (prices) => void
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = RECONNECT_BASE;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastDataTs = 0;
    this.prices = {};               // { BTC: 97123.45, ETH: 3456.78, SOL: 189.12 }
    this._prevQuoteVol = {};        // previous cumulative quote volume (for delta)
    this._tickVol = {};             // { BTC: 1234.5 } USDT volume per tick
    this._reconnects = 0;
    this._messagesReceived = 0;
    this._endpointIdx = 0;          // current endpoint index
    this._consecutiveFails = 0;     // consecutive failures on current endpoint
    this._geoBlocked = new Set();   // endpoints known to be geo-blocked
  }

  _getEndpoint() {
    return ENDPOINTS[this._endpointIdx];
  }

  _switchEndpoint() {
    const old = ENDPOINTS[this._endpointIdx].name;
    this._geoBlocked.add(this._endpointIdx);
    // Find next non-blocked endpoint
    for (let i = 0; i < ENDPOINTS.length; i++) {
      const next = (this._endpointIdx + 1 + i) % ENDPOINTS.length;
      if (!this._geoBlocked.has(next)) {
        this._endpointIdx = next;
        this._consecutiveFails = 0;
        _slog(`[BinanceWS] ${old} geo-blocked, switching to ${ENDPOINTS[next].name}`);
        return true;
      }
    }
    // All blocked — clear and cycle (maybe network changed)
    this._geoBlocked.clear();
    this._endpointIdx = (this._endpointIdx + 1) % ENDPOINTS.length;
    this._consecutiveFails = 0;
    _slog(`[BinanceWS] All endpoints blocked, retrying from ${ENDPOINTS[this._endpointIdx].name}`);
    return true;
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const ep = this._getEndpoint();
    _slog(`[BinanceWS] Connecting to ${ep.name} (${ep.url.slice(0, 55)}...)`);
    this.ws = new WebSocket(ep.url);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE;
      this._reconnects = 0;
      this._consecutiveFails = 0;

      if (ep.type === "bybit") {
        // Bybit requires explicit subscription after connect
        const sub = { op: "subscribe", args: ["tickers.BTCUSDT", "tickers.ETHUSDT", "tickers.SOLUSDT"] };
        this.ws.send(JSON.stringify(sub));
        _slog(`[BinanceWS] Connected to Bybit — subscribing BTC/ETH/SOL`);
      } else {
        _slog(`[BinanceWS] Connected to ${ep.name} — streaming BTC/ETH/SOL`);
      }
      this._startPing();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (ep.type === "bybit") {
          this._handleBybitTicker(msg);
        } else {
          this._handleTicker(msg);
        }
      } catch {}
    });

    this.ws.on("close", (code) => {
      this.connected = false;
      this._stopPing();
      _slog(`[BinanceWS] Disconnected (code ${code})`);
      this._scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      const msg = err.message || "";
      _slog(`[BinanceWS] Error: ${msg}`);
      // 451 = geo-blocked, 403 = forbidden — switch endpoint immediately
      if (msg.includes("451") || msg.includes("403")) {
        this._consecutiveFails++;
        if (this._consecutiveFails >= GEO_BLOCK_THRESHOLD) {
          this._switchEndpoint();
        }
      }
    });
  }

  _handleTicker(msg) {
    // miniTicker fields: s=symbol, c=close, o=open, h=high, l=low, v=base vol, q=quote vol
    const symbol = msg.s;
    const asset = SYMBOL_MAP[symbol];
    if (!asset) return;

    const price = parseFloat(msg.c);
    if (!price || isNaN(price)) return;

    // Compute tick volume from cumulative quote volume delta
    const quoteVol = parseFloat(msg.q) || 0;
    const prev = this._prevQuoteVol[asset] || quoteVol;
    const tickVol = Math.max(0, quoteVol - prev);
    this._prevQuoteVol[asset] = quoteVol;
    this._tickVol[asset] = tickVol;

    this.prices[asset] = price;
    this.lastDataTs = Date.now();
    this._messagesReceived++;

    // Fire callback with price + volume data
    if (this.onPrices) {
      const data = {};
      for (const [a, p] of Object.entries(this.prices)) {
        data[a] = { price: p, vol: this._tickVol[a] || 0 };
      }
      this.onPrices(data);
    }
  }

  _handleBybitTicker(msg) {
    // Bybit v5 tickers: { topic: "tickers.BTCUSDT", data: { symbol, lastPrice, volume24h, ... } }
    if (!msg.data || !msg.topic) return;
    const symbol = msg.data.symbol;
    const asset = SYMBOL_MAP[symbol];
    if (!asset) return;

    const price = parseFloat(msg.data.lastPrice);
    if (!price || isNaN(price)) return;

    const quoteVol = parseFloat(msg.data.turnover24h) || 0;
    const prev = this._prevQuoteVol[asset] || quoteVol;
    const tickVol = Math.max(0, quoteVol - prev);
    this._prevQuoteVol[asset] = quoteVol;
    this._tickVol[asset] = tickVol;

    this.prices[asset] = price;
    this.lastDataTs = Date.now();
    this._messagesReceived++;

    if (this.onPrices) {
      const data = {};
      for (const [a, p] of Object.entries(this.prices)) {
        data[a] = { price: p, vol: this._tickVol[a] || 0 };
      }
      this.onPrices(data);
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
    _slog(`[BinanceWS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this._reconnects})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  isLive() {
    return this.connected && (Date.now() - this.lastDataTs) < STALE_TIMEOUT;
  }

  getStats() {
    return {
      connected: this.connected,
      live: this.isLive(),
      lastDataTs: this.lastDataTs,
      prices: { ...this.prices },
      messagesReceived: this._messagesReceived,
      reconnects: this._reconnects,
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
    _slog("[BinanceWS] Closed");
  }
}
