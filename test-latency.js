// PolyWhale Latency Test — Measures all data source speeds
// Usage: node test-latency.js

import WebSocket from "ws";

const TEST_DURATION = 20000; // 20 seconds
const results = {};

function track(name) {
  results[name] = { msgs: 0, firstTs: null, intervals: [], lastTs: null, connectTs: null, errors: [] };
  return results[name];
}

function recordMsg(r) {
  const now = Date.now();
  r.msgs++;
  if (!r.firstTs) r.firstTs = now;
  if (r.lastTs) r.intervals.push(now - r.lastTs);
  r.lastTs = now;
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function p50(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p99(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.99)];
}

// ─── 1. Binance WebSocket ─────────────────────────
function testBinanceWS() {
  const r = track("Binance WS");
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@miniTicker");
    const start = Date.now();
    r.connectTs = start;

    ws.on("open", () => {
      r.connectLatency = Date.now() - start;
      console.log(`  [Binance WS] Connected in ${r.connectLatency}ms`);
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.e === "24hrMiniTicker" || data.c) {
          recordMsg(r);
        }
      } catch {}
    });

    ws.on("error", (e) => r.errors.push(e.message));

    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve();
    }, TEST_DURATION);
  });
}

// ─── 2. Coinbase WebSocket ────────────────────────
function testCoinbaseWS() {
  const r = track("Coinbase WS");
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    const start = Date.now();
    r.connectTs = start;

    ws.on("open", () => {
      r.connectLatency = Date.now() - start;
      console.log(`  [Coinbase WS] Connected in ${r.connectLatency}ms`);
      ws.send(JSON.stringify({
        type: "subscribe",
        product_ids: ["BTC-USD"],
        channels: ["ticker"]
      }));
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "ticker") {
          recordMsg(r);
        }
      } catch {}
    });

    ws.on("error", (e) => r.errors.push(e.message));

    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve();
    }, TEST_DURATION);
  });
}

// ─── 3. Kraken WebSocket ──────────────────────────
function testKrakenWS() {
  const r = track("Kraken WS");
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://ws.kraken.com/v2");
    const start = Date.now();
    r.connectTs = start;

    ws.on("open", () => {
      r.connectLatency = Date.now() - start;
      console.log(`  [Kraken WS] Connected in ${r.connectLatency}ms`);
      // Kraken v2 WebSocket API format
      ws.send(JSON.stringify({
        method: "subscribe",
        params: {
          channel: "ticker",
          symbol: ["BTC/USD"]
        }
      }));
    });

    ws.on("message", (raw) => {
      try {
        const text = raw.toString();
        const data = JSON.parse(text);
        // Kraken v2 sends: { channel: "ticker", type: "update", data: [...] }
        if (data.channel === "ticker" && (data.type === "update" || data.type === "snapshot")) {
          recordMsg(r);
        }
        // Log first few messages for debugging
        if (r.msgs === 0 && !r._logged) {
          r._debugMsgs = r._debugMsgs || [];
          r._debugMsgs.push(text.substring(0, 200));
          if (r._debugMsgs.length >= 5) r._logged = true;
        }
      } catch {}
    });

    ws.on("error", (e) => r.errors.push(e.message));

    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve();
    }, TEST_DURATION);
  });
}

// ─── 4. Chainlink RTDS WebSocket (via Polymarket) ─
function testChainlinkWS() {
  const r = track("Chainlink RTDS");
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://ws-live-data.polymarket.com");
    const start = Date.now();
    r.connectTs = start;
    r._debugMsgs = [];

    ws.on("open", () => {
      r.connectLatency = Date.now() - start;
      console.log(`  [Chainlink WS] Connected in ${r.connectLatency}ms`);
      // Subscribe to Chainlink crypto prices (same as our chainlink-ws.js)
      ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{
          topic: "crypto_prices_chainlink",
          type: "*",
          filters: "",
        }],
      }));
      // Polymarket RTDS needs websocket ping keepalive
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 5000);

    ws.on("message", (raw) => {
      try {
        const text = raw.toString();
        const data = JSON.parse(text);

        if (r._debugMsgs.length < 10) {
          r._debugMsgs.push(text.substring(0, 300));
        }

        // Polymarket RTDS format: { topic: "crypto_prices_chainlink", payload: { symbol, value, timestamp } }
        if (data.topic === "crypto_prices_chainlink") {
          recordMsg(r);
        }
      } catch {}
    });

    ws.on("error", (e) => r.errors.push(e.message));

    setTimeout(() => {
      clearInterval(pingInterval);
      try { ws.close(); } catch {}
      resolve();
    }, TEST_DURATION);
  });
}

