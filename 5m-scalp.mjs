// 5m BTC Scalp Trade — Real money
// Strategy:
//   1. Find next 5m BTC window
//   2. Wait for window to open, check BTC momentum in first 20s
//   3. BUY the UP or DOWN token at ~$0.50
//   4. Monitor position — exit when profitable or 45s before close
//
// Uses ClobOrders for real CLOB execution

import { config } from 'dotenv';
config();
import { ClobOrders } from './lib/clob-orders.js';

const TRADE_SIZE = 1.10;  // $1.10 USDC (buffer above $1 min)
const PROFIT_TARGET = 0.08; // exit if token moves +$0.08 from entry
const STOP_LOSS = 0.12;    // exit if token drops -$0.12 from entry
const EXIT_BEFORE_CLOSE_SECS = 45; // sell with 45s remaining
const MOMENTUM_SAMPLES = 8; // watch BTC for 8 samples (16 seconds) to decide direction

const log = (msg) => console.log(`[${new Date().toISOString().slice(11,23)}] ${msg}`);

// ─── Fetch helpers ─────────────────────────────
async function getBTCPrice() {
  const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  const d = await r.json();
  return parseFloat(d.price);
}

async function getTokenMidpoint(tokenId) {
  const r = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
  const d = await r.json();
  return parseFloat(d.mid);
}

async function getOrderbook(tokenId) {
  const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  const d = await r.json();
  const bids = (d.bids || []).sort((a,b) => parseFloat(b.price) - parseFloat(a.price));
  const asks = (d.asks || []).sort((a,b) => parseFloat(a.price) - parseFloat(b.price));
  return {
    bestBid: bids.length ? parseFloat(bids[0].price) : 0,
    bestAsk: asks.length ? parseFloat(asks[0].price) : 0,
    bidSize: bids.length ? parseFloat(bids[0].size) : 0,
    askSize: asks.length ? parseFloat(asks[0].size) : 0,
    bids, asks,
  };
}

async function getTokens(timestamp) {
  const slug = "btc-updown-5m-" + timestamp;
  const r = await fetch("https://gamma-api.polymarket.com/events?slug=" + slug);
  const data = await r.json();
  if (!data.length || !data[0].markets || !data[0].markets.length) return null;
  const m = data[0].markets[0];
  const tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
  return {
    up: tokens[0],
    dn: tokens[1],
    title: m.question,
    conditionId: m.condition_id || m.conditionId,
  };
}

// Get actual conditional token balance from CLOB
async function getActualShares(clob, tokenId) {
  try {
    const bal = await clob.client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
    return parseFloat(bal.balance) / 1e6;
  } catch {
    return 0;
  }
}

