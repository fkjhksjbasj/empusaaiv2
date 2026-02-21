import { config } from 'dotenv'; config();
import { ClobOrders } from './lib/clob-orders.js';

const c = new ClobOrders();
await c.init(process.env.POLYMARKET_PRIVATE_KEY);

const tokenId = '52541984860644018543576616791986611655394619278731168697830478774906119629686';

// Check exact balance
const tokenBal = await c.client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
const shares = parseFloat(tokenBal.balance) / 1e6;
console.log('Exact shares held:', shares);

if (shares < 0.01) {
  console.log('No shares to sell');
  process.exit(0);
}

// Check orderbook
const bookR = await fetch('https://clob.polymarket.com/book?token_id=' + tokenId);
const book = await bookR.json();
const bids = (book.bids || []).sort((a,b) => parseFloat(b.price) - parseFloat(a.price));
console.log('Top bids:', bids.slice(0,3).map(b => b.price + ' x' + b.size));

if (bids.length === 0) {
  console.log('No bids available. Cannot sell.');
  process.exit(1);
}

const bestBid = parseFloat(bids[0].price);
console.log('Best bid:', bestBid);
console.log('Estimated proceeds:', (shares * bestBid).toFixed(4));

// Sell at bid price
const sellResult = await c.sellShares(tokenId, shares, bestBid, false);
console.log('Sell result:', JSON.stringify(sellResult, null, 2));

if (sellResult.success === false) {
  // Try lower price
  const lowPrice = Math.max(bestBid - 0.03, 0.01);
  console.log('Retrying at lower price:', lowPrice);
  const retry = await c.sellShares(tokenId, shares, lowPrice, true);
  console.log('Retry result:', JSON.stringify(retry, null, 2));
}

const finalBal = await c.getBalance();
console.log('\nFinal USDC balance:', finalBal);