// ─── 5. Polymarket CLOB WebSocket ─────────────────
function testPolyClobWS() {
  const r = track("PolyCLOB WS");
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    const start = Date.now();
    r.connectTs = start;
    r._eventTypes = {};

    ws.on("open", () => {
      r.connectLatency = Date.now() - start;
      console.log(`  [PolyCLOB WS] Connected in ${r.connectLatency}ms`);

      // Subscribe to a known active BTC daily token (from our bot's markets)
      // We'll use multiple tokens for better coverage
      // First try to get tokens from our running bot
      fetchActiveTokens().then(tokens => {
        if (tokens.length > 0) {
          ws.send(JSON.stringify({
            assets_ids: tokens,
            type: "market",
            custom_feature_enabled: true,
          }));
          console.log(`  [PolyCLOB WS] Subscribed to ${tokens.length} tokens`);
        } else {
          console.log("  [PolyCLOB WS] No tokens found, subscribing to known BTC market");
          // Fallback to known active market tokens
          ws.send(JSON.stringify({
            assets_ids: ["21742633143463906290569050155826241533067272736897614950488156847949938836455"],
            type: "market",
            custom_feature_enabled: true,
          }));
        }
      });
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text === "PONG") return;
      try {
        const data = JSON.parse(text);
        const events = Array.isArray(data) ? data : [data];
        for (const ev of events) {
          const type = ev.event_type || "unknown";
          r._eventTypes[type] = (r._eventTypes[type] || 0) + 1;
          recordMsg(r);
        }
      } catch {}
    });

    // Send PING keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);

    ws.on("error", (e) => r.errors.push(e.message));

    setTimeout(() => {
      clearInterval(pingInterval);
      try { ws.close(); } catch {}
      resolve();
    }, TEST_DURATION);
  });
}

// Fetch live token IDs from Gamma API for active crypto markets
async function fetchActiveTokens() {
  try {
    // Try multiple known active market slugs
    const slugs = [
      "bitcoin-up-or-down-on-february-15",
      "ethereum-up-or-down-on-february-15",
      "solana-up-or-down-on-february-15",
    ];
    const tokens = [];
    for (const slug of slugs) {
      try {
        const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          let ids = data[0].clobTokenIds;
          if (typeof ids === "string") ids = JSON.parse(ids);
          if (Array.isArray(ids)) tokens.push(...ids);
        }
      } catch {}
    }
    console.log(`  [PolyCLOB WS] Found ${tokens.length} tokens from Gamma API`);
    return tokens;
  } catch {
    return [];
  }
}

// ─── 6. HTTP Endpoints ────────────────────────────
async function testHTTP(name, url, parseResponse) {
  const r = track(name);
  const latencies = [];

  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      const res = await fetch(url);
      const elapsed = Date.now() - start;
      if (res.ok) {
        const data = await res.json();
        latencies.push(elapsed);
        recordMsg(r);
        if (parseResponse) parseResponse(data, r, i);
      } else {
        r.errors.push(`HTTP ${res.status}`);
      }
    } catch (e) {
      r.errors.push(e.message);
    }
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  r.httpLatencies = latencies;
  r.httpAvg = avg(latencies);
  r.httpMin = latencies.length > 0 ? Math.min(...latencies) : 0;
  r.httpMax = latencies.length > 0 ? Math.max(...latencies) : 0;
}