// ─── Main ──────────────────────────────────────
async function main() {
  log("=== 5m BTC SCALP TRADE ===");

  // 1. Init CLOB client
  log("Initializing CLOB client...");
  const clob = new ClobOrders();
  await clob.init(process.env.POLYMARKET_PRIVATE_KEY);

  // 2. Check real balance
  const balance = await clob.getBalance();
  log(`Real USDC balance: $${balance.toFixed(4)}`);

  if (balance < TRADE_SIZE) {
    log(`ERROR: Need $${TRADE_SIZE} but only have $${balance.toFixed(4)}`);
    process.exit(1);
  }

  // 3. Find current/next 5m window
  const nowSec = Math.floor(Date.now() / 1000);
  const currentStart = Math.floor(nowSec / 300) * 300;
  const currentEnd = currentStart + 300;
  const secsIntoWindow = nowSec - currentStart;
  const secsRemaining = currentEnd - nowSec;

  log(`Current window: ${currentStart} (${secsIntoWindow}s in, ${secsRemaining}s left)`);

  let targetStart, targetEnd;

  // Use current window if > 200s remain, otherwise wait for next
  if (secsRemaining > 200) {
    targetStart = currentStart;
    targetEnd = currentEnd;
    log(`Using CURRENT window (${secsRemaining}s remaining)`);
  } else {
    targetStart = currentStart + 300;
    targetEnd = targetStart + 300;
    const waitSecs = targetStart - nowSec;
    log(`Current window too close to expiry. Waiting ${waitSecs}s for next window...`);
    await sleep(waitSecs * 1000);
  }

  // 4. Fetch token IDs
  log("Fetching token IDs...");
  const tokens = await getTokens(targetStart);
  if (!tokens) {
    log("ERROR: Could not find market for window " + targetStart);
    process.exit(1);
  }
  log(`Market: ${tokens.title}`);
  log(`UP token: ${tokens.up.slice(0, 16)}...`);
  log(`DN token: ${tokens.dn.slice(0, 16)}...`);

  // 5. Watch BTC momentum to decide direction
  log(`\nWatching BTC for ${MOMENTUM_SAMPLES * 2}s to determine direction...`);
  const btcPrices = [];
  for (let i = 0; i < MOMENTUM_SAMPLES; i++) {
    const btc = await getBTCPrice();
    btcPrices.push(btc);
    const delta = btcPrices.length > 1 ? (btc - btcPrices[0]).toFixed(2) : "0";
    log(`  BTC: $${btc.toFixed(2)} (delta from first: $${delta})`);
    if (i < MOMENTUM_SAMPLES - 1) await sleep(2000);
  }

  const btcDelta = btcPrices[btcPrices.length - 1] - btcPrices[0];
  const direction = btcDelta >= 0 ? "UP" : "DOWN";
  const tokenId = direction === "UP" ? tokens.up : tokens.dn;

  log(`\nBTC moved $${btcDelta.toFixed(2)} → picking ${direction}`);

  // Check orderbook for the chosen token
  const book = await getOrderbook(tokenId);
  const midpoint = await getTokenMidpoint(tokenId);
  log(`Token midpoint: $${midpoint.toFixed(4)}`);
  log(`Best bid: $${book.bestBid.toFixed(4)} (${book.bidSize} shares)`);
  log(`Best ask: $${book.bestAsk.toFixed(4)} (${book.askSize} shares)`);
  log(`Spread: $${(book.bestAsk - book.bestBid).toFixed(4)}`);

  // 6. Place BUY order
  // Buy at the ask to get filled
  const buyPrice = Math.min(book.bestAsk, 0.95); // don't overpay
  const secsNow = Math.floor(Date.now() / 1000);
  const secsLeft = targetEnd - secsNow;

  log(`\n=== PLACING BUY ORDER ===`);
  log(`Direction: ${direction}`);
  log(`Buy price: $${buyPrice.toFixed(4)}`);
  log(`Trade size: $${TRADE_SIZE}`);
  log(`Time remaining: ${secsLeft}s`);

  const buyResult = await clob.buyShares(tokenId, TRADE_SIZE, buyPrice);

  if (buyResult.success === false) {
    log(`BUY FAILED: ${buyResult.error}`);
    process.exit(1);
  }

  log(`BUY SUCCESS!`);
  log(`Order ID: ${buyResult.orderId}`);
  log(`Exec price: $${buyResult.execPrice}`);
  log(`Shares: ${buyResult.shares}`);

  const entryPrice = buyResult.execPrice;

  // 7. Wait a moment then verify the order was matched
  await sleep(3000);
  const verify = await clob.verifyOrder(buyResult.orderId);
  log(`Order status: ${verify.status || "unknown"}, matched: ${verify.matched}`);

  if (verify.matched === false) {
    log("Order NOT matched — waiting 5 more seconds...");
    await sleep(5000);
    const verify2 = await clob.verifyOrder(buyResult.orderId);
    log(`Retry status: ${verify2.status || "unknown"}, matched: ${verify2.matched}`);

    if (verify2.matched === false) {
      log("Still not matched. Cancelling order...");
      await clob.cancelOrder(buyResult.orderId);
      log("Order cancelled. Exiting.");
      process.exit(1);
    }
  }

  // Get ACTUAL shares held (may differ from buy order due to fees)
  const actualShares = await getActualShares(clob, tokenId);
  log(`Actual shares held: ${actualShares}`);
  const shares = actualShares > 0 ? actualShares : buyResult.shares;

  // 8. Monitor position — exit on profit target, stop loss, or time
  log(`\n=== MONITORING POSITION ===`);
  log(`Entry: $${entryPrice} | Target: $${(entryPrice + PROFIT_TARGET).toFixed(4)} | Stop: $${(entryPrice - STOP_LOSS).toFixed(4)}`);

  let exitReason = null;
  let exitPrice = 0;

  while (exitReason === null) {
    await sleep(3000);

    const nowS = Math.floor(Date.now() / 1000);
    const timeLeft = targetEnd - nowS;
    const currentMid = await getTokenMidpoint(tokenId);
    const btcNow = await getBTCPrice();
    const pnl = (currentMid - entryPrice) * shares;

    log(`  ${timeLeft}s left | Token: $${currentMid.toFixed(4)} | PnL: $${pnl.toFixed(4)} | BTC: $${btcNow.toFixed(2)}`);

    // Check exit conditions
    if (currentMid >= entryPrice + PROFIT_TARGET) {
      exitReason = "PROFIT_TARGET";
      exitPrice = currentMid;
    } else if (currentMid <= entryPrice - STOP_LOSS) {
      exitReason = "STOP_LOSS";
      exitPrice = currentMid;
    } else if (timeLeft <= EXIT_BEFORE_CLOSE_SECS) {
      exitReason = "TIME_EXIT";
      exitPrice = currentMid;
    }
  }

  // 9. SELL — use actual token balance, not buy order shares
  log(`\n=== SELLING — ${exitReason} ===`);

  // Re-check actual shares right before selling
  const sellShares = await getActualShares(clob, tokenId);
  log(`Shares to sell: ${sellShares}`);

  if (sellShares < 1) {
    log("Not enough shares to sell (min 1). Holding to resolution.");
    const finalBal = await clob.getBalance();
    log(`USDC balance: $${finalBal.toFixed(4)}, still holding ${sellShares} shares`);
    process.exit(0);
  }

  const sellBook = await getOrderbook(tokenId);

  if (sellBook.bestBid === 0) {
    log("No bids available. Holding to resolution.");
    process.exit(0);
  }

  // Sell at bid price for immediate fill
  const sellPrice = sellBook.bestBid;
  log(`Sell price: $${sellPrice.toFixed(4)} (bid: $${sellBook.bestBid.toFixed(4)})`);

  const sellResult = await clob.sellShares(tokenId, sellShares, sellPrice, exitReason === "TIME_EXIT");

  if (sellResult.success) {
    const realizedPnl = (sellResult.execPrice - entryPrice) * sellShares;
    log(`SELL SUCCESS!`);
    log(`Exit price: $${sellResult.execPrice}`);
    log(`Realized P&L: $${realizedPnl.toFixed(4)}`);
    log(`Return: ${((sellResult.execPrice / entryPrice - 1) * 100).toFixed(2)}%`);
  } else {
    log(`SELL FAILED: ${sellResult.error}`);
    // Try with smaller amount (90% of shares)
    const reducedShares = Math.floor(sellShares * 0.9 * 100) / 100;
    if (reducedShares >= 1) {
      log(`Retrying with ${reducedShares} shares...`);
      const retry = await clob.sellShares(tokenId, reducedShares, Math.max(sellBook.bestBid - 0.02, 0.01), true);
      if (retry.success) {
        const pnl = (retry.execPrice - entryPrice) * reducedShares;
        log(`Retry sell succeeded! P&L: $${pnl.toFixed(4)}`);
      } else {
        log(`Retry also failed: ${retry.error}`);
        log("WARNING: Position still open! Token: " + tokenId.slice(0, 20) + "...");
      }
    } else {
      log("Cannot sell — shares too small. Holding to resolution.");
    }
  }

  // Final balance
  await sleep(2000);
  const finalBalance = await clob.getBalance();
  log(`\nFinal USDC balance: $${finalBalance.toFixed(4)}`);
  log("=== TRADE COMPLETE ===");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
