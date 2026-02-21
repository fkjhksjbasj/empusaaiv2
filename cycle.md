# PolyWhale — The Full Cycle

## How a dumb idea became a real trading bot, lost money, almost died 47 times, and is still running

---

## Chapter 1: The Spark

It started with a simple observation: Polymarket has crypto UP/DOWN binary markets that resolve every hour, every 4 hours, and every day. "Will Bitcoin go UP or DOWN in the next hour?" — and you can buy YES/NO (we call it UP/DOWN) tokens that pay $1 if you're right, $0 if you're wrong.

The edge? Binance moves faster than Polymarket. When BTC spikes on Binance, the Polymarket token prices take 2-5 seconds to catch up. If you can see the Binance move first and buy on Polymarket before the crowd reprices, you print money.

That was the theory.

---

## Chapter 2: v1 — The Chrome Extension Era

The first version was a Chrome extension. Injected directly into the Polymarket website, it could read market data, observe prices, and theoretically place trades through the browser.

**Why it failed:**
- Chrome extensions have garbage WebSocket support for real-time data
- Content script sandboxing made it nearly impossible to get fast price feeds
- No way to run it 24/7 — close the tab and it dies
- The whole approach was fundamentally wrong for a speed-dependent strategy

**Lesson learned:** You can't build a trading bot inside a browser. You need a server.

---

## Chapter 3: v2 — Node.js Migration (The Real Beginning)

Ripped everything out. Started fresh with a Node.js server on localhost:3000.

