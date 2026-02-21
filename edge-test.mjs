// Edge test: Monitor 5m BTC up/down markets on Polymarket
// Tracks BTC price vs token midpoint, orderbook depth, momentum
// Runs for ~2 full 5-minute windows

const nowSec = Math.floor(Date.now() / 1000);
const currentStart = Math.floor(nowSec / 300) * 300;
const nextStart = currentStart + 300;

console.log("Fetching token IDs for current and next windows...");

async function getTokens(timestamp) {
  const slug = "btc-updown-5m-" + timestamp;
  const r = await fetch("https://gamma-api.polymarket.com/events?slug=" + slug);
  const data = await r.json();
  if (!data.length) return null;
  const m = data[0].markets[0];
  // clobTokenIds is a JSON string, must parse it
  const tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
  // tokens[0] = UP (Yes), tokens[1] = DOWN (No)
  return { up: tokens[0], dn: tokens[1], title: m.question };
}

const currentTokens = await getTokens(currentStart);
const nextTokens = await getTokens(nextStart);

if (!currentTokens) { console.log("No current window found"); process.exit(1); }

console.log("Current:", currentTokens.title);
console.log("Next:", nextTokens ? nextTokens.title : "not yet available");

const thirdStart = nextStart + 300;
const CURRENT_END = currentStart + 300;
const NEXT_END = nextStart + 300;
const THIRD_END = thirdStart + 300;

let samples = [];
let phase = "current";
let upToken = currentTokens.up;
let dnToken = currentTokens.dn;
let prevBTC = null;
let prevUp = null;
let sampleCount = 0;
let windowOpenBTC = null;

async function fetchAll() {
  try {
    const [btcR, upR, dnR, bookR] = await Promise.all([
      fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
      fetch("https://clob.polymarket.com/midpoint?token_id=" + upToken),
      fetch("https://clob.polymarket.com/midpoint?token_id=" + dnToken),
      fetch("https://clob.polymarket.com/book?token_id=" + upToken),
    ]);
    const btcData = await btcR.json();
    const upData = await upR.json();
    const dnData = await dnR.json();
    const bookData = await bookR.json();

    const btc = parseFloat(btcData.price);
    const up = parseFloat(upData.mid);
    const dn = parseFloat(dnData.mid);

    // Parse orderbook
    let bestBid = 0, bestAsk = 1, bidDepth = 0, askDepth = 0;
    if (bookData.bids && bookData.bids.length) {
      bestBid = parseFloat(bookData.bids[0].price);
      bidDepth = bookData.bids.slice(0, 3).reduce((s, b) => s + parseFloat(b.size), 0);
    }
    if (bookData.asks && bookData.asks.length) {
      bestAsk = parseFloat(bookData.asks[0].price);
      askDepth = bookData.asks.slice(0, 3).reduce((s, a) => s + parseFloat(a.size), 0);
    }
    const spread = bestAsk - bestBid;

    const nowSec = Date.now() / 1000;
    const endTime = phase === "current" ? CURRENT_END : NEXT_END;
    const secsLeft = Math.round(endTime - nowSec);

    if (windowOpenBTC === null) windowOpenBTC = btc;

    // Direction analysis
    let btcDir = "-";
    let tokenDir = "-";
    let correct = null;

    if (prevBTC !== null) {
      const btcDelta = btc - prevBTC;
      const upDelta = up - prevUp;

      if (Math.abs(btcDelta) > 1) {
        btcDir = btcDelta > 0 ? "UP" : "DN";
        tokenDir = upDelta > 0 ? "UP" : (upDelta < 0 ? "DN" : "FLAT");
        if (tokenDir !== "FLAT") {
          correct = btcDir === tokenDir;
        }
      }
    }

    const btcFromOpen = btc - windowOpenBTC;

    const sample = {
      t: Date.now(),
      secsLeft,
      phase,
      btc,
      up,
      dn,
      bestBid,
      bestAsk,
      spread: spread.toFixed(4),
      bidDepth: Math.round(bidDepth),
      askDepth: Math.round(askDepth),
      btcDelta: prevBTC ? (btc - prevBTC).toFixed(2) : "0",
      upDelta: prevUp ? ((up - prevUp) * 100).toFixed(2) : "0",
      btcDir,
      tokenDir,
      correct,
      btcFromOpen: btcFromOpen.toFixed(2),
      momentum: prevBTC ? ((btc - prevBTC) / 2).toFixed(2) : "0",
    };

    samples.push(sample);
    sampleCount++;

    const correctStr = correct === null ? "  " : (correct ? "Y" : "N");
    console.log(
      phase.padEnd(7) + " " +
      String(secsLeft).padStart(4) + "s " +
      btc.toFixed(2) + " " +
      "UP=" + up.toFixed(4) + " " +
      "DN=" + dn.toFixed(4) + " " +
      "spd=" + sample.spread + " " +
      "bd=" + String(sample.bidDepth).padStart(5) + " " +
      "ad=" + String(sample.askDepth).padStart(5) + " " +
      "btcD=" + String(sample.btcDelta).padStart(7) + " " +
      "upD=" + String(sample.upDelta).padStart(7) + " " +
      correctStr + " " +
      "fromOpen=" + sample.btcFromOpen
    );

    prevBTC = btc;
    prevUp = up;

    // Check if we need to switch windows
    if (phase === "current" && nowSec >= CURRENT_END) {
      console.log("\n=== SWITCHING TO WINDOW 2 ===\n");
      phase = "next";
      try {
        const freshNext = await getTokens(nextStart);
        if (freshNext) {
          upToken = freshNext.up; dnToken = freshNext.dn;
          console.log("Window 2:", freshNext.title);
        }
      } catch (e2) {
        if (nextTokens) { upToken = nextTokens.up; dnToken = nextTokens.dn; }
      }
      prevBTC = null; prevUp = null; windowOpenBTC = null;
    }
    if (phase === "next" && nowSec >= NEXT_END) {
      console.log("\n=== SWITCHING TO WINDOW 3 ===\n");
      phase = "third";
      try {
        const freshThird = await getTokens(thirdStart);
        if (freshThird) {
          upToken = freshThird.up; dnToken = freshThird.dn;
          console.log("Window 3:", freshThird.title);
        }
      } catch (e2) { console.log("W3 fetch err:", e2.message); }
      prevBTC = null; prevUp = null; windowOpenBTC = null;
    }

    // Stop after third window ends (+15s buffer)
    if (nowSec >= THIRD_END + 15) {
      clearInterval(iv);
      analyze();
    }
  } catch (e) {
    console.log("ERR:", e.message);
  }
}

