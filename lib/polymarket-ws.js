// Polymarket CLOB WebSocket — Live UP/DOWN token prices
// Connects to the public market channel for real-time price updates (~100ms latency)
// Replaces 15s HTTP polling with streaming data
// No authentication required

import WebSocket from "ws";

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL = 10000;   // 10s — Polymarket requires text "PING" keepalive
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;
const STALE_TIMEOUT = 30000;   // 30s without data = stale

export class PolymarketWS {
  constructor(onPriceUpdate) {
    this.onPriceUpdate = onPriceUpdate;  // (tokenId, price, book) => void
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = RECONNECT_BASE;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastDataTs = 0;
    this._reconnects = 0;
    this._messagesReceived = 0;
    this._priceChanges = 0;

    // Token IDs currently subscribed to
    this._subscribedIds = new Set();
    // Pending subscriptions (queued before connection is open)
    this._pendingIds = [];
    // Live prices: tokenId → { mid, bestBid, bestAsk, spread, lastTrade, ts }
    this.prices = {};
    // Orderbooks: tokenId → { bids, asks }
    this.books = {};
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    _slog("[PolymarketWS] Connecting to CLOB market channel...");
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE;
      this._reconnects = 0;
      _slog("[PolymarketWS] Connected — subscribing to market data");

      // Subscribe to any pending token IDs
      if (this._pendingIds.length > 0) {
        this._sendSubscribe(this._pendingIds);
        this._pendingIds = [];
      }
      // Re-subscribe to previously subscribed tokens (on reconnect)
      if (this._subscribedIds.size > 0) {
        this._sendSubscribe([...this._subscribedIds]);
      }

      this._startPing();
    });

    this.ws.on("message", (raw) => {
      const text = raw.toString();
      if (text === "PONG") return;

      try {
        const data = JSON.parse(text);
        this._messagesReceived++;
        this.lastDataTs = Date.now();

        // Messages may arrive as arrays
        const events = Array.isArray(data) ? data : [data];
        for (const event of events) {
          this._handleEvent(event);
        }
      } catch {}
    });

    this.ws.on("close", (code) => {
      this.connected = false;
      this._stopPing();
      _slog(`[PolymarketWS] Disconnected (code ${code})`);
      this._scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      _slog(`[PolymarketWS] Error: ${err.message}`);
    });
  }

  _handleEvent(event) {
    switch (event.event_type) {
      case "book":
        this._handleBook(event);
        break;
      case "price_change":
        this._handlePriceChange(event);
        break;
      case "last_trade_price":
        this._handleLastTrade(event);
        break;
      case "best_bid_ask":
        this._handleBestBidAsk(event);
        break;
    }
  }

  // Full orderbook snapshot — arrives on initial subscribe
  _handleBook(event) {
    const tokenId = event.asset_id;
    if (!tokenId) return;

    const bids = (event.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (event.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    this.books[tokenId] = { bids, asks };

    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;

    // Calculate depth ($ within 2% of best)
    let bidDepth = 0, askDepth = 0;
    for (const b of bids) {
      const p = parseFloat(b.price);
      if (p >= bestBid * 0.98) bidDepth += parseFloat(b.size) * p;
    }
    for (const a of asks) {
      const p = parseFloat(a.price);
      if (p <= bestAsk * 1.02) askDepth += parseFloat(a.size) * p;
    }

    this.prices[tokenId] = {
      mid, bestBid, bestAsk, spread,
      bidDepth, askDepth,
      lastTrade: this.prices[tokenId]?.lastTrade || mid,
      ts: Date.now(),
    };

    if (this.onPriceUpdate) this.onPriceUpdate(tokenId, mid, this.prices[tokenId]);
  }

  // Incremental price change — best bid/ask included
  _handlePriceChange(event) {
    if (!event.price_changes) return;
    this._priceChanges++;

    for (const pc of event.price_changes) {
      const tokenId = pc.asset_id;
      if (!tokenId) continue;

      const bestBid = pc.best_bid ? parseFloat(pc.best_bid) : (this.prices[tokenId]?.bestBid || 0);
      const bestAsk = pc.best_ask ? parseFloat(pc.best_ask) : (this.prices[tokenId]?.bestAsk || 0);
      const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
      const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;

      const existing = this.prices[tokenId] || {};
      this.prices[tokenId] = {
        mid, bestBid, bestAsk, spread,
        bidDepth: existing.bidDepth || 0,
        askDepth: existing.askDepth || 0,
        lastTrade: existing.lastTrade || mid,
        ts: Date.now(),
      };

      if (this.onPriceUpdate) this.onPriceUpdate(tokenId, mid, this.prices[tokenId]);
    }
  }

  // Trade execution — gives us last traded price
  _handleLastTrade(event) {
    const tokenId = event.asset_id;
    if (!tokenId) return;

    const price = parseFloat(event.price);
    if (!price || isNaN(price)) return;

    if (!this.prices[tokenId]) {
      this.prices[tokenId] = { mid: price, bestBid: 0, bestAsk: 0, spread: 0, bidDepth: 0, askDepth: 0, lastTrade: price, ts: Date.now() };
    } else {
      this.prices[tokenId].lastTrade = price;
      this.prices[tokenId].ts = Date.now();
    }

    if (this.onPriceUpdate) this.onPriceUpdate(tokenId, this.prices[tokenId].mid, this.prices[tokenId]);
  }

  // Simplified best bid/ask event (requires custom_feature_enabled)
  _handleBestBidAsk(event) {
    const tokenId = event.asset_id;
    if (!tokenId) return;

    const bestBid = parseFloat(event.best_bid) || 0;
    const bestAsk = parseFloat(event.best_ask) || 0;
    const spread = parseFloat(event.spread) || (bestAsk - bestBid);
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

    const existing = this.prices[tokenId] || {};
    this.prices[tokenId] = {
      mid, bestBid, bestAsk, spread,
      bidDepth: existing.bidDepth || 0,
      askDepth: existing.askDepth || 0,
      lastTrade: existing.lastTrade || mid,
      ts: Date.now(),
    };

    if (this.onPriceUpdate) this.onPriceUpdate(tokenId, mid, this.prices[tokenId]);
  }

  // ─── Subscription Management ──────────────────────

  // Subscribe to token IDs for live prices
  subscribe(tokenIds) {
    const newIds = tokenIds.filter(id => !this._subscribedIds.has(id));
    if (newIds.length === 0) return;

    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe(newIds);
    } else {
      // Queue for when connection opens
      this._pendingIds.push(...newIds);
    }
  }

  // Unsubscribe from token IDs
  unsubscribe(tokenIds) {
    const toRemove = tokenIds.filter(id => this._subscribedIds.has(id));
    if (toRemove.length === 0) return;

    for (const id of toRemove) this._subscribedIds.delete(id);

    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: toRemove,
        operation: "unsubscribe",
      }));
    }
  }

  _sendSubscribe(tokenIds) {
    if (this._subscribedIds.size === 0) {
      // First subscription — use initial format
      this.ws.send(JSON.stringify({
        assets_ids: tokenIds,
        type: "market",
        custom_feature_enabled: true,
      }));
    } else {
      // Dynamic add — use subscribe operation
      this.ws.send(JSON.stringify({
        assets_ids: tokenIds,
        operation: "subscribe",
      }));
    }

    for (const id of tokenIds) this._subscribedIds.add(id);
    _slog(`[PolymarketWS] Subscribed to ${tokenIds.length} tokens (${this._subscribedIds.size} total)`);
  }

  // ─── Keepalive ────────────────────────────────────

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Polymarket requires literal text "PING", not WebSocket ping frame
        this.ws.send("PING");
      }
    }, PING_INTERVAL);
  }

  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this._reconnects++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this._reconnects - 1), RECONNECT_MAX);
    _slog(`[PolymarketWS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this._reconnects})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ─── Getters ──────────────────────────────────────

  // Get live midpoint price for a token
  getMid(tokenId) {
    const p = this.prices[tokenId];
    if (!p || Date.now() - p.ts > STALE_TIMEOUT) return null;
    return p.mid;
  }

  // Get full live price data for a token
  getPrice(tokenId) {
    return this.prices[tokenId] || null;
  }

  isLive() {
    return this.connected && (Date.now() - this.lastDataTs) < STALE_TIMEOUT;
  }

  getStats() {
    return {
      connected: this.connected,
      live: this.isLive(),
      subscriptions: this._subscribedIds.size,
      pricesTracked: Object.keys(this.prices).length,
      messagesReceived: this._messagesReceived,
      priceChanges: this._priceChanges,
      reconnects: this._reconnects,
    };
  }

  close() {
    this._stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.removeAllListeners(); try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
    _slog("[PolymarketWS] Closed");
  }
}
