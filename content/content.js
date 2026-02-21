// PolyWhale — Content Script (Real-time data pipeline)
// Runs on polymarket.com — two data sources:
// 1. Binance WebSocket → real-time BTC/ETH/SOL spot prices (<100ms latency)
// 2. DOM scraping → real-time Polymarket contract prices (Up/Down cents)
// Relays everything to service worker for instant signal processing

(() => {
  const BINANCE_WS_URL = "wss://stream.binance.com/ws/btcusdt@miniTicker/ethusdt@miniTicker/solusdt@miniTicker";
  const SCRAPE_INTERVAL = 1500;  // DOM scrape every 1.5s
  const RELAY_THROTTLE = 800;    // Relay to SW max every 800ms
  const RECONNECT_DELAY = 3000;

  let ws = null;
  let lastRelay = 0;
  let prices = { BTC: 0, ETH: 0, SOL: 0 };
  let wsConnected = false;

  // ─── Binance WebSocket ──────────────────────────
  function connectBinance() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;

    try {
      ws = new WebSocket(BINANCE_WS_URL);

      ws.onopen = () => {
        wsConnected = true;
        console.log("[PolyWhale] Binance WS connected");
        send({ type: "LIVE_STATUS", binance: true });
      };

      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          const p = parseFloat(d.c); // c = close price
          if (!p || p <= 0) return;
          if (d.s === "BTCUSDT") prices.BTC = p;
          else if (d.s === "ETHUSDT") prices.ETH = p;
          else if (d.s === "SOLUSDT") prices.SOL = p;
          maybeRelay();
        } catch {}
      };

      ws.onclose = () => {
        wsConnected = false;
        console.log("[PolyWhale] Binance WS closed — reconnecting");
        setTimeout(connectBinance, RECONNECT_DELAY);
      };

      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch (e) {
      console.warn("[PolyWhale] Binance WS failed:", e);
      setTimeout(connectBinance, RECONNECT_DELAY * 2);
    }
  }

  // ─── DOM Scraping ───────────────────────────────
  // Extracts prices from Polymarket's React UI
  function scrapePage() {
    const result = { main: null, sidebar: [] };

    try {
      // --- Main market: find "Up XX¢" and "Down XX¢" buttons ---
      const buttons = document.querySelectorAll("button, [role='button']");
      let upCents = 0, downCents = 0;

      for (const btn of buttons) {
        const t = btn.textContent.trim();
        let m;
        // "Up 47¢" or "Up47¢"
        m = t.match(/Up\s*(\d+)\s*¢/i);
        if (m) { upCents = parseInt(m[1]); continue; }
        // "Up $0.47"
        m = t.match(/Up\s*\$?(0?\.\d+)/i);
        if (m) { upCents = Math.round(parseFloat(m[1]) * 100); continue; }
        // "Down 54¢"
        m = t.match(/Down\s*(\d+)\s*¢/i);
        if (m) { downCents = parseInt(m[1]); continue; }
        // "Down $0.54"
        m = t.match(/Down\s*\$?(0?\.\d+)/i);
        if (m) { downCents = Math.round(parseFloat(m[1]) * 100); continue; }
      }

      if (upCents > 0 || downCents > 0) {
        // Identify asset from URL + title
        const url = window.location.pathname;
        const title = document.title || "";
        const ctx = url + " " + title;

        let asset = null;
        if (/bitcoin|btc/i.test(ctx)) asset = "BTC";
        else if (/ethereum|eth/i.test(ctx)) asset = "ETH";
        else if (/solana|sol/i.test(ctx)) asset = "SOL";

        let timeframe = null;
        if (url.includes("-5m-") || /5.min/i.test(ctx)) timeframe = "5m";
        else if (url.includes("-15m-") || /15.min/i.test(ctx)) timeframe = "15m";
        else if (url.includes("-1h-") || /1.hour/i.test(ctx)) timeframe = "1h";
        else if (url.includes("-1d-") || /1.day|daily/i.test(ctx)) timeframe = "1d";

        // Extract current price + target from visible text
        let currentPrice = 0, targetPrice = 0, secsLeft = 0;
        const textChunk = document.body?.innerText?.slice(0, 3000) || "";

        const cpM = textChunk.match(/CURRENT PRICE[^$]*\$([\d,]+\.?\d*)/i);
        if (cpM) currentPrice = parseFloat(cpM[1].replace(/,/g, ""));

        const tpM = textChunk.match(/PRICE TO BEAT[^$]*\$([\d,]+\.?\d*)/i);
        if (tpM) targetPrice = parseFloat(tpM[1].replace(/,/g, ""));

        const cdM = textChunk.match(/(\d+)\s*MINS?\s+(\d+)\s*SECS?/i);
        if (cdM) secsLeft = parseInt(cdM[1]) * 60 + parseInt(cdM[2]);

        result.main = {
          asset, timeframe,
          yesPrice: upCents / 100,
          noPrice: downCents / 100,
          currentPrice, targetPrice, secsLeft,
        };
      }

      // --- Sidebar: "Ethereum Up or Down - 1 hour • 34% Up" ---
      const elements = document.querySelectorAll("a, div, span, p");
      const seen = new Set();

      for (const el of elements) {
        const t = el.textContent.trim();
        if (t.length > 200 || t.length < 15) continue;

        const coinM = t.match(/(Bitcoin|Ethereum|Solana)\s+Up or Down\s*[-–—]\s*(5 Min|15 Min|1 Hour|1 Day)/i);
        if (!coinM) continue;

        const pctM = t.match(/(\d+)\s*%\s*(Up|Down)/i);
        if (!pctM) continue;

        let asset = null;
        if (/bitcoin/i.test(coinM[1])) asset = "BTC";
        else if (/ethereum/i.test(coinM[1])) asset = "ETH";
        else if (/solana/i.test(coinM[1])) asset = "SOL";

        let timeframe = null;
        if (/5 min/i.test(coinM[2])) timeframe = "5m";
        else if (/15 min/i.test(coinM[2])) timeframe = "15m";
        else if (/1 hour/i.test(coinM[2])) timeframe = "1h";
        else if (/1 day/i.test(coinM[2])) timeframe = "1d";

        const key = `${asset}-${timeframe}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const pct = parseInt(pctM[1]) / 100;
        const isUp = /up/i.test(pctM[2]);

        result.sidebar.push({
          asset, timeframe,
          yesPrice: isUp ? pct : 1 - pct,
          noPrice: isUp ? 1 - pct : pct,
        });
      }
    } catch (e) {
      console.warn("[PolyWhale] Scrape error:", e);
    }

    return result;
  }

  // ─── Throttled relay to service worker ──────────
  function maybeRelay() {
    const now = Date.now();
    if (now - lastRelay < RELAY_THROTTLE) return;
    lastRelay = now;
    doRelay();
  }

  function doRelay() {
    const dom = scrapePage();
    send({
      type: "LIVE_PRICES",
      binance: { ...prices },
      dom,
      ts: Date.now(),
      url: window.location.href,
      wsConnected,
    });
  }

  function send(msg) {
    try {
      if (!chrome.runtime?.id) return; // Extension context invalidated
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) {} // ignore
      });
    } catch {}
  }

  // ─── Periodic scrape (more reliable than MutationObserver for React) ──
  setInterval(doRelay, SCRAPE_INTERVAL);

  // ─── SPA navigation detection ──────────────────
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("[PolyWhale] SPA nav:", lastUrl);
      setTimeout(doRelay, 1000); // Let React render
    }
  }).observe(document, { subtree: true, childList: true });

  // ─── Init ──────────────────────────────────────
  connectBinance();
  setTimeout(doRelay, 2000); // Initial scrape after React renders
  console.log("[PolyWhale] Real-time pipeline active");
  send({ type: "CONTENT_READY", url: location.href });
})();