function analyze() {
  console.log("\n\n========== FULL ANALYSIS ==========");
  console.log("Total samples:", samples.length);

  for (const ph of ["current", "next", "third"]) {
    const phs = samples.filter((s) => s.phase === ph);
    if (phs.length === 0) continue;
    console.log("\n--- Phase:", ph, "(" + phs.length + " samples) ---");

    // Unique prices
    const uniqueUp = new Set(phs.map((s) => s.up)).size;
    const uniqueBTC = new Set(phs.map((s) => s.btc)).size;
    console.log("Unique UP prices:", uniqueUp, "| Unique BTC prices:", uniqueBTC);

    // UP token range
    const ups = phs.map((s) => s.up);
    console.log("UP range:", Math.min(...ups).toFixed(4), "->", Math.max(...ups).toFixed(4));

    // BTC range
    const btcs = phs.map((s) => s.btc);
    console.log("BTC range:", Math.min(...btcs).toFixed(2), "->", Math.max(...btcs).toFixed(2),
      "($" + (Math.max(...btcs) - Math.min(...btcs)).toFixed(2) + " swing)");

    const dirSamples = phs.filter((s) => s.correct !== null);
    const correctCount = dirSamples.filter((s) => s.correct === true).length;
    const wrongCount = dirSamples.filter((s) => s.correct === false).length;
    console.log(
      "Direction matches:", correctCount, "/", dirSamples.length,
      "(" + (dirSamples.length > 0 ? (100 * correctCount / dirSamples.length).toFixed(1) : "N/A") + "%)"
    );

    // By time remaining buckets
    const buckets = [
      { label: ">200s", min: 200, max: 999 },
      { label: "100-200s", min: 100, max: 200 },
      { label: "30-100s", min: 30, max: 100 },
      { label: "<30s", min: 0, max: 30 },
    ];
    for (const b of buckets) {
      const bs = dirSamples.filter((s) => s.secsLeft >= b.min && s.secsLeft < b.max);
      if (bs.length === 0) continue;
      const bc = bs.filter((s) => s.correct).length;
      console.log("  " + b.label + ": " + bc + "/" + bs.length +
        " (" + (100 * bc / bs.length).toFixed(1) + "%)");
    }

    // By BTC move magnitude
    const bigMoves = dirSamples.filter((s) => Math.abs(parseFloat(s.btcDelta)) > 10);
    const bigCorrect = bigMoves.filter((s) => s.correct).length;
    if (bigMoves.length > 0) {
      console.log("Big BTC moves (>$10):", bigCorrect + "/" + bigMoves.length +
        " (" + (100 * bigCorrect / bigMoves.length).toFixed(1) + "%)");
    }

    const smallMoves = dirSamples.filter(
      (s) => Math.abs(parseFloat(s.btcDelta)) <= 10 && Math.abs(parseFloat(s.btcDelta)) > 1
    );
    const smallCorrect = smallMoves.filter((s) => s.correct).length;
    if (smallMoves.length > 0) {
      console.log("Small BTC moves ($1-10):", smallCorrect + "/" + smallMoves.length +
        " (" + (100 * smallCorrect / smallMoves.length).toFixed(1) + "%)");
    }

    // Spread analysis
    const spreads = phs.map((s) => parseFloat(s.spread));
    console.log(
      "Spread: min=" + Math.min(...spreads).toFixed(4) +
      " max=" + Math.max(...spreads).toFixed(4) +
      " avg=" + (spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(4)
    );

    // Consecutive direction streak
    let streak = 0, maxStreak = 0, streakDir = null;
    for (const s of dirSamples) {
      if (s.btcDir === streakDir) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 1;
        streakDir = s.btcDir;
      }
    }
    console.log("Max BTC direction streak:", maxStreak);

    // Lag analysis for big moves
    console.log("\nLag analysis (big moves >$15):");
    for (let i = 0; i < phs.length; i++) {
      const s = phs[i];
      const btcD = parseFloat(s.btcDelta);
      if (Math.abs(btcD) > 15) {
        const dir = btcD > 0 ? "UP" : "DN";
        let reactions = "";
        for (let j = 1; j <= 3 && i + j < phs.length; j++) {
          const ns = phs[i + j];
          const nUpD = parseFloat(ns.upDelta);
          reactions += " t+" + (j * 2) + "s:" + (nUpD > 0 ? "+" : "") + nUpD;
        }
        console.log("  BTC " + dir + " $" + Math.abs(btcD).toFixed(0) +
          " at " + s.secsLeft + "s left -> same-tick token:" + s.upDelta + " |" + reactions);
      }
    }
  }

  // Overall
  const allDir = samples.filter((s) => s.correct !== null);
  const allCorrect = allDir.filter((s) => s.correct).length;
  console.log("\n=== OVERALL: " + allCorrect + "/" + allDir.length +
    " (" + (allDir.length > 0 ? (100 * allCorrect / allDir.length).toFixed(1) : "N/A") + "%) ===");

  // EDGE HUNT 1: BTC momentum (2 consecutive same-direction) predicts next token move
  console.log("\n=== EDGE HUNT 1: BTC Momentum (2 samples same dir) -> next token ===");
  let momentumCorrect = 0, momentumTotal = 0;
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const next = samples[i + 1];
    if (prev.phase !== curr.phase || curr.phase !== next.phase) continue;

    const prevBtcD = parseFloat(prev.btcDelta);
    const currBtcD = parseFloat(curr.btcDelta);
    const nextUpD = parseFloat(next.upDelta);

    if (Math.abs(prevBtcD) > 2 && Math.abs(currBtcD) > 2 && nextUpD !== 0) {
      const sameDir = (prevBtcD > 0 && currBtcD > 0) || (prevBtcD < 0 && currBtcD < 0);
      if (sameDir) {
        const btcD = currBtcD > 0 ? "UP" : "DN";
        const tokenD = nextUpD > 0 ? "UP" : "DN";
        if (btcD === tokenD) momentumCorrect++;
        momentumTotal++;
      }
    }
  }
  if (momentumTotal > 0) {
    console.log("Result:", momentumCorrect + "/" + momentumTotal +
      " (" + (100 * momentumCorrect / momentumTotal).toFixed(1) + "%)");
  } else {
    console.log("Not enough data");
  }

  // EDGE HUNT 2: Wide spread + BTC direction -> next token
  console.log("\n=== EDGE HUNT 2: Wide spread (>0.03) + BTC dir -> next token ===");
  let wideCorrect = 0, wideTotal = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const curr = samples[i];
    const next = samples[i + 1];
    if (curr.phase !== next.phase) continue;
    const spread = parseFloat(curr.spread);
    const btcD = parseFloat(curr.btcDelta);
    const nextUpD = parseFloat(next.upDelta);

    if (spread > 0.03 && Math.abs(btcD) > 2 && nextUpD !== 0) {
      const btcDir = btcD > 0 ? "UP" : "DN";
      const tokenDir = nextUpD > 0 ? "UP" : "DN";
      if (btcDir === tokenDir) wideCorrect++;
      wideTotal++;
    }
  }
  if (wideTotal > 0) {
    console.log("Result:", wideCorrect + "/" + wideTotal +
      " (" + (100 * wideCorrect / wideTotal).toFixed(1) + "%)");
  } else {
    console.log("Not enough data");
  }

  // EDGE HUNT 3: Orderbook imbalance predicts next move
  console.log("\n=== EDGE HUNT 3: Orderbook imbalance (>1.5x) -> next move ===");
  let obCorrect = 0, obTotal = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const curr = samples[i];
    const next = samples[i + 1];
    if (curr.phase !== next.phase) continue;
    const bd = curr.bidDepth;
    const ad = curr.askDepth;
    const nextUpD = parseFloat(next.upDelta);
    if (nextUpD === 0 || ad === 0) continue;

    const ratio = bd / ad;
    if (ratio > 1.5) {
      if (nextUpD > 0) obCorrect++;
      obTotal++;
    } else if (ratio < 0.67) {
      if (nextUpD < 0) obCorrect++;
      obTotal++;
    }
  }
  if (obTotal > 0) {
    console.log("Result:", obCorrect + "/" + obTotal +
      " (" + (100 * obCorrect / obTotal).toFixed(1) + "%)");
  } else {
    console.log("Not enough data");
  }

  // EDGE HUNT 4: BTC distance from window open price predicts resolution
  console.log("\n=== EDGE HUNT 4: BTC vs window open price -> token direction ===");
  // If BTC is above window open, UP token should be > 0.5
  let openCorrect = 0, openTotal = 0;
  for (const s of samples) {
    const fromOpen = parseFloat(s.btcFromOpen);
    if (Math.abs(fromOpen) > 5) { // meaningful distance from open
      const expectedUp = fromOpen > 0;
      const actualUp = s.up > 0.5;
      if (expectedUp === actualUp) openCorrect++;
      openTotal++;
    }
  }
  if (openTotal > 0) {
    console.log("Result:", openCorrect + "/" + openTotal +
      " (" + (100 * openCorrect / openTotal).toFixed(1) + "%)");
  } else {
    console.log("Not enough data");
  }

  // EDGE HUNT 5: Token price deviation from BTC-implied fair value
  console.log("\n=== EDGE HUNT 5: Token mispricing vs BTC position ===");
  let mispricingEvents = [];
  for (const ph of ["current", "next", "third"]) {
    const phs = samples.filter((s) => s.phase === ph);
    if (phs.length < 5) continue;
    for (let i = 0; i < phs.length; i++) {
      const s = phs[i];
      const fromOpen = parseFloat(s.btcFromOpen);
      // Simple model: if BTC is $50+ above open, UP should be ~0.7+
      // if BTC is $50+ below open, UP should be ~0.3-
      // This is crude but shows if token is lagging
      let expectedUp;
      if (Math.abs(fromOpen) < 10) expectedUp = 0.5;
      else if (fromOpen > 0) expectedUp = 0.5 + Math.min(0.45, fromOpen / 200);
      else expectedUp = 0.5 + Math.max(-0.45, fromOpen / 200);

      const deviation = s.up - expectedUp;
      if (Math.abs(deviation) > 0.1) {
        mispricingEvents.push({
          phase: ph,
          secsLeft: s.secsLeft,
          btcFromOpen: fromOpen.toFixed(0),
          expectedUp: expectedUp.toFixed(3),
          actualUp: s.up.toFixed(4),
          deviation: deviation.toFixed(3),
        });
      }
    }
  }
  if (mispricingEvents.length > 0) {
    console.log("Found", mispricingEvents.length, "mispricing events (deviation > 0.10):");
    for (const e of mispricingEvents.slice(0, 10)) {
      console.log("  " + e.phase + " " + e.secsLeft + "s left: BTC fromOpen=$" + e.btcFromOpen +
        " expected=" + e.expectedUp + " actual=" + e.actualUp + " dev=" + e.deviation);
    }
    if (mispricingEvents.length > 10) {
      console.log("  ... and " + (mispricingEvents.length - 10) + " more");
    }
  } else {
    console.log("No significant mispricings found");
  }

  console.log("\n========== DONE ==========");
}

console.log("\nStarting monitor... sampling every 2s");
console.log("phase    secs  BTC        UP       DN       spread  bidD   askD   btcDelta  upDelta   match  fromOpen");
fetchAll();
const iv = setInterval(fetchAll, 2000);

// Safety timeout at 12 minutes
setTimeout(() => {
  clearInterval(iv);
  analyze();
}, 720000);
