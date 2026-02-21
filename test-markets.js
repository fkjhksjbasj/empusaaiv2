// Quick debug: list all crypto markets
import "dotenv/config";
import * as api from "./lib/polymarket-api.js";

async function main() {
  const raw = await api.fetchCryptoMarkets();
  console.log(`Total markets: ${raw?.length || 0}\n`);

  if (!raw) return;
  const now = Date.now();

  for (const m of raw) {
    const slug = (m.events?.[0]?.slug || "").toLowerCase();
    const endDate = m.end_date_iso ? new Date(m.end_date_iso).getTime() : 0;
    const secsLeft = endDate > 0 ? (endDate - now) / 1000 : 0;
    const minsLeft = Math.floor(secsLeft / 60);

    let prices = m.outcomePrices;
    if (typeof prices === "string") try { prices = JSON.parse(prices); } catch { prices = null; }
    const upPrice = parseFloat(prices?.[0]) || 0;

    let tokenIds = m.clobTokenIds;
    if (typeof tokenIds === "string") try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }

    const isBtc = slug.startsWith("btc-") || slug.startsWith("bitcoin-");
    console.log(`${isBtc ? ">>> BTC" : "   "} ${slug.slice(0, 60).padEnd(60)} | UP=$${upPrice.toFixed(3)} | ${minsLeft}min | tokens=${tokenIds?.[0] ? "YES" : "NO"}`);
  }
}

main().catch(e => console.error(e));