Architecture from scratch:
- **server.js** — Main orchestrator, HTTP server for dashboard, WebSocket server for live updates
- **lib/binance-ws.js** — Binance WebSocket for real-time BTC/ETH/SOL prices (~1s latency)
- **lib/polymarket-api.js** — Gamma API + Data API wrapper for market discovery
- **lib/scalper.js** — The trading brain
- **public/** — Web dashboard (vanilla HTML/CSS/JS, no frameworks)

**What worked:** Everything. Node.js with native WebSocket support was instantly 100x better than the Chrome extension. Real-time Binance data streaming at 1-second intervals, proper state management, file-based persistence.

**What didn't:** The Gamma API was slow. 15-second polling cycles meant we were always behind. And we didn't yet understand HOW Polymarket markets actually resolve.

---

## Chapter 4: The Polymarket CLOB Discovery

Polymarket doesn't use a simple orderbook — it uses a Central Limit Order Book (CLOB) on Polygon. Every market has two tokens: UP and DOWN. Prices are set by market makers, not an algorithm.

Key realization: **You can get live CLOB prices via WebSocket** at ~100ms latency. The public endpoint `wss://ws-subscriptions-clob.polymarket.com/ws/market` streams every price change in real-time. No authentication needed.

This replaced our 15-second HTTP polling with streaming data. Game changer.

**polymarket-ws.js** was born — subscribes to token IDs, parses orderbook snapshots, tracks bid/ask/spread/depth. Feeds directly into the scalper's decision engine.

---

## Chapter 5: The Chainlink Revelation (v9.4-v9.5)

This was the biggest research breakthrough of the entire project.

**The problem:** We were trading based on Binance prices, assuming Polymarket resolved based on Binance. We were wrong.

**The truth:** Polymarket resolves UP/DOWN markets against **Chainlink Data Streams** — a completely different price source with its own methodology and a ~27 second lag behind spot exchanges.

**How Chainlink actually works (3 layers deep):**
1. Premium data aggregators (CoinGecko, BraveNewCoin, Tiingo, CoinMarketCap) compute volume-weighted averages
2. 16 independent oracle nodes each take the median of multiple aggregators
3. The DON (Decentralized Oracle Network) takes the median of all 16 node observations

Result: Chainlink's price is a **"median of medians of volume-weighted averages"** — it's smoothed, lagged, and different from any single exchange.

**What we built:**
- **chainlink-ws.js** — Connected to Polymarket's RTDS relay for Chainlink oracle prices. Free but ~27s behind spot.
- **multi-exchange.js** — Added Coinbase and Kraken WebSocket feeds alongside Binance. Takes the median of all three exchanges to **predict** what Chainlink will report in 27 seconds.

This was the real edge: we know what Chainlink will say before Chainlink says it, because we're watching the same exchanges Chainlink's aggregators watch.

**The predictive edge:** `median(Binance, Coinbase, Kraken)` leads Chainlink RTDS by ~27 seconds. When our predicted price diverges from the current Chainlink oracle price by more than 3%, there's an arbitrage opportunity — the token price hasn't adjusted yet.

---

## Chapter 6: The Trader Brain (v9 — Market Intelligence)

Raw momentum signals weren't enough. The bot was getting faked out by traps, whipsaws, and regime changes. It needed a brain.

**MarketIntelligence** was born — a standalone module based on actual market microstructure research:
- Kyle (1985): informed traders move prices through order flow
- Cont et al (2014): order flow imbalance predicts short-term returns
- Mandelbrot (1963): volatility clusters, Hurst exponent for trend detection
- Bouchaud et al (2004): price impact and market microstructure

**What it does:**
- **Regime detection:** TRENDING_UP, TRENDING_DOWN, MEAN_REVERTING, CHOPPY, RANGING
- **Trap detection:** Identifies false breakouts, bull/bear traps using swing points and VWAP
- **Exhaustion detection:** Measures when a move is running out of steam (diminishing momentum, volume drying up)
- **Smart money detection:** Tracks if large volume is confirming or denying the move
- **Structure analysis:** Swing highs/lows, key levels, round number psychology

**The entry gate:** MarketIntelligence can VETO any trade the signal engine wants to take. It can also adjust conviction from 0.2x (barely believe it) to 1.5x (high confidence multiplier).

---

## Chapter 7: Conviction Scoring — The 7-Factor Model

Every potential trade gets scored on 7 factors:

| Factor | Weight | What it measures |
|--------|--------|-----------------|
| Signal strength | 25% | Weighted momentum across 30s/90s/3m/5m/10m timeframes |
| RSI confirmation | 15% | Is RSI overbought/oversold in alignment with our direction? |
| Bollinger confirmation | 10% | Is price breaking out of Bollinger Bands in our direction? |
| Cross-asset consensus | 15% | Do BTC, ETH, and SOL all agree on direction? |
| Volume confirmation | 10% | Is volume surging to confirm the trend? |
| Predictive edge | 15% | Multi-exchange vs Chainlink divergence (our 27s lead) |
| Probe track record | 10% | Has this pattern been profitable in past trades? |

The conviction score (0-1) determines bet sizing through Kelly Criterion-based tiers, from SCOUT ($1 minimum) to ALL-IN (98% of bankroll).

---

## Chapter 8: v10 — Timeframe-Adaptive Trading (Black-Scholes Framework)

Not all timeframes are equal. A 5-minute market moves differently than a daily market. v10 made the bot adaptive:

**Stop losses scale with sqrt(time)** — derived from Black-Scholes volatility:
- 5m: 12% stop loss
- 15m: 18%
- 1h: 28%
- 4h: 35%
- 1d: 40%

**Binary probability** uses N(d2) from Black-Scholes to calculate the probability that crypto will be above/below entry price at expiry. This accounts for time decay — a BTC dip means less on a daily market than on a 5-minute market.

**Hold-through-dips:** On 1h/4h/1d markets, mean reversion dominates. A temporary BTC dip is a buying opportunity, not a sell signal. On 5m/15m, it's the opposite — momentum dominates.

**Price-distance intelligence:** If BTC is $300+ in our direction from entry, widen stops by 50%. The further we're winning, the more room we give it to breathe.

**Latency-aware exits:** Before triggering a stop loss, wait 5 seconds and check if Binance shows recovery. The CLOB might be lagging behind the real move.

---

## Chapter 9: The Strategy — Buy Low, Sell High, Never Sell at Loss

The core philosophy evolved through painful losses:

**Entry logic:**
- Scans ALL valid crypto UP/DOWN markets on Polymarket (BTC, ETH, SOL across all timeframes)
- Prioritizes: 4h > 1h > 1d (best liquidity-to-edge ratio)
- Side determined by multi-timeframe momentum:
  - **UP signal:** mom10m > 0.001 OR (mom5m > 0.0015 AND mom3m > 0.001)
  - **DOWN signal:** Much higher bar — mom10m < -0.002 AND mom5m < -0.001 AND RSI > 55
  - **Safety gate:** NEVER bet DOWN if any momentum timeframe is positive
  - **Default:** UP if cheap enough (BTC trends up long-term)
  - **Skip:** No signal = no bet. Don't force bad trades.

**Exit logic:**
- NEVER sell at a loss on long-timeframe positions (1h/4h/1d)
- Near expiry: if crypto supports our position, hold to resolution ($1 payout)
- Trailing stop locks in profits: once we're up, we protect the gain
- Market resolution: expired positions auto-resolve based on crypto price

**Position management:**
- MAX_POSITIONS evolved from 10 (spread across markets) to 1 (all-in on best daily) after learning that spreading thin = death by a thousand cuts
- Per-asset-per-timeframe dedup: BTC 1h + BTC 4h = fine, two BTC 1h = blocked
- Probe system: small $1 bets first to test a pattern, scale up only when proven (55%+ win rate over 3+ samples)

---

## Chapter 10: v11 — Going Live (Real Money)

Paper trading was nice but meaningless. Time to put real money on the line.

**clob-orders.js** — The real deal:
- Uses `@polymarket/clob-client` SDK for actual order placement on Polygon
- Derives API credentials deterministically from private key (no manual API key management)
- Looks up Polymarket proxy wallet address (where funds live on-chain)
- Entry: GTC limit orders at best ask
- Exit: GTC normal, or FOK if urgent/near expiry
- Order verification: waits 2 seconds after placement, checks if order actually matched, cancels if not

**The kill switch:** `LIVE_TRADING=true` in .env enables real orders. Set to `false` and it's back to paper mode. One line to stop the bleeding.

**Starting bankroll:** $8.25 USDC on Polygon (later references show $6 as working capital after some was locked in early positions).

---

## Chapter 11: The Losses

Let's not sugarcoat this. The bot lost money.

**The scoreboard (as of Feb 17, 2026):**
- Total bets: 8
- Wins: 1
- Losses: 5
- Total realized P&L: -$10.70
- Starting bankroll: $8.25
- Current bankroll: $0.17
- Locked in positions: $8.08

**What went wrong:**

1. **Early bets were too aggressive** — betting on short timeframes (5m, 15m) where the edge was thin and spreads ate the profit
2. **DOWN bets killed us** — the bot bet against BTC momentum and got punished. BTC trends up; fighting that is expensive.
3. **Not enough data** — the signal engine was making decisions with minutes of price history, not hours
4. **Spread costs** — Polymarket's bid-ask spread on binary tokens is 1-3 cents. On a $1 payout, that's 1-3% drag on every trade.

**The $12 loss lesson** (coded as HARD CONSTRAINTS):
```javascript
const ONLY_1D_MARKETS = true;    // ONLY trade 1d timeframe
const ONLY_BTC = true;           // ONLY trade BTC
const MAX_SINGLE_BET = 10.00;    // Full send on one position
```
After losing on scattered small bets across multiple timeframes and assets, the strategy was simplified: one big bet on the best daily BTC market. Concentration over diversification.

---

## Chapter 12: The Current Position

As of this writing, one position remains open:

**BTC UP [1d] — February 16**
- Entry price: $0.50 (16.16 shares)
- Cost basis: $8.08
- BTC at entry: $70,326
- BTC now: ~$67,800
- Current token price: ~$0.315
- Unrealized P&L: -$2.99
- Strategy: Diamond hands. Hold to resolution or 45% profit.

BTC dropped ~$2,500 from entry. The token price collapsed from $0.50 to $0.315. But since it's a daily market, there's still time for BTC to recover. The bot won't sell at a loss — it will either win at resolution or lose the position.

---

## Chapter 13: The Crash Saga (The Real Boss Fight)

The trading strategy was actually the easy part. Keeping the bot ALIVE on Windows was the nightmare.

### The Symptoms
The bot would run perfectly for hours, then silently die. No error message. No crash log. No JavaScript exception. Just... gone. PowerShell prompt returns like nothing happened.

### Attempt 1: WebSocket Error Handlers
First theory: unhandled WebSocket `error` events. In Node.js, an EventEmitter that emits `error` with no listener crashes the entire process instantly. No try-catch can save you.

**Fix:** Added `.on("error")` handlers to every WebSocket (server WSS, client WS connections, dashboard clients).

**Result:** Still crashed.

### Attempt 2: Console.log Buffer Overflow
Second theory (and the real primary cause): **`console.log` on Windows is synchronous**. It writes to stdout through a pipe. When the pipe buffer fills up (because the terminal can't render fast enough), the write blocks. When it blocks too long, Windows kills the V8 process at the native level — below JavaScript, below Node.js, below everything.

The bot was logging every tick (500ms), every signal, every market update. Hundreds of lines per second. The terminal couldn't keep up.

**Fix (multi-layer):**
1. Created `slog()`/`serr()` safe wrappers using `process.stdout.write()` in try-catch
2. Throttled scalper output: TICK/SIGNAL/MARKET only print every 20th line
3. Created `_slog` helpers in all 6 lib files, replaced ALL 51 bare `console.log/error/warn` calls
4. Redirected output to file in run.bat: `node server.js >> data\bot.log 2>&1`

### Attempt 3: EPIPE Crash
Third theory: when the terminal pipe disconnects (VSCode bug — known since 2017), `process.stdout.write()` throws EPIPE and crashes the process.

**Fix:** Added EPIPE error handlers:
```javascript
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") return;
});
```

### Attempt 4: Crash File Logging
Since stdout was the problem, added crash-to-file logging:
```javascript
import { appendFileSync } from "fs";
const CRASH_LOG = join(__dirname, "data", "crash.log");
```
Now `unhandledRejection`, `uncaughtException`, `SIGINT`, `SIGTERM`, and `exit` all write to `data/crash.log` before dying.

### Attempt 5: run.bat Auto-Restart
Created a batch file that restarts the bot if it crashes:
```batch
:loop
node server.js >> data\bot.log 2>&1
timeout /t 3 /nobreak >nul
goto loop
```

**Problem:** Batch file itself was too slow on Windows. PowerShell printing was lagging.

### Attempt 6: PM2 Process Manager
Installed PM2 globally. `pm2 start server.js --name polywhale`.

**Problem:** PM2's daemon process is tied to the terminal session on Windows. When VSCode's terminal dies (which it does — known bug vscode#244278, #177044, #223553), PM2's daemon dies too, and the bot goes with it.

### Attempt 7: NSSM (Failed)
Tried to install NSSM (Non-Sucking Service Manager) to run as a Windows Service.

**Problem:** NSSM's website returned 503 (down). Couldn't download it.

### Attempt 8: node-windows (The Solution)
Installed `node-windows` npm package. Created `install-service.js`:

```javascript
import { Service } from "node-windows";
const svc = new Service({
  name: "PolyWhale",
  description: "PolyWhale v2 — Polymarket Crypto Scalper",
  script: join(__dirname, "server.js"),
  wait: 2, grow: 0.5, maxRestarts: 100,
});
svc.install();
```

Ran from admin CMD. Service installed. **Bot registered as `polywhale.exe` in Windows Services.** Survives reboots, survives VSCode crashes, survives terminal closures, auto-restarts on crash (up to 100 times).

Logs at `c:\tradingbot\daemon\polywhale.out.log` and `polywhale.err.log`.

**This is what finally worked.**

### The Root Causes (Summary)
1. **console.log stdout buffer overflow** — synchronous write blocks, Windows kills V8 at native level
2. **EPIPE from broken pipe** — VSCode terminal disconnects, stdout write throws
3. **Unhandled WebSocket error events** — EventEmitter crashes process with no listener
4. **VSCode terminal kills child processes** — known VSCode bug since 2017, still unfixed
5. **PM2 daemon tied to terminal** — not a real service on Windows, dies with session

---

## Chapter 14: Market Slug Archaeology

Polymarket uses different URL slug formats for different timeframes. Figuring this out was its own adventure:

- **5m/15m:** `btc-updown-{5m|15m}-{unix_timestamp}` — timestamp-based, machine-generated
- **4h:** `btc-updown-4h-{unix_timestamp}` — same pattern as short timeframes
- **Hourly:** `bitcoin-up-or-down-{month}-{day}-{hour}{am|pm}-et` — full coin name, human-readable
- **Daily:** `bitcoin-up-or-down-on-{month}-{day}` — full coin name + "on"

Asset detection from slugs:
- `btc-` or `bitcoin-` → BTC
- `eth-` or `ethereum-` → ETH
- `sol-` or `solana-` → SOL

The 4h timeframe was initially broken because we didn't know its slug format existed. Adding it required regex updates across the slug parser, timeframe detector, and market scanner.

---

## Chapter 15: The Tick Architecture

Four concurrent loops, each serving a different purpose:

| Loop | Interval | Purpose |
|------|----------|---------|
| **fastTick** | 500ms | In-memory only. Reacts to CLOB WS data. Checks exits, updates prices. No API calls. No logging. |
| **fullTick** | 15s | Full signal scan. API prices. Entry/exit decisions. State persistence. |
| **refreshMarkets** | 60s | Re-fetch market list from Gamma API. Discover new markets. Re-subscribe CLOB WS tokens. |
| **dashboardPush** | 1s | WebSocket push to browser dashboard. Builds full state JSON. |

The fastTick is the heartbeat — 500ms means ~2 ticks/second of pure in-memory price checking. It sees CLOB WS updates within 750ms of the Polymarket orderbook changing. The fullTick does the heavy lifting every 15 seconds.

As of tick #117,346 the bot has been running for a long time. That counter persists across restarts.

---

## Chapter 16: The Dashboard

Built with vanilla HTML/CSS/JS. No React. No Vue. No frameworks. White minimalist design, Inter font.

Features:
- Live P&L, bankroll, position count
- Signal strength indicators for BTC/ETH/SOL
- Open position cards with entry price, current price, unrealized P&L
- Market scanner showing all available UP/DOWN markets with prices
- Log feed showing bot decisions in real-time
- Manual trade button (bypasses model health check)
- Reset button (nuclear option)

Connected via WebSocket — the server pushes full state every 1 second. No polling.

---

## Chapter 17: The Tech Stack

Dead simple. No bloat.

```json
{
  "dependencies": {
    "@polymarket/clob-client": "^5.2.3",
    "dotenv": "^17.3.1",
    "ethers": "^5.8.0",
    "node-windows": "^1.0.0-beta.8",
    "ws": "^8.18.0"
  }
}
```

5 dependencies. That's it. No Express, no database, no ORM, no build tools, no TypeScript. Just Node.js, WebSockets, ethers for blockchain, and the Polymarket SDK.

File-based persistence: `data/state.json` stores everything. Load on boot, save on changes. Simple, reliable, zero config.

---

## Chapter 18: What We Learned

### About Markets
1. **Polymarket resolves against Chainlink, not Binance.** This single discovery changed the entire strategy.
2. **The "median of medians" is remarkably hard to predict.** Even watching the same exchanges Chainlink watches, our predicted price isn't always right because of the aggregation layers.
3. **The 27-second Chainlink lag is real and tradeable.** But the edge is thin and spread costs eat into it.
4. **BTC trends up.** Betting DOWN is fighting the current. The safety gate (never bet DOWN if any momentum is positive) was added after multiple painful DOWN losses.
5. **Liquidity dries up near expiry.** The last 2 minutes of any market are a desert. If you're holding a losing token at that point, there's no one to sell to.
6. **Daily markets are the play.** 5m/15m markets are pure gambling — too fast, too noisy, too much spread relative to the move. 1h is okay. 1d gives you room to be wrong temporarily and still win.

### About Building
7. **console.log can kill your Node.js process on Windows.** This is not documented anywhere obvious. It's a native-level stdout buffer issue.
8. **VSCode's integrated terminal silently kills child processes.** Known bug since 2017. vscode#244278. Still not fixed.
9. **Windows Services are the only reliable way to keep a Node.js process alive on Windows.** Not PM2, not batch files, not Task Scheduler. A real Windows Service via `node-windows`.
10. **5 npm dependencies is enough.** You don't need Express for a simple HTTP server. You don't need MongoDB for state persistence. You don't need TypeScript for a 2000-line codebase.

### About Trading
11. **$8.25 is not enough.** With Polymarket's $1 minimum bet, you get 8 tries. Lose 5 and you're at $0.17 with no ability to trade.
12. **Concentration beats diversification at micro scale.** With $8, spreading across 10 positions means $0.80 each — below the minimum. One big bet on the best setup is the only viable strategy.
13. **The bot's signals are good but the bankroll management was bad.** Early trades were scattered across timeframes and assets. The hard constraints (ONLY_1D, ONLY_BTC) were learned from losing $12.
14. **Never sell at a loss on daily markets.** BTC can drop $3,000 and recover in hours. The token might go from $0.50 to $0.15 and back to $0.80. Diamond hands on daily markets is mathematically correct because mean reversion dominates.

---

## Chapter 19: Where We Are Now

**Date:** February 20, 2026

**Status:** Bot running as Windows Service `polywhale.exe`. Stable. No crashes since service installation.

**The Numbers:**
- Starting bankroll: $8.25
- Current bankroll: $0.17 (can't trade — below $1 minimum)
- Locked in position: $8.08
- Realized P&L: -$10.70
- Unrealized P&L: -$2.99
- Open position: BTC UP [1d] Feb 16 — 16.16 shares at $0.50

**What the bot is doing right now:**
- Ticking every 500ms (fast tick)
- Scanning 22 markets every 60s
- 15 markets ready for trading
- Signals firing (SOL bear, ETH bull, BTC bull) but can't act — no bankroll
- CLOB WS subscribed to 30 tokens
- Dashboard live at localhost:3000

**What needs to happen:**
1. The BTC UP [1d] Feb 16 position needs to resolve (win or lose)
2. If it wins: bankroll replenished, bot can trade again
3. If it loses: need to deposit more USDC to continue
4. Strategy refinement: the hard constraints (ONLY_1D, ONLY_BTC) are a good start but need more data to validate

---

## Chapter 20: The Code (By the Numbers)

| File | Lines | Purpose |
|------|-------|---------|
| server.js | 429 | Main orchestrator |
| lib/scalper.js | ~2200 | Trading engine (the big one) |
| lib/market-intelligence.js | ~800 | Trader brain |
| lib/polymarket-api.js | ~300 | Gamma + Data API |
| lib/polymarket-ws.js | ~250 | CLOB WebSocket |
| lib/binance-ws.js | ~200 | Binance WebSocket |
| lib/multi-exchange.js | ~300 | Coinbase + Kraken |
| lib/chainlink-ws.js | ~200 | Chainlink RTDS |
| lib/clob-orders.js | ~300 | Real order execution |
| lib/storage.js | ~50 | File persistence |
| public/app.js | ~500 | Dashboard frontend |
| public/index.html | ~300 | Dashboard markup |
| public/style.css | ~400 | Dashboard styles |
| install-service.js | ~30 | Windows Service installer |

Total: roughly 5,500 lines of JavaScript. No dependencies beyond the 5 in package.json.

---

## Timeline

| Date | Event |
|------|-------|
| Early Feb 2026 | Project starts as Chrome extension (v1) |
| ~Feb 5-6 | Chrome extension abandoned, Node.js server (v2) built from scratch |
| ~Feb 7-8 | Binance WS integration, basic momentum signals, first dashboard |
| ~Feb 9-10 | Gamma API market discovery, slug format archaeology |
| ~Feb 10-11 | MarketIntelligence module (v9) — regime detection, trap avoidance |
| ~Feb 11-12 | CLOB execution simulation (v9.3) — realistic spread/slippage modeling |
| ~Feb 12 | Chainlink discovery (v9.4) — realized Poly resolves against Chainlink, not Binance |
| ~Feb 12-13 | Multi-exchange feeds (v9.5) — Coinbase + Kraken, predicted Chainlink price |
| ~Feb 13 | CLOB WebSocket integration (v9.6) — live token prices at ~100ms |
| ~Feb 13-14 | Timeframe-adaptive trading (v10) — Black-Scholes stops, N(d2) binary probability |
| ~Feb 14-15 | Live trading (v11) — real CLOB orders via SDK, first real trades |
| Feb 15 | First crashes begin — silent Node.js deaths on Windows |
| Feb 15-16 | Crash investigation: WS error handlers, safe logging, EPIPE handlers |
| Feb 16 | BTC UP [1d] position opened at $0.50 (16.16 shares, $8.08) |
| Feb 16-17 | Crash saga continues: PM2 tried and failed, NSSM site down |
| Feb 17 | node-windows Windows Service installed — bot finally stable |
| Feb 17-20 | Bot running as service, monitoring position, bankroll too low for new trades |

---

## The Philosophy

PolyWhale isn't trying to be a high-frequency trading system. It's not trying to front-run anyone. It's a simple idea executed with discipline:

1. Watch what the exchanges say
2. Predict what Chainlink will report
3. If there's a divergence, buy the underpriced token
4. If momentum confirms, ride it
5. If it goes wrong, hold (on daily markets) — time heals
6. Never sell at a loss unless the math says it's impossible to recover
7. Keep the bot alive no matter what

The edge is small. The bankroll is tiny. The competition is real (market makers, bots, smart money). But the infrastructure is solid, the signals are research-backed, and the bot runs 24/7 as a Windows Service that survives reboots.

Now we just need more money.

---

*Built with Claude + Node.js + stubbornness. Zero frameworks. Five dependencies. One whale.*
