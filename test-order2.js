// Test: Place $1 bet on BTC daily (Feb 15) UP
import "dotenv/config";
import { ClobOrders } from "./lib/clob-orders.js";
import * as api from "./lib/polymarket-api.js";

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) { console.error("No key"); process.exit(1); }

  // 1. Init CLOB
  console.log("=== PolyWhale Test Order ===\n");
  const clob = new ClobOrders();
  await clob.init(privateKey);

  // 2. Find Feb 15 BTC daily market
  console.log("\nFetching markets...");
  const raw = await api.fetchCryptoMarkets();
  console.log(`Got ${raw?.length || 0} markets`);

  let market = null;
  for (const m of raw) {
    const slug = (m.events?.[0]?.slug || "").toLowerCase();
    // Target tomorrow's daily or any hourly with time left
    if (!slug.includes("bitcoin-") && !slug.includes("btc-")) continue;

    let tokenIds = m.clobTokenIds;
    if (typeof tokenIds === "string") try { tokenIds = JSON.parse(tokenIds); } catch { continue; }
    if (!tokenIds?.[0]) continue;

    let prices = m.outcomePrices;
    if (typeof prices === "string") try { prices = JSON.parse(prices); } catch { continue; }
    const upPrice = parseFloat(prices?.[0]) || 0;
    const downPrice = parseFloat(prices?.[1]) || 0;

    // Pick a market with reasonable prices (not expired/resolved)
    if (upPrice < 0.05 || upPrice > 0.95) continue;

    console.log(`  Candidate: ${slug} | UP=$${upPrice} DOWN=$${downPrice}`);
    console.log(`    end_date: ${m.end_date_iso}`);
    console.log(`    tokens: ${tokenIds[0].slice(0, 20)}...`);

    if (!market || slug.includes("february-15") || slug.includes("10am")) {
      market = {
        question: m.question,
        slug,
        upToken: tokenIds[0],
        downToken: tokenIds[1],
        upPrice,
        downPrice,
      };
      if (slug.includes("february-15")) break; // prefer tomorrow's daily
    }
  }

  if (!market) {
    console.error("No suitable market found");
    process.exit(1);
  }

  console.log(`\n>>> Selected: ${market.question}`);
  console.log(`    UP=$${market.upPrice.toFixed(3)} | DOWN=$${market.downPrice.toFixed(3)}`);

  // 3. Buy $1 of UP (cheaper side = more upside)
  const side = market.upPrice <= market.downPrice ? "UP" : "DOWN";
  const tokenId = side === "UP" ? market.upToken : market.downToken;
  const price = side === "UP" ? market.upPrice : market.downPrice;

  console.log(`\n>>> Placing $1 BUY on ${side} @$${price.toFixed(3)}...`);
  const result = await clob.buyShares(tokenId, 1.0, price);
  console.log("\nResult:", JSON.stringify(result, null, 2));

  if (result.success) {
    console.log(`\n✓ ORDER PLACED! orderId: ${result.orderId}`);
    console.log("Check Polymarket portfolio to verify.");
  } else {
    console.log(`\n✗ Order failed: ${result.error}`);
  }

  // 4. Check open orders
  console.log("\nOpen orders:");
  const orders = await clob.getOpenOrders();
  console.log(JSON.stringify(orders?.slice(0, 3), null, 2));
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
