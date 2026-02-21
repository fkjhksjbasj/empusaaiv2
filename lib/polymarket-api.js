// Polymarket API — Node.js direct (no proxy, no CORS)
// Fetches 5m / 15m / 1h / 1d BTC/ETH/SOL up-down markets

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const FETCH_TIMEOUT = 8000;
const BATCH_SIZE = 6;

// Fetch with AbortController timeout
function timedFetch(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function batchSettled(fns, size = BATCH_SIZE) {
  const results = [];
  for (let i = 0; i < fns.length; i += size) {
    const batch = fns.slice(i, i + size).map(fn => fn());
    const settled = await Promise.allSettled(batch);
    results.push(...settled);
  }
  return results;
}

// ─── Cache ──────────────────────────────────────
const cache = new Map();
function cached(key, ttlMs, fn) {
  const e = cache.get(key);
  if (e && Date.now() - e.ts < ttlMs) return Promise.resolve(e.data);
  return fn().then(d => { cache.set(key, { data: d, ts: Date.now() }); return d; });
}

// ─── Event slug generator ────────────────────────
const COINS_SHORT = ["btc", "eth", "sol"];
const COINS_FULL = ["bitcoin", "ethereum", "solana"];
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function getUpDownEventSlugs() {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const slugs = [];

  // 1. Short-timeframe: btc-updown-{5m|15m}-{timestamp} (working format)
  // Generate current + next window so bot can see upcoming markets early
  for (const tf of [{ label: "5m", seconds: 300 }, { label: "15m", seconds: 900 }]) {
    const currentStart = Math.floor(nowSec / tf.seconds) * tf.seconds;
    const nextStart = currentStart + tf.seconds;
    for (const coin of COINS_SHORT) {
      slugs.push(`${coin}-updown-${tf.label}-${currentStart}`);
      slugs.push(`${coin}-updown-${tf.label}-${nextStart}`);
    }
  }

  // 2. 4h blocks: btc-updown-4h-{timestamp}
  const fourH = 14400;
  const fourHStart = Math.floor(nowSec / fourH) * fourH;
  for (const coin of COINS_SHORT) {
    slugs.push(`${coin}-updown-4h-${fourHStart}`);
  }

  // 3. Hourly markets: bitcoin-up-or-down-{month}-{day}-{hour}{am|pm}-et
  //    These are named by the END hour in ET (UTC-5 during EST / UTC-4 during EDT)
  const etOffset = isDST(now) ? -4 : -5;
  const etNow = new Date(now.getTime() + etOffset * 3600000);
  const etMonth = MONTHS[etNow.getUTCMonth()];
  const etDay = etNow.getUTCDate();
  const etHour = etNow.getUTCHours();

  // Generate current hour, next 2 hours, and previous hour (in case market just started)
  for (let offset = -1; offset <= 2; offset++) {
    let h = etHour + offset;
    let d = etDay;
    if (h < 0) { h += 24; d -= 1; }
    if (h >= 24) { h -= 24; d += 1; }
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = h % 12 || 12;
    for (const coin of COINS_FULL) {
      slugs.push(`${coin}-up-or-down-${etMonth}-${d}-${h12}${ampm}-et`);
    }
  }

  // 4. Daily markets: bitcoin-up-or-down-on-{month}-{day}
  //    Generate for today and tomorrow (UTC dates since Poly uses 17:00 UTC end)
  const utcMonth = MONTHS[now.getUTCMonth()];
  const utcDay = now.getUTCDate();
  const tomorrow = new Date(now.getTime() + 86400000);
  const tomorrowMonth = MONTHS[tomorrow.getUTCMonth()];
  const tomorrowDay = tomorrow.getUTCDate();
  for (const coin of COINS_FULL) {
    slugs.push(`${coin}-up-or-down-on-${utcMonth}-${utcDay}`);
    slugs.push(`${coin}-up-or-down-on-${tomorrowMonth}-${tomorrowDay}`);
  }

  return slugs;
}

// Simple DST check for US Eastern
function isDST(date) {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  const stdOffset = Math.max(jan, jul);
  return date.getTimezoneOffset() < stdOffset;
}

function extractMarkets(eventResults, seen, allMarkets) {
  for (const r of eventResults) {
    if (r.status !== "fulfilled") continue;
    const events = Array.isArray(r.value) ? r.value : [r.value];
    for (const event of events) {
      if (!event || !event.markets) continue;
      for (const m of event.markets) {
        const id = m.condition_id || m.conditionId;
        if (id && !seen.has(id)) {
          seen.add(id);
          if (!m.events || m.events.length === 0) {
            m.events = [{ slug: event.slug, title: event.title }];
          }
          allMarkets.push(m);
        }
      }
    }
  }
}

// ─── Markets ─────────────────────────────────────
export async function fetchCryptoMarkets() {
  return cached("crypto_all", 12000, async () => {
    const eventSlugs = getUpDownEventSlugs();
    _slog(`[API] Fetching ${eventSlugs.length} event slugs (batch ×${BATCH_SIZE})`);

    const eventResults = await batchSettled(
      eventSlugs.map(slug => () =>
        timedFetch(`${GAMMA_API}/events?slug=${slug}`)
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
      )
    );

    const seen = new Set();
    const allMarkets = [];
    extractMarkets(eventResults, seen, allMarkets);
    _slog(`[API] ${allMarkets.length} markets from ${eventSlugs.length} slugs`);

    // Fallback: tag-based search
    if (allMarkets.length < 6) {
      try {
        const tags = ["5M", "15M", "hourly", "daily"];
        const tagResults = await batchSettled(
          tags.map(tag => () =>
            timedFetch(`${GAMMA_API}/events?closed=false&limit=20&tag=${tag}`)
              .then(r => r.ok ? r.json() : [])
              .catch(() => [])
          )
        );
        const cryptoRe = /\bbitcoin\b|\bbtc\b|\bethereum\b|\beth\b|\bsolana\b|\bsol\b/i;
        for (const r of tagResults) {
          if (r.status !== "fulfilled") continue;
          const events = Array.isArray(r.value) ? r.value : [r.value];
          for (const event of events) {
            if (!event) continue;
            const title = (event.title || "").toLowerCase();
            if (!cryptoRe.test(title) && !title.includes("up or down")) continue;
            if (!event.markets) continue;
            for (const m of event.markets) {
              const id = m.condition_id || m.conditionId;
              if (id && !seen.has(id)) {
                seen.add(id);
                if (!m.events || m.events.length === 0) {
                  m.events = [{ slug: event.slug, title: event.title }];
                }
                allMarkets.push(m);
              }
            }
          }
        }
        _slog(`[API] After tag fallback: ${allMarkets.length} total`);
      } catch (e) {
        _slog("[API] Tag fallback failed:", e.message);
      }
    }

    // Last resort: search
    if (allMarkets.length < 3) {
      try {
        const res = await timedFetch(`${GAMMA_API}/markets?closed=false&limit=50&tag=crypto`);
        if (res.ok) {
          const searchMarkets = await res.json();
          const cryptoRe = /\bbitcoin\b|\bbtc\b|\bethereum\b|\beth\b|\bsolana\b|\bsol\b/;
          for (const m of searchMarkets) {
            const id = m.condition_id || m.conditionId;
            const q = (m.question || "").toLowerCase();
            if (id && !seen.has(id) && cryptoRe.test(q)) {
              seen.add(id);
              allMarkets.push(m);
            }
          }
          _slog(`[API] After search fallback: ${allMarkets.length} total`);
        }
      } catch (e) {
        _slog("[API] Search fallback failed:", e.message);
      }
    }

    return allMarkets;
  });
}

// Extract token→price map from Gamma market data
export async function fetchPricesFromGamma() {
  const markets = await fetchCryptoMarkets();
  const prices = {};
  for (const m of markets) {
    let tokenIds = m.clobTokenIds;
    if (typeof tokenIds === "string") {
      try { tokenIds = JSON.parse(tokenIds); } catch { continue; }
    }
    if (!tokenIds || tokenIds.length < 2) continue;
    let outPrices = m.outcomePrices;
    if (typeof outPrices === "string") {
      try { outPrices = JSON.parse(outPrices); } catch { continue; }
    }
    if (!Array.isArray(outPrices) || outPrices.length < 2) continue;
    const yesP = parseFloat(outPrices[0]);
    const noP = parseFloat(outPrices[1]);
    if (yesP > 0) prices[tokenIds[0]] = yesP;
    if (noP > 0) prices[tokenIds[1]] = noP;
  }
  return prices;
}

export async function fetchPrices(tokenIds) {
  try {
    const gammaPrices = await fetchPricesFromGamma();
    const missing = tokenIds.filter(id => !gammaPrices[id]);
    if (missing.length === 0) return gammaPrices;

    // CLOB midpoint for missing tokens (direct, no proxy)
    if (missing.length > 0 && missing.length < 10) {
      const results = await batchSettled(
        missing.map(id => () =>
          timedFetch(`${CLOB_API}/midpoint?token_id=${id}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )
      );
      missing.forEach((id, i) => {
        if (results[i].status === "fulfilled" && results[i].value) {
          gammaPrices[id] = parseFloat(results[i].value.mid || 0);
        }
      });
    }
    return gammaPrices;
  } catch (e) {
    _slog("[API] Gamma prices failed:", e.message);
  }

  // Fallback: CLOB direct
  const results = await batchSettled(
    tokenIds.map(id => () =>
      timedFetch(`${CLOB_API}/midpoint?token_id=${id}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  );
  const prices = {};
  tokenIds.forEach((id, i) => {
    if (results[i].status === "fulfilled" && results[i].value) {
      prices[id] = parseFloat(results[i].value.mid || results[i].value.price || 0);
    }
  });
  return prices;
}

// ─── CLOB Orderbook — Live bid/ask/spread ────────
// Returns { mid, bestBid, bestAsk, spread, bidDepth, askDepth } for a token
export async function fetchOrderbook(tokenId) {
  try {
    const res = await timedFetch(`${CLOB_API}/book?token_id=${tokenId}`, {}, 4000);
    if (!res.ok) return null;
    const book = await res.json();

    const bids = (book.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (book.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    if (bids.length === 0 && asks.length === 0) return null;

    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;

    // Calculate depth — total $ available within 2% of best price
    let bidDepth = 0, askDepth = 0;
    for (const b of bids) {
      const p = parseFloat(b.price);
      if (p >= bestBid * 0.98) bidDepth += parseFloat(b.size) * p;
    }
    for (const a of asks) {
      const p = parseFloat(a.price);
      if (p <= bestAsk * 1.02) askDepth += parseFloat(a.size) * p;
    }

    return { mid, bestBid, bestAsk, spread, bidDepth, askDepth, bids: bids.slice(0, 5), asks: asks.slice(0, 5) };
  } catch (e) {
    return null;
  }
}

// Batch fetch orderbooks for multiple tokens
export async function fetchOrderbooks(tokenIds) {
  const results = await batchSettled(
    tokenIds.map(id => () => fetchOrderbook(id)),
    BATCH_SIZE
  );
  const books = {};
  tokenIds.forEach((id, i) => {
    if (results[i].status === "fulfilled" && results[i].value) {
      books[id] = results[i].value;
    }
  });
  return books;
}

// CLOB midpoint prices — live, no Gamma cache
export async function fetchCLOBPrices(tokenIds) {
  const prices = {};
  const results = await batchSettled(
    tokenIds.map(id => () =>
      timedFetch(`${CLOB_API}/midpoint?token_id=${id}`, {}, 4000)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    ),
    BATCH_SIZE
  );
  tokenIds.forEach((id, i) => {
    if (results[i].status === "fulfilled" && results[i].value) {
      const mid = parseFloat(results[i].value.mid || results[i].value.price || 0);
      if (mid > 0) prices[id] = mid;
    }
  });
  return prices;
}

export function clearCache() { cache.clear(); }

// ─── Real-time crypto prices from Binance (HTTP fallback) ──
// Only used when WebSocket is down
export async function fetchRealPrices() {
  try {
    const pairs = [
      { symbol: "BTCUSDT", asset: "BTC" },
      { symbol: "ETHUSDT", asset: "ETH" },
      { symbol: "SOLUSDT", asset: "SOL" },
    ];
    const results = await Promise.allSettled(
      pairs.map(p =>
        timedFetch(`https://api.binance.com/api/v3/ticker/price?symbol=${p.symbol}`, {}, 4000)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    const prices = {};
    pairs.forEach((p, i) => {
      if (results[i].status === "fulfilled" && results[i].value) {
        prices[p.asset] = parseFloat(results[i].value.price);
      }
    });
    return prices;
  } catch (e) {
    _slog("[API] Binance HTTP failed:", e.message);
    return {};
  }
}
