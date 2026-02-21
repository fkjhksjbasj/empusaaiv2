// Monitor 5m market resolution and check if tokens get auto-redeemed
import { config } from 'dotenv'; config();
import { ClobOrders } from './lib/clob-orders.js';

const MARKET_TS = 1771607400; // 12:10-12:15 ET window
const UP_TOKEN = '52541984860644018543576616791986611655394619278731168697830478774906119629686';

const c = new ClobOrders();
await c.init(process.env.POLYMARKET_PRIVATE_KEY);

async function check() {
  const slug = 'btc-updown-5m-' + MARKET_TS;
  const r = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
  const data = await r.json();
  const m = data[0]?.markets?.[0];

  const tokenBal = await c.client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: UP_TOKEN });
  const shares = parseFloat(tokenBal.balance) / 1e6;
  const usdc = await c.getBalance();

  console.log(`[${new Date().toISOString().slice(11,19)}]`,
    'Market:', m?.closed ? 'CLOSED' : 'OPEN',
    '| Resolution:', m?.resolution || 'none',
    '| UP price:', m?.outcomePrices?.[0],
    '| Shares held:', shares.toFixed(4),
    '| USDC:', usdc.toFixed(4));

  if (m?.closed || shares < 0.01) {
    console.log('\nMarket resolved or shares redeemed!');
    console.log('Final USDC:', usdc.toFixed(4));
    clearInterval(iv);
    process.exit(0);
  }
}

check();
const iv = setInterval(check, 10000); // Check every 10s

// Timeout after 10 minutes
setTimeout(() => {
  console.log('Timeout reached');
  clearInterval(iv);
  process.exit(0);
}, 600000);