// ─── Run All Tests ────────────────────────────────
async function main() {
  console.log("=== PolyWhale Latency Test ===");
  console.log(`Duration: ${TEST_DURATION / 1000}s per WebSocket test`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  // Run all WebSocket tests in parallel
  console.log("--- WebSocket Tests (parallel) ---");
  await Promise.all([
    testBinanceWS(),
    testCoinbaseWS(),
    testKrakenWS(),
    testChainlinkWS(),
    testPolyClobWS(),
  ]);

  console.log("\n--- HTTP Tests (sequential) ---");

  // Gamma API
  await testHTTP("Gamma API", "https://gamma-api.polymarket.com/markets?slug=bitcoin-up-or-down-on-february-15", (data, r, i) => {
    if (i === 0 && Array.isArray(data)) console.log(`  [Gamma API] ${data.length} markets returned`);
  });

  // CLOB Midpoints
  await testHTTP("CLOB Midpoints", "https://clob.polymarket.com/midpoints", (data, r, i) => {
    if (i === 0) console.log(`  [CLOB Midpoints] Response received`);
  });

  // Binance HTTP
  await testHTTP("Binance HTTP", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (data, r, i) => {
    if (i === 0) console.log(`  [Binance HTTP] BTC: $${data.price}`);
  });

  // Coinbase HTTP
  await testHTTP("Coinbase HTTP", "https://api.exchange.coinbase.com/products/BTC-USD/ticker", (data, r, i) => {
    if (i === 0) console.log(`  [Coinbase HTTP] BTC: $${data.price}`);
  });

  // Print results
  console.log("\n\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              LATENCY TEST RESULTS                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  for (const [name, r] of Object.entries(results)) {
    console.log(`── ${name} ──`);

    if (r.connectLatency !== undefined) {
      console.log(`  Connect:    ${r.connectLatency}ms`);
    }

    if (r.httpLatencies) {
      // HTTP endpoint
      console.log(`  Requests:   ${r.msgs} successful / 5 attempted`);
      console.log(`  Avg:        ${r.httpAvg.toFixed(0)}ms`);
      console.log(`  Min/Max:    ${r.httpMin}ms / ${r.httpMax}ms`);
      if (r.httpLatencies.length > 0) {
        console.log(`  All:        [${r.httpLatencies.join(", ")}]ms`);
      }
    } else {
      // WebSocket
      console.log(`  Messages:   ${r.msgs}`);
      if (r.firstTs && r.connectTs) {
        console.log(`  First data: ${r.firstTs - r.connectTs}ms after connect`);
      }
      if (r.intervals.length > 0) {
        console.log(`  Avg interval: ${avg(r.intervals).toFixed(0)}ms`);
        console.log(`  P50 interval: ${p50(r.intervals).toFixed(0)}ms`);
        console.log(`  P99 interval: ${p99(r.intervals).toFixed(0)}ms`);
        console.log(`  Min/Max:      ${Math.min(...r.intervals)}ms / ${Math.max(...r.intervals)}ms`);
      }
    }

    if (r._eventTypes && Object.keys(r._eventTypes).length > 0) {
      console.log(`  Event types: ${JSON.stringify(r._eventTypes)}`);
    }

    if (r._debugMsgs && r._debugMsgs.length > 0 && r.msgs === 0) {
      console.log(`  Debug (first msgs):`);
      for (const m of r._debugMsgs.slice(0, 3)) {
        console.log(`    ${m}`);
      }
    }

    if (r.errors.length > 0) {
      console.log(`  Errors: ${r.errors.slice(0, 3).join(", ")}`);
    }

    console.log("");
  }

  // Summary table
  console.log("── SUMMARY ──");
  console.log("Source               | Type | Msgs | Avg Interval | Connect");
  console.log("---------------------|------|------|-------------|--------");
  for (const [name, r] of Object.entries(results)) {
    const type = r.httpLatencies ? "HTTP" : "WS";
    const avgInt = r.httpLatencies
      ? `${r.httpAvg.toFixed(0)}ms/req`
      : r.intervals.length > 0
        ? `${avg(r.intervals).toFixed(0)}ms`
        : "--";
    const conn = r.connectLatency !== undefined ? `${r.connectLatency}ms` : "--";
    console.log(`${name.padEnd(20)} | ${type.padEnd(4)} | ${String(r.msgs).padEnd(4)} | ${avgInt.padEnd(11)} | ${conn}`);
  }

  process.exit(0);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
