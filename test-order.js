// Test script: Place a single $1 bet on Polymarket
// Usage: node test-order.js

import "dotenv/config";
import { ClobOrders } from "./lib/clob-orders.js";
import * as api from "./lib/polymarket-api.js";

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    console.error("No POLYMARKET_PRIVATE_KEY in .env");
    process.exit(1);
  }

  // 1. Init CLOB client
  console.log("=== PolyWhale Test Order ===\n");
  const clob = new ClobOrders();
  await clob.init(privateKey);

  // 2. Check balance
  console.log("\nChecking balance...");
  const balance = await clob.getBalance();
  console.log("Balance:", JSON.stringify(balance, null, 2));

  // 3. Find a BTC daily or hourly market
  console.log("\nFetching markets...");
  const raw = await api.fetchCryptoMarkets();
  if (!raw || raw.length === 0) {
    console.error("No markets found — check VPN");
    process.exit(1);
  }

  const now = Date.now();
  let market = null;
  for (const m of raw) {
    const slug = (m.events?.[0]?.slug || "").toLowerCase();
    const isBtc = slug.startsWith("btc-") || slug.startsWith("bitcoin-");
    if (!isBtc) continue;

    const endDate = m.end_date_iso ? new Date(m.end_date_iso).getTime() : 0;
    const secsLeft = endDate > 0 ? (endDate - now) / 1000 : 0;
    if (secsLeft < 600) continue; // need at least 10min left

    let tokenIds = m.clobTokenIds;
    if (typeof tokenIds === "string") try { tokenIds = JSON.parse(tokenIds); } catch { continue; }
    if (!tokenIds?.[0]) continue;

    let prices = m.outcomePrices;
    if (typeof prices === "string") try { prices = JSON.parse(prices); } catch { continue; }
    const upPrice = parseFloat(prices?.[0]) || 0;

    if (upPrice > 0.02 && upPrice < 0.98) {
      market = {
        question: m.question,
        slug: m.events?.[0]?.slug,
        upToken: tokenIds[0],
        downToken: tokenIds[1],
        upPrice,
        downPrice: parseFloat(prices?.[1]) || 0,
        secsLeft: Math.floor(secsLeft),
      };
      break;
    }
  }

  if (!market) {
    console.error("No suitable BTC market found with good price range");
    process.exit(1);
  }

  console.log(`\nFound market: ${market.question}`);
  console.log(`  UP price:   $${market.upPrice.toFixed(3)}`);
  console.log(`  DOWN price: $${market.downPrice.toFixed(3)}`);
  console.log(`  Time left:  ${Math.floor(market.secsLeft / 60)} minutes`);
  console.log(`  UP token:   ${market.upToken.slice(0, 20)}...`);

  // 4. Buy $1 of the UP side (safer default)
  const side = market.upPrice <= market.downPrice ? "UP" : "DOWN";
  const tokenId = side === "UP" ? market.upToken : market.downToken;
  const price = side === "UP" ? market.upPrice : market.downPrice;

  console.log(`\n>>> Placing $1 BUY on ${side} @$${price.toFixed(3)}...`);
  const result = await clob.buyShares(tokenId, 1.0, price);
  console.log("\nResult:", JSON.stringify(result, null, 2));

  if (result.success) {
    console.log(`\n✓ Order placed! orderId: ${result.orderId}`);
    console.log("Check your Polymarket portfolio to verify.");
  } else {
    console.log(`\n✗ Order failed: ${result.error}`);
  }

  // 5. Show open orders
  console.log("\nOpen orders:");
  const orders = await clob.getOpenOrders();
  console.log(JSON.stringify(orders, null, 2));
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
