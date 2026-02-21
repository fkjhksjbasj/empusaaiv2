// ═══════════════════════════════════════════════════════════════════
//  MarketIntelligence — The "Trader Brain"
//  Understands market structure, traps, regimes, and smart money
//
//  Based on market microstructure research:
//  - Kyle (1985): informed traders move prices through order flow
//  - Cont et al (2014): order flow imbalance predicts short-term returns
//  - Easley & O'Hara (1987): volume/price dynamics reveal information
//  - Mandelbrot (1963): volatility clusters, Hurst exponent for trend detection
//  - Chordia et al (2002): liquidity, bid-ask dynamics, mean reversion
//  - Bouchaud et al (2004): price impact and market microstructure
//  - Andersen & Bollerslev (1998): intraday seasonality and volatility patterns
//  - Brogaard et al (2014): high-frequency trading and price discovery
// ═══════════════════════════════════════════════════════════════════

// Round number levels by asset (psychological S/R)
const ROUND_LEVELS = {
  BTC: [100, 250, 500, 1000, 5000, 10000],
  ETH: [5, 10, 25, 50, 100, 500],
  SOL: [0.5, 1, 2, 5, 10, 25],
};

// How often to recompute full analysis (ms) — cache between
const ANALYSIS_TTL = 1500;  // 1.5s
const SWING_LOOKBACK = 8;   // bars to confirm swing high/low
const MIN_HISTORY = 30;     // minimum price entries for any analysis

export class MarketIntelligence {
  constructor() {
    // Per-asset cached analysis
    this._cache = {};        // { BTC: { ts, result } }
    // Per-asset swing points
    this._swings = {};       // { BTC: { highs: [], lows: [] } }
    // Regime history (for detecting regime changes)
    this._regimeHistory = {};// { BTC: [{ regime, ts }...] }
    // Flip cooldown: track recent exits to prevent re-entry churn
    this._recentExits = {};  // { conditionId: ts }
    // Volume baseline (adaptive)
    this._volBaseline = {};  // { BTC: { avg, samples } }
  }

  // ═══════════════════════════════════════════════
  //  MAIN ENTRY ANALYSIS
  //  Called before opening a position
  //  Returns: { veto, vetoReason, convictionMult, regime, ... }
  // ═══════════════════════════════════════════════

  analyze(asset, side, priceHistory, options = {}) {
    if (!priceHistory || priceHistory.length < MIN_HISTORY) {
      return this._neutral("insufficient-data");
    }

    // Check cache
    const now = Date.now();
    const cacheKey = `${asset}-${side}`;
    if (this._cache[cacheKey] && now - this._cache[cacheKey].ts < ANALYSIS_TTL) {
      return this._cache[cacheKey].result;
    }

    const current = priceHistory[priceHistory.length - 1].price;

    // Run all analyses
    const regime = this._detectRegime(priceHistory);
    const swings = this._detectSwingPoints(priceHistory);
    this._swings[asset] = swings;
    const keyLevels = this._buildKeyLevels(asset, current, swings);
    const vwap = this._calculateVWAP(priceHistory);
    const exhaustion = this._measureExhaustion(priceHistory);
    const trap = this._detectTrap(side, priceHistory, keyLevels, vwap);
    const smartMoney = this._detectSmartMoney(priceHistory);
    const momQuality = this._analyzeMomentumQuality(priceHistory, side);
    const structure = this._analyzeStructure(side, current, keyLevels, vwap);
    const volProfile = this._analyzeVolumeProfile(priceHistory, current);
    const priceAction = this._detectPriceAction(priceHistory, side);

    // ═══ BUILD VERDICT ═══
    let veto = false;
    let vetoReason = "";
    let convictionMult = 1.0;
    const boosts = [];
    const penalties = [];

    // 1. REGIME CHECK — most impactful filter
    //    Don't enter momentum trades in mean-reverting/choppy markets
    const sideDir = side === "UP" ? 1 : -1;
    if (regime.type === "MEAN_REVERTING") {
      // In mean-reverting regime, momentum entries are dangerous
      // Only allow if entering IN the mean-reversion direction (fading the move)
      if (sideDir === regime.direction) {
        // Trying to ride momentum in a mean-reverting market = bad
        convictionMult *= 0.4;
        penalties.push("regime-mean-revert");
      } else {
        // Fading the move in mean-reverting market = good
        convictionMult *= 1.2;
        boosts.push("regime-fade");
      }
    } else if (regime.type === "CHOPPY") {
      // v9.1: Reduced penalty — choppy markets are still tradeable with caution
      // Old: 0.3x + hard veto at confidence>0.6 blocked ALL entries
      convictionMult *= 0.6;
      penalties.push("regime-choppy");
    } else if (regime.type === "TRENDING_UP" || regime.type === "TRENDING_DOWN") {
      const trendDir = regime.type === "TRENDING_UP" ? 1 : -1;
      if (sideDir === trendDir) {
        // With the trend — good
        convictionMult *= 1.15 + regime.confidence * 0.15;
        boosts.push("with-trend");
      } else {
        // Counter-trend — risky
        convictionMult *= 0.5;
        penalties.push("counter-trend");
        if (regime.confidence > 0.7) {
          veto = true;
          vetoReason = `counter-trend-${regime.type}`;
        }
      }
    }

    // 2. TRAP CHECK
    if (trap.isTrap) {
      if (trap.confidence > 0.6) {
        veto = true;
        vetoReason = `trap-${trap.reasons[0]}`;
      } else {
        convictionMult *= (1 - trap.confidence * 0.5);
        penalties.push("trap-risk");
      }
    }

    // 3. EXHAUSTION CHECK — don't enter at the end of a move
    if (exhaustion.level > 0.7 && sideDir === exhaustion.direction) {
      // Trying to enter in the direction of an exhausted move
      veto = true;
      vetoReason = `exhausted-move-${exhaustion.reasons[0]}`;
    } else if (exhaustion.level > 0.4 && sideDir === exhaustion.direction) {
      convictionMult *= (1 - exhaustion.level * 0.4);
      penalties.push("partial-exhaust");
    } else if (exhaustion.level > 0.5 && sideDir !== exhaustion.direction) {
      // Fading an exhausted move — good
      convictionMult *= 1.1;
      boosts.push("fade-exhaust");
    }

    // 4. STRUCTURE CHECK — support/resistance alignment
    if (structure.entryQuality < 0.3) {
      convictionMult *= 0.5;
      penalties.push("poor-structure");
    } else if (structure.entryQuality > 0.7) {
      convictionMult *= 1.15;
      boosts.push("good-structure");
    }
    // Veto entries right at resistance (for UP) or right at support (for DOWN)
    if (structure.atResistance && side === "UP") {
      veto = true;
      vetoReason = "entering-at-resistance";
    }
    if (structure.atSupport && side === "DOWN") {
      veto = true;
      vetoReason = "entering-at-support";
    }

    // 5. SMART MONEY CHECK
    if (smartMoney.signal !== 0) {
      if (Math.sign(smartMoney.signal) === sideDir) {
        convictionMult *= 1.1 + Math.abs(smartMoney.signal) * 0.2;
        boosts.push("smart-money-agree");
      } else if (Math.abs(smartMoney.signal) > 0.4) {
        convictionMult *= 0.6;
        penalties.push("smart-money-disagree");
      }
    }

    // 6. MOMENTUM QUALITY
    if (momQuality.quality < 0.3) {
      convictionMult *= 0.6;
      penalties.push("weak-momentum");
    } else if (momQuality.quality > 0.7) {
      convictionMult *= 1.1;
      boosts.push("strong-momentum");
    }

    // 7. VWAP DEVIATION — extreme deviation suggests mean reversion
    if (Math.abs(vwap.deviation) > 2.0) {
      if (sideDir === Math.sign(vwap.deviation)) {
        // Entering further from VWAP in the same direction = risky
        convictionMult *= 0.6;
        penalties.push("vwap-extended");
      } else {
        // Fading back to VWAP = good
        convictionMult *= 1.15;
        boosts.push("vwap-reversion");
      }
    }

    // 8. PRICE ACTION PATTERNS
    if (priceAction.signal !== 0) {
      if (Math.sign(priceAction.signal) === sideDir) {
        convictionMult *= 1.1;
        boosts.push(priceAction.pattern);
      } else if (Math.abs(priceAction.signal) > 0.5) {
        convictionMult *= 0.7;
        penalties.push(`anti-${priceAction.pattern}`);
      }
    }

    // 9. VOLUME PROFILE — entering into high-volume node (strong S/R)
    if (volProfile.atHighVolNode) {
      if ((side === "UP" && volProfile.nodeIsSupport) || (side === "DOWN" && volProfile.nodeIsResistance)) {
        convictionMult *= 1.1;
        boosts.push("vol-node-support");
      } else {
        convictionMult *= 0.8;
        penalties.push("vol-node-barrier");
      }
    }

    // 10. CHART PATTERNS — multi-bar pattern recognition (channels, H&S, triangles, etc.)
    const chart = this.analyzeChart(priceHistory, side);
    if (chart.patterns.length > 0) {
      if (chart.bias * sideDir > 0.3) {
        // Chart patterns favor our direction — boost
        convictionMult *= 1.0 + Math.min(chart.confidence * 0.3, 0.3);
        boosts.push(`chart:${chart.reason}`);
      } else if (chart.bias * sideDir < -0.3) {
        // Chart patterns against us — penalize or veto
        if (chart.confidence > 0.65) {
          veto = true;
          vetoReason = `chart-pattern-${chart.reason}`;
        } else {
          convictionMult *= 1.0 - Math.min(chart.confidence * 0.4, 0.35);
          penalties.push(`chart:${chart.reason}`);
        }
      }
    }

    // Clamp multiplier
    convictionMult = Math.max(0.2, Math.min(1.5, convictionMult));

    const result = {
      veto,
      vetoReason,
      convictionMult,
      boosts,
      penalties,
      regime,
      trap,
      exhaustion: { level: exhaustion.level, direction: exhaustion.direction, reasons: exhaustion.reasons },
      structure,
      smartMoney,
      momQuality,
      vwap: { vwap: vwap.vwap, deviation: vwap.deviation },
      priceAction,
      volProfile: { atHighVolNode: volProfile.atHighVolNode },
      chart: { patterns: chart.patterns.map(p => p.name), bias: chart.bias, confidence: chart.confidence, reason: chart.reason },
    };

    this._cache[cacheKey] = { ts: now, result };
    return result;
  }

  // ═══════════════════════════════════════════════
  //  EXIT ANALYSIS
  //  Called when managing open positions
  //  Returns: { holdThrough, exitNow, reason, ... }
  // ═══════════════════════════════════════════════

  analyzeExit(asset, side, entryPrice, currentPrice, peakGain, unrealized, priceHistory) {
    if (!priceHistory || priceHistory.length < MIN_HISTORY) {
      return { holdThrough: false, exitNow: false };
    }

    const regime = this._detectRegime(priceHistory);
    const exhaustion = this._measureExhaustion(priceHistory);
    const vwap = this._calculateVWAP(priceHistory);
    const momQuality = this._analyzeMomentumQuality(priceHistory, side);
    const sideDir = side === "UP" ? 1 : -1;

    let holdThrough = false;
    let exitNow = false;
    let reason = "";

    // 1. HEALTHY RETRACEMENT IN TREND — don't exit
    //    If we're in a strong trend in our direction and the pullback is small,
    //    this is normal — hold through it
    if (regime.type === "TRENDING_UP" && side === "UP" && regime.confidence > 0.5) {
      if (unrealized > -0.02 && peakGain > 0.01 && momQuality.quality > 0.4) {
        holdThrough = true;
        reason = "healthy-pullback-in-uptrend";
      }
    }
    if (regime.type === "TRENDING_DOWN" && side === "DOWN" && regime.confidence > 0.5) {
      if (unrealized > -0.02 && peakGain > 0.01 && momQuality.quality > 0.4) {
        holdThrough = true;
        reason = "healthy-pullback-in-downtrend";
      }
    }

    // 2. EXHAUSTION IN OUR DIRECTION — exit early
    if (exhaustion.level > 0.6 && exhaustion.direction === sideDir && unrealized > 0) {
      exitNow = true;
      reason = `exhaustion-take-profit-${exhaustion.reasons[0]}`;
    }

    // 3. REGIME CHANGE — trend reversed while we're in position
    if (regime.type === "TRENDING_UP" && side === "DOWN" && regime.confidence > 0.6) {
      exitNow = true;
      reason = "regime-changed-against-us";
    }
    if (regime.type === "TRENDING_DOWN" && side === "UP" && regime.confidence > 0.6) {
      exitNow = true;
      reason = "regime-changed-against-us";
    }

    // 4. VWAP SNAP-BACK — if price extended far from VWAP and now returning
    //    This is mean reversion, supports holding if it's moving in our direction
    if (Math.abs(vwap.deviation) < 0.5 && unrealized > 0) {
      // Price returned to VWAP — good exit point
      exitNow = true;
      reason = "vwap-mean-reversion-target";
    }

    // 5. MOMENTUM QUALITY DETERIORATING — healthy trend becoming unhealthy
    if (momQuality.quality < 0.2 && momQuality.decelerating && unrealized < 0) {
      exitNow = true;
      reason = "momentum-dying";
    }

    // 6. CHART PATTERN EXIT INTELLIGENCE
    // Chart patterns are the strongest signal — they override weaker indicators
    const chart = this.analyzeChart(priceHistory, side);
    if (chart.patterns.length > 0) {
      // Strong reversal pattern against us (H&S, double top, breakdown) → EXIT
      if (chart.exitSignal && chart.confidence > 0.55) {
        exitNow = true;
        reason = `chart-exit:${chart.reason}`;
      }
      // Continuation pattern in our direction (flag, channel, breakout) → HOLD
      if (chart.holdSignal && chart.confidence > 0.45) {
        holdThrough = true;
        if (!reason) reason = `chart-hold:${chart.reason}`;
      }
    }

    return { holdThrough, exitNow, reason, chart };
  }

  // ═══════════════════════════════════════════════
  //  FLIP COOLDOWN — prevent re-entry churn
  // ═══════════════════════════════════════════════

  recordExit(conditionId) {
    this._recentExits[conditionId] = Date.now();
    // Clean old entries
    const cutoff = Date.now() - 120000; // 2 min
    for (const [id, ts] of Object.entries(this._recentExits)) {
      if (ts < cutoff) delete this._recentExits[id];
    }
  }

  canReenter(conditionId) {
    const lastExit = this._recentExits[conditionId];
    if (!lastExit) return true;
    // Must wait 45 seconds before re-entering same market
    return Date.now() - lastExit > 45000;
  }

  // ═══════════════════════════════════════════════
  //  REGIME DETECTION
  //  Uses autocorrelation + trend strength + Hurst exponent
  //  Output: TRENDING_UP, TRENDING_DOWN, RANGING, MEAN_REVERTING, CHOPPY
  // ═══════════════════════════════════════════════

  _detectRegime(priceHistory) {
    if (priceHistory.length < 60) return { type: "UNKNOWN", confidence: 0, direction: 0 };

    // Sample at 5-second intervals for regime detection
    const step = 5;
    const returns = [];
    for (let i = step; i < priceHistory.length; i += step) {
      const pNow = priceHistory[i].price;
      const pPrev = priceHistory[i - step].price;
      if (pPrev > 0) returns.push((pNow - pPrev) / pPrev);
    }
    if (returns.length < 8) return { type: "UNKNOWN", confidence: 0, direction: 0 };

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);

    // Trend strength: |mean| / std — high = trending, low = noisy
    const trendStrength = std > 0 ? Math.abs(mean) / std : 0;

    // Autocorrelation at lag 1
    // Positive = trending (momentum), Negative = mean-reverting
    let autoCorr = 0;
    for (let i = 1; i < returns.length; i++) {
      autoCorr += returns[i] * returns[i - 1];
    }
    autoCorr /= (returns.length - 1);
    const normAutoCorr = variance > 0 ? autoCorr / variance : 0;

    // Hurst exponent approximation via R/S analysis
    // H > 0.5 = trending, H < 0.5 = mean-reverting, H ≈ 0.5 = random walk
    const hurst = this._estimateHurst(returns);

    // Higher-order: acceleration of momentum
    // Is the trend getting stronger or weaker?
    const halfIdx = Math.floor(returns.length / 2);
    const firstHalfMean = returns.slice(0, halfIdx).reduce((a, b) => a + b, 0) / halfIdx;
    const secondHalfMean = returns.slice(halfIdx).reduce((a, b) => a + b, 0) / (returns.length - halfIdx);
    const acceleration = secondHalfMean - firstHalfMean;

    // Classify regime
    let type = "RANGING";
    let confidence = 0.3;
    const direction = mean > 0 ? 1 : mean < 0 ? -1 : 0;

    if (trendStrength > 0.25 && normAutoCorr > 0.05 && hurst > 0.52) {
      type = direction > 0 ? "TRENDING_UP" : "TRENDING_DOWN";
      confidence = Math.min(1, (trendStrength * 2 + normAutoCorr + (hurst - 0.5) * 4) / 3);
    } else if (normAutoCorr < -0.08 || hurst < 0.42) {
      type = "MEAN_REVERTING";
      confidence = Math.min(1, (Math.abs(normAutoCorr) * 2 + (0.5 - hurst) * 4) / 2);
    } else if (std > 0 && std > Math.abs(mean) * 15 && variance > 1e-10) {
      // v9.1: Fixed choppy detection — old formula divided by near-zero mean,
      // producing confidence=1.0 on ALL short-term data (mean≈0 always).
      // New: use variance-based metric that doesn't blow up when mean≈0
      type = "CHOPPY";
      const choppyRatio = Math.abs(mean) > 1e-8 ? std / Math.abs(mean) : 0;
      confidence = Math.min(0.8, choppyRatio / 50);
    }

    return { type, confidence, direction, trendStrength, autoCorr: normAutoCorr, hurst, acceleration };
  }

  _estimateHurst(returns) {
    if (returns.length < 8) return 0.5;

    // Rescaled range analysis
    const n = returns.length;
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    const deviations = returns.map(r => r - mean);

    // Cumulative deviations
    let cumDev = 0;
    let maxCum = -Infinity, minCum = Infinity;
    for (const d of deviations) {
      cumDev += d;
      maxCum = Math.max(maxCum, cumDev);
      minCum = Math.min(minCum, cumDev);
    }
    const R = maxCum - minCum;
    const S = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n);

    if (S <= 0 || R <= 0) return 0.5;

    // H = log(R/S) / log(n)
    const RS = R / S;
    const H = Math.log(RS) / Math.log(n);

    return Math.max(0.1, Math.min(0.9, H));
  }

  // ═══════════════════════════════════════════════
  //  SWING POINT DETECTION
  //  Identifies local highs and lows — the skeleton of price structure
  // ═══════════════════════════════════════════════

  _detectSwingPoints(priceHistory) {
    const highs = [];
    const lows = [];
    const LB = SWING_LOOKBACK;

    if (priceHistory.length < LB * 2 + 1) return { highs, lows };

    for (let i = LB; i < priceHistory.length - LB; i++) {
      const price = priceHistory[i].price;
      let isHigh = true, isLow = true;

      for (let j = i - LB; j <= i + LB; j++) {
        if (j === i) continue;
        if (priceHistory[j].price >= price) isHigh = false;
        if (priceHistory[j].price <= price) isLow = false;
      }

      if (isHigh) highs.push({ price, ts: priceHistory[i].ts, vol: priceHistory[i].vol || 0 });
      if (isLow) lows.push({ price, ts: priceHistory[i].ts, vol: priceHistory[i].vol || 0 });
    }

    return { highs: highs.slice(-15), lows: lows.slice(-15) };
  }

  // ═══════════════════════════════════════════════
  //  KEY LEVELS (Support/Resistance)
  //  Combines swing points + round numbers + volume nodes
  // ═══════════════════════════════════════════════

  _buildKeyLevels(asset, currentPrice, swings) {
    const levels = [];

    // From swing highs → resistance
    for (const h of swings.highs) {
      levels.push({ price: h.price, type: "resistance", source: "swing", strength: 0.7, ts: h.ts });
    }
    // From swing lows → support
    for (const l of swings.lows) {
      levels.push({ price: l.price, type: "support", source: "swing", strength: 0.7, ts: l.ts });
    }

    // Cluster nearby levels — multiple tests of same level = stronger
    const clustered = this._clusterLevels(levels, currentPrice * 0.0005);

    // Add round number levels
    const rounds = ROUND_LEVELS[asset] || [1];
    for (const step of rounds) {
      const lower = Math.floor(currentPrice / step) * step;
      const upper = lower + step;
      const strengthBase = 0.3 + 0.5 * (Math.log2(step) / Math.log2(rounds[rounds.length - 1]));
      const dist = currentPrice - lower;
      const distPct = dist / step;

      if (distPct < 0.9 && distPct > 0.1) {
        clustered.push({ price: lower, type: currentPrice > lower ? "support" : "resistance", source: "round", strength: Math.min(1, strengthBase) });
        clustered.push({ price: upper, type: currentPrice < upper ? "resistance" : "support", source: "round", strength: Math.min(1, strengthBase) });
      }
    }

    // Sort by distance from current price
    clustered.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
    return clustered.slice(0, 20);
  }

  _clusterLevels(levels, tolerance) {
    if (levels.length === 0) return [];
    const sorted = [...levels].sort((a, b) => a.price - b.price);
    const clusters = [];
    let cluster = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].price - cluster[cluster.length - 1].price < tolerance) {
        cluster.push(sorted[i]);
      } else {
        // Average the cluster
        const avgPrice = cluster.reduce((s, l) => s + l.price, 0) / cluster.length;
        const strength = Math.min(1, cluster[0].strength + cluster.length * 0.1);
        clusters.push({ price: avgPrice, type: cluster[0].type, source: "cluster", strength, tests: cluster.length });
        cluster = [sorted[i]];
      }
    }
    // Last cluster
    if (cluster.length > 0) {
      const avgPrice = cluster.reduce((s, l) => s + l.price, 0) / cluster.length;
      const strength = Math.min(1, cluster[0].strength + cluster.length * 0.1);
      clusters.push({ price: avgPrice, type: cluster[0].type, source: "cluster", strength, tests: cluster.length });
    }

    return clusters;
  }

  // ═══════════════════════════════════════════════
  //  VWAP — Volume Weighted Average Price
  //  The "fair value" anchor. Extension from VWAP = mean reversion pressure.
  // ═══════════════════════════════════════════════

  _calculateVWAP(priceHistory) {
    if (priceHistory.length < 10) return { vwap: 0, deviation: 0, sd: 0 };

    let cumPriceVol = 0, cumVol = 0;
    const sqDevs = [];

    for (const entry of priceHistory) {
      const vol = Math.max(entry.vol || 0, 0.001); // minimum weight
      cumPriceVol += entry.price * vol;
      cumVol += vol;
      const currentVwap = cumPriceVol / cumVol;
      sqDevs.push((entry.price - currentVwap) ** 2 * vol);
    }

    const vwap = cumPriceVol / cumVol;
    const variance = sqDevs.reduce((a, b) => a + b, 0) / cumVol;
    const sd = Math.sqrt(variance);
    const current = priceHistory[priceHistory.length - 1].price;
    const deviation = sd > 0 ? (current - vwap) / sd : 0;

    return {
      vwap,
      sd,
      deviation, // +2 = two sigma above VWAP (extended), -2 = below
      upperBand1: vwap + sd,
      lowerBand1: vwap - sd,
      upperBand2: vwap + 2 * sd,
      lowerBand2: vwap - 2 * sd,
    };
  }

  // ═══════════════════════════════════════════════
  //  TRAP DETECTION
  //  Bull traps: false breakout above resistance → reversal
  //  Bear traps: false breakdown below support → reversal
  //  Volume divergence: breakout without volume = likely false
  // ═══════════════════════════════════════════════

  _detectTrap(side, priceHistory, keyLevels, vwap) {
    if (priceHistory.length < 30) return { isTrap: false, confidence: 0, reasons: [] };

    const current = priceHistory[priceHistory.length - 1].price;
    const recent30 = priceHistory.slice(-30);
    const recent10 = priceHistory.slice(-10);
    const recent60 = priceHistory.slice(-Math.min(60, priceHistory.length));

    let trapScore = 0;
    const reasons = [];

    // 1. FALSE BREAKOUT DETECTION
    // Did price recently poke above resistance (or below support) then come back?
    const maxRecent30 = Math.max(...recent30.map(p => p.price));
    const minRecent30 = Math.min(...recent30.map(p => p.price));

    for (const level of keyLevels.slice(0, 8)) {
      if (side === "UP" && level.type === "resistance") {
        // Bull trap: price briefly went above resistance then fell back
        if (maxRecent30 > level.price * 1.0002 && current < level.price * 0.9998) {
          trapScore += 0.35 * level.strength;
          reasons.push("false-breakout-above");
          break;
        }
      }
      if (side === "DOWN" && level.type === "support") {
        // Bear trap: price briefly went below support then bounced
        if (minRecent30 < level.price * 0.9998 && current > level.price * 1.0002) {
          trapScore += 0.35 * level.strength;
          reasons.push("false-breakdown-below");
          break;
        }
      }
    }

    // 2. VOLUME DIVERGENCE ON BREAKOUT
    // Breakout without increasing volume = weak, likely to fail
    const last10Vol = recent10.reduce((s, p) => s + (p.vol || 0), 0) / 10;
    const older20Vol = recent30.slice(0, 20).reduce((s, p) => s + (p.vol || 0), 0) / 20;

    if (older20Vol > 0 && last10Vol < older20Vol * 0.5) {
      trapScore += 0.2;
      reasons.push("low-vol-breakout");
    }

    // 3. RAPID REVERSAL (V-shape / inverted V)
    // Sharp move followed by sharp reversal = trap
    const range30 = maxRecent30 - minRecent30;
    if (range30 > 0) {
      const maxIdx = recent30.findIndex(p => p.price === maxRecent30);
      const minIdx = recent30.findIndex(p => p.price === minRecent30);

      // Bull trap: max was early/mid, now we've come back down significantly
      if (side === "UP" && maxIdx < 22 && maxIdx > 3) {
        const retracement = (maxRecent30 - current) / range30;
        if (retracement > 0.6) {
          trapScore += 0.3 * retracement;
          reasons.push("v-reversal-down");
        }
      }

      // Bear trap: min was early/mid, now we've bounced significantly
      if (side === "DOWN" && minIdx < 22 && minIdx > 3) {
        const retracement = (current - minRecent30) / range30;
        if (retracement > 0.6) {
          trapScore += 0.3 * retracement;
          reasons.push("v-reversal-up");
        }
      }
    }

    // 4. STOP HUNT DETECTION
    // Price spikes to take out stops then immediately reverses
    // Signature: sharp spike on high volume, immediate reversal, volume dies
    if (recent60.length >= 40) {
      const lookback20 = recent60.slice(-20);
      const lookback40 = recent60.slice(-40, -20);
      const spike = this._detectVolumeSpike(lookback40, lookback20);
      if (spike.isSpike) {
        const priceAtSpike = lookback40[lookback40.length - 1].price;
        const reversal = Math.abs(current - priceAtSpike) / (Math.abs(maxRecent30 - minRecent30) + 1e-10);
        if (reversal > 0.5) {
          trapScore += 0.25;
          reasons.push("stop-hunt");
        }
      }
    }

    // 5. ABSORPTION DETECTION
    // High volume at a level but price doesn't break through = strong hand absorbing
    // If we're trying to enter in the direction of the absorbed side, it's a trap
    const recent5Vol = recent10.slice(-5).reduce((s, p) => s + (p.vol || 0), 0);
    const recent5Range = Math.max(...recent10.slice(-5).map(p => p.price)) - Math.min(...recent10.slice(-5).map(p => p.price));
    const avg5Range = range30 / 6;
    if (older20Vol > 0 && recent5Vol > older20Vol * 10 && recent5Range < avg5Range * 0.3) {
      // High volume, low range = absorption happening
      // Someone is absorbing all the buying/selling
      trapScore += 0.2;
      reasons.push("absorption-detected");
    }

    return {
      isTrap: trapScore >= 0.35,
      confidence: Math.min(1, trapScore),
      reasons,
    };
  }

  _detectVolumeSpike(before, after) {
    const beforeAvg = before.reduce((s, p) => s + (p.vol || 0), 0) / before.length;
    const afterMax = Math.max(...after.map(p => p.vol || 0));
    return {
      isSpike: beforeAvg > 0 && afterMax > beforeAvg * 4,
      magnitude: beforeAvg > 0 ? afterMax / beforeAvg : 0,
    };
  }

  // ═══════════════════════════════════════════════
  //  EXHAUSTION DETECTION
  //  Extended moves without retracement snap back
  //  Volume climax at the end of a move signals reversal
  // ═══════════════════════════════════════════════

  _measureExhaustion(priceHistory) {
    if (priceHistory.length < 40) return { level: 0, direction: 0, reasons: [] };

    const recent = priceHistory.slice(-60);
    const current = recent[recent.length - 1].price;
    const start = recent[0].price;
    const totalMove = (current - start) / start;
    const direction = totalMove > 0 ? 1 : totalMove < 0 ? -1 : 0;

    let exhaustion = 0;
    const reasons = [];

    // 1. CONSECUTIVE DIRECTIONAL BARS
    // Count how many 5-second intervals moved in the same direction
    let maxConsecutive = 0, consecutive = 0, prevDir = 0;
    for (let i = 3; i < recent.length; i += 3) {
      const dir = recent[i].price > recent[i - 3].price ? 1 : -1;
      if (dir === prevDir && dir === direction) {
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      } else {
        consecutive = 0;
      }
      prevDir = dir;
    }

    if (maxConsecutive >= 8) { // 24s+ of unbroken directional movement
      exhaustion += 0.3;
      reasons.push(`${maxConsecutive * 3}s-no-pullback`);
    } else if (maxConsecutive >= 5) {
      exhaustion += 0.15;
      reasons.push(`${maxConsecutive * 3}s-run`);
    }

    // 2. VOLUME CLIMAX — highest volume at the end of the move
    const thirds = [
      recent.slice(0, Math.floor(recent.length / 3)),
      recent.slice(Math.floor(recent.length / 3), Math.floor(recent.length * 2 / 3)),
      recent.slice(Math.floor(recent.length * 2 / 3)),
    ];
    const thirdVols = thirds.map(t => t.reduce((s, p) => s + (p.vol || 0), 0) / t.length);

    if (thirdVols[0] > 0 && thirdVols[2] > thirdVols[0] * 2 && thirdVols[2] > thirdVols[1] * 1.5) {
      exhaustion += 0.25;
      reasons.push("volume-climax");
    }

    // 3. MOMENTUM DECELERATION
    // Is the rate of price change decreasing?
    const halfIdx = Math.floor(recent.length / 2);
    const firstHalfMove = (recent[halfIdx].price - recent[0].price) / recent[0].price;
    const secondHalfMove = (current - recent[halfIdx].price) / recent[halfIdx].price;

    if (Math.abs(firstHalfMove) > 0.0001 && Math.sign(firstHalfMove) === direction) {
      const decel = 1 - Math.abs(secondHalfMove) / Math.abs(firstHalfMove);
      if (decel > 0.5) {
        exhaustion += 0.2 * decel;
        reasons.push("momentum-decelerating");
      }
    }

    // 4. VWAP EXTENSION
    const vwap = this._calculateVWAP(recent);
    if (Math.abs(vwap.deviation) > 2.5) {
      exhaustion += 0.15;
      reasons.push(`vwap-${Math.abs(vwap.deviation).toFixed(1)}σ`);
    }

    // 5. PRICE EXTENSION — how far from the mean
    const prices = recent.map(p => p.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const stdDev = Math.sqrt(prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length);
    if (stdDev > 0 && Math.abs(current - mean) > stdDev * 2.5) {
      exhaustion += 0.1;
      reasons.push("price-extended");
    }

    return { level: Math.min(1, exhaustion), direction, reasons };
  }

  // ═══════════════════════════════════════════════
  //  SMART MONEY DETECTION
  //  Large volume patterns that reveal institutional/whale activity
  // ═══════════════════════════════════════════════

  _detectSmartMoney(priceHistory) {
    if (priceHistory.length < 30) return { signal: 0, reasons: [] };

    const recent = priceHistory.slice(-30);
    const current = recent[recent.length - 1];
    let signal = 0;
    const reasons = [];

    const avgVol = recent.reduce((s, p) => s + (p.vol || 0), 0) / recent.length;
    const last5 = recent.slice(-5);
    const last5Vol = last5.reduce((s, p) => s + (p.vol || 0), 0) / 5;
    const last5Avg = last5.reduce((s, p) => s + p.price, 0) / 5;
    const prev5 = recent.slice(-10, -5);
    const prev5Avg = prev5.reduce((s, p) => s + p.price, 0) / 5;

    // 1. ABSORPTION — high volume, price doesn't move
    // Someone is absorbing all selling (bullish) or buying (bearish)
    const last5Range = Math.max(...last5.map(p => p.price)) - Math.min(...last5.map(p => p.price));
    const avgRange = (Math.max(...recent.map(p => p.price)) - Math.min(...recent.map(p => p.price))) / 6;

    if (avgVol > 0 && last5Vol > avgVol * 2.5 && avgRange > 0 && last5Range < avgRange * 0.4) {
      // High vol, low range = absorption
      const rangeAll = Math.max(...recent.map(p => p.price)) - Math.min(...recent.map(p => p.price));
      const position = rangeAll > 0
        ? (current.price - Math.min(...recent.map(p => p.price))) / rangeAll
        : 0.5;

      if (position < 0.35) {
        signal += 0.5;
        reasons.push("bullish-absorption");
      } else if (position > 0.65) {
        signal -= 0.5;
        reasons.push("bearish-absorption");
      }
    }

    // 2. AGGRESSIVE DIRECTIONAL VOLUME
    if (avgVol > 0 && last5Vol > avgVol * 3) {
      const dir = last5Avg > prev5Avg ? 1 : -1;
      signal += dir * 0.3;
      reasons.push(dir > 0 ? "aggressive-buying" : "aggressive-selling");
    }

    // 3. DELTA DIVERGENCE — price moves one way, but the dominant volume is the other
    // Approximation: if price goes up but most volume happened on down-ticks, that's bearish
    let upTickVol = 0, downTickVol = 0;
    for (let i = 1; i < recent.length; i++) {
      const vol = recent[i].vol || 0;
      if (recent[i].price > recent[i - 1].price) upTickVol += vol;
      else if (recent[i].price < recent[i - 1].price) downTickVol += vol;
    }
    const totalTickVol = upTickVol + downTickVol;
    if (totalTickVol > 0) {
      const delta = (upTickVol - downTickVol) / totalTickVol; // -1 to +1
      const priceDir = current.price > recent[0].price ? 1 : -1;

      // Divergence: price up but delta negative (or vice versa)
      if (priceDir > 0 && delta < -0.2) {
        signal -= 0.3;
        reasons.push("bearish-delta-div");
      } else if (priceDir < 0 && delta > 0.2) {
        signal += 0.3;
        reasons.push("bullish-delta-div");
      }
    }

    return { signal: Math.max(-1, Math.min(1, signal)), reasons };
  }

  // ═══════════════════════════════════════════════
  //  MOMENTUM QUALITY
  //  Not just "is there momentum" but "is it healthy/sustainable?"
  //  Healthy: smooth, increasing volume, pullbacks to mean
  //  Unhealthy: choppy, declining volume, no pullbacks
  // ═══════════════════════════════════════════════

  _analyzeMomentumQuality(priceHistory, side) {
    if (priceHistory.length < 30) return { quality: 0.5, decelerating: false };

    const recent = priceHistory.slice(-30);
    const sideDir = side === "UP" ? 1 : -1;
    let quality = 0.5;

    // 1. SMOOTHNESS — low noise in the direction of the move
    // Measure std dev of returns vs the drift
    const returns = [];
    for (let i = 3; i < recent.length; i += 3) {
      returns.push((recent[i].price - recent[i - 3].price) / recent[i - 3].price);
    }
    if (returns.length < 5) return { quality: 0.5, decelerating: false };

    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdReturn = Math.sqrt(returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / returns.length);

    // Are returns consistently in the right direction?
    const correctDirPct = returns.filter(r => Math.sign(r) === sideDir).length / returns.length;
    if (correctDirPct > 0.65) quality += 0.2;
    else if (correctDirPct < 0.4) quality -= 0.2;

    // Smoothness: low std relative to drift
    const smoothness = stdReturn > 0 ? Math.abs(meanReturn) / stdReturn : 0;
    if (smoothness > 0.5) quality += 0.15;
    else if (smoothness < 0.15) quality -= 0.15;

    // 2. VOLUME TREND — increasing volume with the move is healthy
    const firstHalfVol = recent.slice(0, 15).reduce((s, p) => s + (p.vol || 0), 0);
    const secondHalfVol = recent.slice(15).reduce((s, p) => s + (p.vol || 0), 0);
    if (firstHalfVol > 0) {
      const volGrowth = secondHalfVol / firstHalfVol;
      if (volGrowth > 1.3) quality += 0.1;
      else if (volGrowth < 0.5) quality -= 0.15;
    }

    // 3. MOMENTUM ACCELERATION
    const firstHalfReturns = returns.slice(0, Math.floor(returns.length / 2));
    const secondHalfReturns = returns.slice(Math.floor(returns.length / 2));
    const firstMean = firstHalfReturns.reduce((a, b) => a + b, 0) / firstHalfReturns.length;
    const secondMean = secondHalfReturns.reduce((a, b) => a + b, 0) / secondHalfReturns.length;
    const decelerating = (Math.sign(firstMean) === sideDir && Math.abs(secondMean) < Math.abs(firstMean) * 0.5);

    if (decelerating) quality -= 0.15;
    else if (Math.abs(secondMean) > Math.abs(firstMean) * 1.2 && Math.sign(secondMean) === sideDir) {
      quality += 0.1; // accelerating in our direction
    }

    return { quality: Math.max(0, Math.min(1, quality)), decelerating };
  }

  // ═══════════════════════════════════════════════
  //  STRUCTURE ANALYSIS
  //  Where are we in the price structure?
  //  Entering near support (for UP) = good, near resistance = bad
  // ═══════════════════════════════════════════════

  _analyzeStructure(side, currentPrice, keyLevels, vwap) {
    let entryQuality = 0.5;
    let atResistance = false;
    let atSupport = false;
    let nearestSupport = null;
    let nearestResistance = null;

    // Find nearest support and resistance
    for (const level of keyLevels) {
      if (level.type === "support" && level.price < currentPrice) {
        if (!nearestSupport || level.price > nearestSupport.price) {
          nearestSupport = level;
        }
      }
      if (level.type === "resistance" && level.price > currentPrice) {
        if (!nearestResistance || level.price < nearestResistance.price) {
          nearestResistance = level;
        }
      }
    }

    if (nearestSupport && nearestResistance) {
      const range = nearestResistance.price - nearestSupport.price;
      const position = range > 0 ? (currentPrice - nearestSupport.price) / range : 0.5;

      if (side === "UP") {
        // For longs: being near support = good entry, near resistance = bad
        entryQuality = 1 - position; // 0=at resistance (bad), 1=at support (good)
        atResistance = position > 0.85;
        atSupport = position < 0.15;
      } else {
        // For shorts: being near resistance = good entry, near support = bad
        entryQuality = position;
        atResistance = position > 0.85;
        atSupport = position < 0.15;
      }
    }

    // VWAP position also matters
    if (vwap.vwap > 0) {
      if (side === "UP" && currentPrice < vwap.vwap) {
        entryQuality += 0.1; // Below VWAP = good for longs (discount)
      } else if (side === "DOWN" && currentPrice > vwap.vwap) {
        entryQuality += 0.1; // Above VWAP = good for shorts (premium)
      }
    }

    return {
      entryQuality: Math.max(0, Math.min(1, entryQuality)),
      atResistance,
      atSupport,
      nearestSupport: nearestSupport ? { price: nearestSupport.price, strength: nearestSupport.strength } : null,
      nearestResistance: nearestResistance ? { price: nearestResistance.price, strength: nearestResistance.strength } : null,
    };
  }

  // ═══════════════════════════════════════════════
  //  VOLUME PROFILE
  //  Where did the most trading happen?
  //  High-volume nodes = strong S/R, low-volume gaps = fast moves
  // ═══════════════════════════════════════════════

  _analyzeVolumeProfile(priceHistory, currentPrice) {
    if (priceHistory.length < 30) return { atHighVolNode: false, nodeIsSupport: false, nodeIsResistance: false };

    // Bucket prices by small bins
    const binSize = currentPrice * 0.0002; // 0.02% bins
    const bins = new Map();

    for (const entry of priceHistory) {
      const bin = Math.round(entry.price / binSize) * binSize;
      bins.set(bin, (bins.get(bin) || 0) + (entry.vol || 1));
    }

    // Find high-volume nodes (top 25%)
    const volumes = [...bins.values()].sort((a, b) => b - a);
    const threshold = volumes[Math.floor(volumes.length * 0.25)] || 0;

    // Is current price at a high-volume node?
    const currentBin = Math.round(currentPrice / binSize) * binSize;
    const currentBinVol = bins.get(currentBin) || 0;
    const atHighVolNode = currentBinVol >= threshold && threshold > 0;

    // If at high-vol node, is it support or resistance?
    const nodeIsSupport = atHighVolNode && currentPrice > currentBin;
    const nodeIsResistance = atHighVolNode && currentPrice < currentBin;

    return { atHighVolNode, nodeIsSupport, nodeIsResistance };
  }

  // ═══════════════════════════════════════════════
  //  PRICE ACTION PATTERNS
  //  Classic patterns that predict short-term direction
  // ═══════════════════════════════════════════════

  _detectPriceAction(priceHistory, side) {
    if (priceHistory.length < 40) return { signal: 0, pattern: "none" };

    const recent = priceHistory.slice(-40);
    const current = recent[recent.length - 1].price;

    // Build "candles" from 10-second bars
    const candles = [];
    for (let i = 0; i < recent.length - 9; i += 10) {
      const bar = recent.slice(i, i + 10);
      const open = bar[0].price;
      const close = bar[bar.length - 1].price;
      const high = Math.max(...bar.map(p => p.price));
      const low = Math.min(...bar.map(p => p.price));
      const vol = bar.reduce((s, p) => s + (p.vol || 0), 0);
      candles.push({ open, close, high, low, vol });
    }

    if (candles.length < 3) return { signal: 0, pattern: "none" };

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prevPrev = candles.length >= 3 ? candles[candles.length - 3] : null;

    const lastBody = Math.abs(last.close - last.open);
    const lastRange = last.high - last.low;
    const prevBody = Math.abs(prev.close - prev.open);
    const prevRange = prev.high - prev.low;

    // 1. ENGULFING PATTERN
    // Bullish engulfing: prev was bearish, current bullish and engulfs prev body
    if (prev.close < prev.open && last.close > last.open && lastBody > prevBody * 1.3) {
      if (last.close > prev.open && last.open < prev.close) {
        return { signal: 0.6, pattern: "bullish-engulf" };
      }
    }
    // Bearish engulfing
    if (prev.close > prev.open && last.close < last.open && lastBody > prevBody * 1.3) {
      if (last.close < prev.open && last.open > prev.close) {
        return { signal: -0.6, pattern: "bearish-engulf" };
      }
    }

    // 2. PIN BAR / HAMMER / SHOOTING STAR
    // Long lower wick, small body at top = bullish (hammer)
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;

    if (lastRange > 0 && lowerWick > lastBody * 2 && upperWick < lastBody * 0.5) {
      return { signal: 0.4, pattern: "hammer" };
    }
    // Long upper wick, small body at bottom = bearish (shooting star)
    if (lastRange > 0 && upperWick > lastBody * 2 && lowerWick < lastBody * 0.5) {
      return { signal: -0.4, pattern: "shooting-star" };
    }

    // 3. DOUBLE TOP / DOUBLE BOTTOM (approximate)
    if (candles.length >= 4 && prevPrev) {
      // Double top: two similar highs with a valley between
      const high1 = prevPrev.high;
      const high2 = last.high;
      const valley = prev.low;
      const tolerance = (high1 + high2) / 2 * 0.0005;

      if (Math.abs(high1 - high2) < tolerance && valley < high1 * 0.999 && current < valley) {
        return { signal: -0.5, pattern: "double-top" };
      }

      // Double bottom
      const low1 = prevPrev.low;
      const low2 = last.low;
      const peak = prev.high;
      if (Math.abs(low1 - low2) < tolerance && peak > low1 * 1.001 && current > peak) {
        return { signal: 0.5, pattern: "double-bottom" };
      }
    }

    // 4. HIGHER HIGHS + HIGHER LOWS (trending structure)
    if (candles.length >= 3 && prevPrev) {
      const hh = last.high > prev.high && prev.high > prevPrev.high;
      const hl = last.low > prev.low && prev.low > prevPrev.low;
      const lh = last.high < prev.high && prev.high < prevPrev.high;
      const ll = last.low < prev.low && prev.low < prevPrev.low;

      if (hh && hl) return { signal: 0.35, pattern: "hh-hl-uptrend" };
      if (lh && ll) return { signal: -0.35, pattern: "lh-ll-downtrend" };
    }

    // 5. DOJI — indecision, often precedes reversal
    if (lastRange > 0 && lastBody < lastRange * 0.1) {
      // Doji at the top = bearish, at the bottom = bullish
      const avgPrice = candles.slice(0, -1).reduce((s, c) => s + (c.close + c.open) / 2, 0) / (candles.length - 1);
      if (current > avgPrice * 1.001) {
        return { signal: -0.25, pattern: "doji-at-top" };
      } else if (current < avgPrice * 0.999) {
        return { signal: 0.25, pattern: "doji-at-bottom" };
      }
    }

    return { signal: 0, pattern: "none" };
  }

  // ═══════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════

  _neutral(reason) {
    return {
      veto: false,
      vetoReason: "",
      convictionMult: 1.0,
      boosts: [],
      penalties: [reason],
      regime: { type: "UNKNOWN", confidence: 0, direction: 0 },
      trap: { isTrap: false, confidence: 0, reasons: [] },
      exhaustion: { level: 0, direction: 0, reasons: [] },
      structure: { entryQuality: 0.5, atResistance: false, atSupport: false },
      smartMoney: { signal: 0, reasons: [] },
      momQuality: { quality: 0.5, decelerating: false },
      vwap: { vwap: 0, deviation: 0 },
      priceAction: { signal: 0, pattern: "none" },
      volProfile: { atHighVolNode: false },
      chart: { patterns: [], bias: 0, holdSignal: false, exitSignal: false, reason: "no-data", confidence: 0 },
    };
  }

  // Count how many times price tested a level
  _countLevelTests(priceHistory, level, tolerance) {
    let tests = 0;
    let wasNear = false;
    for (const p of priceHistory) {
      const near = Math.abs(p.price - level) < tolerance;
      if (near && !wasNear) tests++;
      wasNear = near;
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  //  CHART PATTERN RECOGNITION ENGINE
  //  Resamples raw tick data into candles, then scans for multi-bar patterns
  //  Returns: { patterns: [...], bias: -1 to +1, holdSignal, exitSignal, reason }
  //
  //  Patterns detected:
  //    Reversal: head & shoulders, inv H&S, double top/bottom, triple top/bottom
  //    Continuation: ascending/descending channel, flag, pennant, triangle
  //    Breakout: range breakout, volume breakout
  //    Structure: higher highs/lows, lower highs/lows
  // ═══════════════════════════════════════════════════════════════

  analyzeChart(priceHistory, side) {
    const empty = { patterns: [], bias: 0, holdSignal: false, exitSignal: false, reason: "insufficient-data", confidence: 0 };
    if (!priceHistory || priceHistory.length < 60) return empty;

    // Resample to 30-second candles for pattern recognition
    const candles = this._buildCandles(priceHistory, 30);
    if (candles.length < 10) return empty;

    const patterns = [];
    const sideDir = side === "UP" ? 1 : -1;

    // Run all pattern detectors
    const hs = this._detectHeadAndShoulders(candles);
    if (hs) patterns.push(hs);

    const dt = this._detectDoubleTopBottom(candles);
    if (dt) patterns.push(dt);

    const tt = this._detectTripleTopBottom(candles);
    if (tt) patterns.push(tt);

    const ch = this._detectChannel(candles);
    if (ch) patterns.push(ch);

    const tri = this._detectTriangle(candles);
    if (tri) patterns.push(tri);

    const fg = this._detectFlag(candles);
    if (fg) patterns.push(fg);

    const bo = this._detectBreakout(candles);
    if (bo) patterns.push(bo);

    const trend = this._detectTrendStructure(candles);
    if (trend) patterns.push(trend);

    // Calculate combined bias and signals
    let bias = 0;
    let maxConfidence = 0;
    let holdSignal = false;
    let exitSignal = false;
    let bestReason = "no-pattern";

    for (const p of patterns) {
      bias += p.direction * p.confidence * p.weight;
      if (p.confidence > maxConfidence) {
        maxConfidence = p.confidence;
        bestReason = p.name;
      }

      // Hold signal: pattern favors our direction
      if (Math.sign(p.direction) === sideDir && p.confidence > 0.5) {
        holdSignal = true;
      }

      // Exit signal: strong pattern against our direction
      if (Math.sign(p.direction) === -sideDir && p.confidence > 0.6) {
        exitSignal = true;
        bestReason = `${p.name}-against`;
      }
    }

    // Normalize bias to [-1, 1]
    bias = Math.max(-1, Math.min(1, bias));

    return {
      patterns,
      bias,
      holdSignal,
      exitSignal,
      reason: bestReason,
      confidence: maxConfidence,
    };
  }

  // ─── Build OHLCV candles from tick data ────────────────────
  _buildCandles(priceHistory, intervalSecs) {
    const candles = [];
    const intervalMs = intervalSecs * 1000;
    if (priceHistory.length === 0) return candles;

    let startTs = priceHistory[0].ts;
    let bar = [];

    for (const tick of priceHistory) {
      if (tick.ts - startTs >= intervalMs && bar.length > 0) {
        candles.push(this._barToCandle(bar));
        bar = [];
        startTs = tick.ts;
      }
      bar.push(tick);
    }
    if (bar.length > 0) candles.push(this._barToCandle(bar));

    return candles;
  }

  _barToCandle(bar) {
    return {
      open: bar[0].price,
      close: bar[bar.length - 1].price,
      high: Math.max(...bar.map(p => p.price)),
      low: Math.min(...bar.map(p => p.price)),
      vol: bar.reduce((s, p) => s + (p.vol || 0), 0),
      ts: bar[0].ts,
    };
  }

  // ─── HEAD AND SHOULDERS / INVERSE H&S ─────────────────────
  // Classic reversal: three peaks, middle one highest (or three troughs, middle lowest)
  _detectHeadAndShoulders(candles) {
    if (candles.length < 15) return null;

    // Find peaks and troughs using 3-candle lookback
    const peaks = [];
    const troughs = [];
    for (let i = 2; i < candles.length - 2; i++) {
      if (candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high &&
          candles[i].high > candles[i-2].high && candles[i].high > candles[i+2].high) {
        peaks.push({ idx: i, price: candles[i].high });
      }
      if (candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low &&
          candles[i].low < candles[i-2].low && candles[i].low < candles[i+2].low) {
        troughs.push({ idx: i, price: candles[i].low });
      }
    }

    // H&S: need 3 peaks where middle is highest
    if (peaks.length >= 3) {
      for (let i = 0; i <= peaks.length - 3; i++) {
        const [ls, head, rs] = [peaks[i], peaks[i+1], peaks[i+2]];
        if (head.price > ls.price && head.price > rs.price) {
          const shoulderTol = ls.price * 0.003; // shoulders within 0.3%
          if (Math.abs(ls.price - rs.price) < shoulderTol) {
            // Neckline = avg of troughs between shoulders
            const neckTroughs = troughs.filter(t => t.idx > ls.idx && t.idx < rs.idx);
            const neckline = neckTroughs.length > 0
              ? neckTroughs.reduce((s, t) => s + t.price, 0) / neckTroughs.length
              : Math.min(ls.price, rs.price);
            const current = candles[candles.length - 1].close;

            // Confirm: price has broken below neckline
            if (current < neckline) {
              return { name: "head-shoulders", direction: -1, confidence: 0.75, weight: 1.5,
                       neckline, target: neckline - (head.price - neckline) };
            }
            // Forming but not confirmed
            if (rs.idx >= candles.length - 5) {
              return { name: "head-shoulders-forming", direction: -1, confidence: 0.45, weight: 1.0,
                       neckline };
            }
          }
        }
      }
    }

    // Inverse H&S: 3 troughs, middle is lowest → bullish
    if (troughs.length >= 3) {
      for (let i = 0; i <= troughs.length - 3; i++) {
        const [ls, head, rs] = [troughs[i], troughs[i+1], troughs[i+2]];
        if (head.price < ls.price && head.price < rs.price) {
          const shoulderTol = ls.price * 0.003;
          if (Math.abs(ls.price - rs.price) < shoulderTol) {
            const neckPeaks = peaks.filter(p => p.idx > ls.idx && p.idx < rs.idx);
            const neckline = neckPeaks.length > 0
              ? neckPeaks.reduce((s, p) => s + p.price, 0) / neckPeaks.length
              : Math.max(ls.price, rs.price);
            const current = candles[candles.length - 1].close;

            if (current > neckline) {
              return { name: "inv-head-shoulders", direction: 1, confidence: 0.75, weight: 1.5,
                       neckline, target: neckline + (neckline - head.price) };
            }
            if (rs.idx >= candles.length - 5) {
              return { name: "inv-hs-forming", direction: 1, confidence: 0.45, weight: 1.0,
                       neckline };
            }
          }
        }
      }
    }

    return null;
  }

  // ─── DOUBLE TOP / DOUBLE BOTTOM ────────────────────────────
  // Two similar peaks/troughs = reversal signal
  _detectDoubleTopBottom(candles) {
    if (candles.length < 10) return null;

    const recent = candles.slice(-20);
    if (recent.length < 10) return null;

    // Find significant highs and lows in recent data
    const highs = [];
    const lows = [];
    for (let i = 1; i < recent.length - 1; i++) {
      if (recent[i].high >= recent[i-1].high && recent[i].high >= recent[i+1].high) {
        highs.push({ idx: i, price: recent[i].high });
      }
      if (recent[i].low <= recent[i-1].low && recent[i].low <= recent[i+1].low) {
        lows.push({ idx: i, price: recent[i].low });
      }
    }

    const current = recent[recent.length - 1].close;

    // Double top: two similar highs with price breaking below the valley
    if (highs.length >= 2) {
      const h1 = highs[highs.length - 2];
      const h2 = highs[highs.length - 1];
      const tol = h1.price * 0.002;
      if (Math.abs(h1.price - h2.price) < tol && h2.idx - h1.idx >= 3) {
        const valleyBetween = Math.min(...recent.slice(h1.idx, h2.idx + 1).map(c => c.low));
        if (current < valleyBetween) {
          return { name: "double-top", direction: -1, confidence: 0.7, weight: 1.3,
                   level: (h1.price + h2.price) / 2, neckline: valleyBetween };
        }
        if (current < (h1.price + h2.price) / 2) {
          return { name: "double-top-forming", direction: -1, confidence: 0.4, weight: 0.8 };
        }
      }
    }

    // Double bottom: two similar lows with price breaking above the peak
    if (lows.length >= 2) {
      const l1 = lows[lows.length - 2];
      const l2 = lows[lows.length - 1];
      const tol = l1.price * 0.002;
      if (Math.abs(l1.price - l2.price) < tol && l2.idx - l1.idx >= 3) {
        const peakBetween = Math.max(...recent.slice(l1.idx, l2.idx + 1).map(c => c.high));
        if (current > peakBetween) {
          return { name: "double-bottom", direction: 1, confidence: 0.7, weight: 1.3,
                   level: (l1.price + l2.price) / 2, neckline: peakBetween };
        }
        if (current > (l1.price + l2.price) / 2) {
          return { name: "double-bottom-forming", direction: 1, confidence: 0.4, weight: 0.8 };
        }
      }
    }

    return null;
  }

  // ─── TRIPLE TOP / TRIPLE BOTTOM ────────────────────────────
  _detectTripleTopBottom(candles) {
    if (candles.length < 15) return null;
    const recent = candles.slice(-30);
    if (recent.length < 12) return null;

    const highs = [];
    const lows = [];
    for (let i = 1; i < recent.length - 1; i++) {
      if (recent[i].high >= recent[i-1].high && recent[i].high >= recent[i+1].high) {
        highs.push({ idx: i, price: recent[i].high });
      }
      if (recent[i].low <= recent[i-1].low && recent[i].low <= recent[i+1].low) {
        lows.push({ idx: i, price: recent[i].low });
      }
    }

    const current = recent[recent.length - 1].close;

    // Triple top
    if (highs.length >= 3) {
      const h1 = highs[highs.length - 3], h2 = highs[highs.length - 2], h3 = highs[highs.length - 1];
      const avg = (h1.price + h2.price + h3.price) / 3;
      const tol = avg * 0.003;
      if (Math.abs(h1.price - avg) < tol && Math.abs(h2.price - avg) < tol && Math.abs(h3.price - avg) < tol) {
        const support = Math.min(...recent.slice(h1.idx, h3.idx + 1).map(c => c.low));
        if (current < support) {
          return { name: "triple-top", direction: -1, confidence: 0.8, weight: 1.5 };
        }
      }
    }

    // Triple bottom
    if (lows.length >= 3) {
      const l1 = lows[lows.length - 3], l2 = lows[lows.length - 2], l3 = lows[lows.length - 1];
      const avg = (l1.price + l2.price + l3.price) / 3;
      const tol = avg * 0.003;
      if (Math.abs(l1.price - avg) < tol && Math.abs(l2.price - avg) < tol && Math.abs(l3.price - avg) < tol) {
        const resistance = Math.max(...recent.slice(l1.idx, l3.idx + 1).map(c => c.high));
        if (current > resistance) {
          return { name: "triple-bottom", direction: 1, confidence: 0.8, weight: 1.5 };
        }
      }
    }

    return null;
  }

  // ─── CHANNEL DETECTION (ascending / descending / horizontal) ──
  // Parallel trendlines connecting highs and lows
  _detectChannel(candles) {
    if (candles.length < 12) return null;
    const recent = candles.slice(-20);
    if (recent.length < 10) return null;

    // Linear regression on highs and lows
    const n = recent.length;
    const highSlope = this._linearSlope(recent.map((c, i) => [i, c.high]));
    const lowSlope = this._linearSlope(recent.map((c, i) => [i, c.low]));

    const avgPrice = recent.reduce((s, c) => s + (c.high + c.low) / 2, 0) / n;
    const normHighSlope = highSlope / avgPrice;
    const normLowSlope = lowSlope / avgPrice;

    // Both slopes similar and non-zero = channel
    const slopeDiff = Math.abs(normHighSlope - normLowSlope);
    const avgSlope = (normHighSlope + normLowSlope) / 2;

    if (slopeDiff < Math.abs(avgSlope) * 0.5 + 0.0001) { // parallel enough
      if (avgSlope > 0.0003) {
        // Ascending channel — bullish continuation
        const current = recent[recent.length - 1].close;
        const channelHigh = recent[recent.length - 1].high + highSlope;
        const channelLow = recent[recent.length - 1].low + lowSlope;
        const position = (current - channelLow) / (channelHigh - channelLow + 0.0001);

        return { name: "ascending-channel", direction: 1, confidence: 0.55,
                 weight: 0.8, position, slope: avgSlope };
      } else if (avgSlope < -0.0003) {
        // Descending channel — bearish continuation
        return { name: "descending-channel", direction: -1, confidence: 0.55,
                 weight: 0.8, slope: avgSlope };
      } else {
        // Horizontal channel — ranging
        return { name: "range-channel", direction: 0, confidence: 0.4,
                 weight: 0.3 };
      }
    }

    return null;
  }

  // ─── TRIANGLE DETECTION (ascending / descending / symmetric) ──
  // Converging trendlines = breakout imminent
  _detectTriangle(candles) {
    if (candles.length < 12) return null;
    const recent = candles.slice(-20);
    if (recent.length < 10) return null;

    const highSlope = this._linearSlope(recent.map((c, i) => [i, c.high]));
    const lowSlope = this._linearSlope(recent.map((c, i) => [i, c.low]));
    const avgPrice = recent.reduce((s, c) => s + (c.high + c.low) / 2, 0) / recent.length;
    const normHigh = highSlope / avgPrice;
    const normLow = lowSlope / avgPrice;

    // Converging: highs falling AND lows rising (or one flat)
    const highsFalling = normHigh < -0.0001;
    const lowsRising = normLow > 0.0001;
    const highsFlat = Math.abs(normHigh) < 0.0001;
    const lowsFlat = Math.abs(normLow) < 0.0001;

    // Check range is actually narrowing
    const firstRange = recent[0].high - recent[0].low;
    const lastRange = recent[recent.length - 1].high - recent[recent.length - 1].low;
    const narrowing = lastRange < firstRange * 0.7;

    if (!narrowing) return null;

    if (highsFlat && lowsRising) {
      // Ascending triangle: flat top, rising bottom → usually bullish breakout
      return { name: "ascending-triangle", direction: 1, confidence: 0.6, weight: 1.2,
               resistance: recent[recent.length - 1].high };
    }
    if (highsFalling && lowsFlat) {
      // Descending triangle: falling top, flat bottom → usually bearish breakdown
      return { name: "descending-triangle", direction: -1, confidence: 0.6, weight: 1.2,
               support: recent[recent.length - 1].low };
    }
    if (highsFalling && lowsRising) {
      // Symmetric triangle: breakout direction unclear, go with momentum
      const momentum = candles[candles.length - 1].close - candles[candles.length - 4].close;
      return { name: "symmetric-triangle", direction: momentum > 0 ? 1 : -1, confidence: 0.45, weight: 0.8 };
    }

    return null;
  }

  // ─── FLAG / PENNANT DETECTION ──────────────────────────────
  // Sharp move (pole) followed by shallow counter-trend consolidation (flag)
  _detectFlag(candles) {
    if (candles.length < 12) return null;

    // Look for a sharp pole move in first 40% of data, then consolidation
    const poleEnd = Math.floor(candles.length * 0.4);
    const pole = candles.slice(0, poleEnd);
    const flag = candles.slice(poleEnd);

    if (pole.length < 3 || flag.length < 4) return null;

    const poleMove = pole[pole.length - 1].close - pole[0].open;
    const polePct = Math.abs(poleMove) / pole[0].open;

    // Need a significant pole move (> 0.1%)
    if (polePct < 0.001) return null;

    const poleDir = poleMove > 0 ? 1 : -1;

    // Flag should be a shallow counter-trend move (< 50% of pole)
    const flagMove = flag[flag.length - 1].close - flag[0].open;
    const flagPct = Math.abs(flagMove) / flag[0].open;
    const flagDir = flagMove > 0 ? 1 : -1;

    // Flag moves against the pole but only retraces < 50%
    if (flagDir === -poleDir && flagPct < polePct * 0.5 && flagPct > polePct * 0.05) {
      // Bull flag: sharp up, shallow pullback → continuation up
      // Bear flag: sharp down, shallow rally → continuation down
      const flagRange = Math.max(...flag.map(c => c.high)) - Math.min(...flag.map(c => c.low));
      const poleRange = Math.max(...pole.map(c => c.high)) - Math.min(...pole.map(c => c.low));

      if (flagRange < poleRange * 0.6) {
        return { name: poleDir > 0 ? "bull-flag" : "bear-flag", direction: poleDir,
                 confidence: 0.6, weight: 1.1, poleSize: polePct, retracement: flagPct / polePct };
      }
    }

    return null;
  }

  // ─── BREAKOUT DETECTION ────────────────────────────────────
  // Price breaks through recent consolidation range with volume
  _detectBreakout(candles) {
    if (candles.length < 10) return null;

    // Define consolidation zone from candles [3..n-3], check if last few candles broke out
    const consolidation = candles.slice(3, -3);
    const breakout = candles.slice(-3);
    if (consolidation.length < 4 || breakout.length < 2) return null;

    const rangeHigh = Math.max(...consolidation.map(c => c.high));
    const rangeLow = Math.min(...consolidation.map(c => c.low));
    const range = rangeHigh - rangeLow;
    if (range <= 0) return null;

    const current = breakout[breakout.length - 1].close;

    // Volume confirmation: breakout candles should have higher volume
    const consVol = consolidation.reduce((s, c) => s + c.vol, 0) / consolidation.length;
    const boVol = breakout.reduce((s, c) => s + c.vol, 0) / breakout.length;
    const volConfirm = consVol > 0 ? boVol / consVol > 1.3 : false;

    if (current > rangeHigh + range * 0.01) {
      return { name: "breakout-up", direction: 1, confidence: volConfirm ? 0.7 : 0.5,
               weight: volConfirm ? 1.3 : 0.9, level: rangeHigh };
    }
    if (current < rangeLow - range * 0.01) {
      return { name: "breakout-down", direction: -1, confidence: volConfirm ? 0.7 : 0.5,
               weight: volConfirm ? 1.3 : 0.9, level: rangeLow };
    }

    return null;
  }

  // ─── TREND STRUCTURE (HH/HL vs LH/LL) ─────────────────────
  // Most fundamental pattern: sequence of highs and lows defines trend
  _detectTrendStructure(candles) {
    if (candles.length < 8) return null;

    const recent = candles.slice(-12);
    if (recent.length < 6) return null;

    // Split into 3 segments and check highs/lows
    const segLen = Math.floor(recent.length / 3);
    const segs = [
      recent.slice(0, segLen),
      recent.slice(segLen, segLen * 2),
      recent.slice(segLen * 2),
    ];

    const segHighs = segs.map(s => Math.max(...s.map(c => c.high)));
    const segLows = segs.map(s => Math.min(...s.map(c => c.low)));

    const hh = segHighs[2] > segHighs[1] && segHighs[1] > segHighs[0];
    const hl = segLows[2] > segLows[1] && segLows[1] > segLows[0];
    const lh = segHighs[2] < segHighs[1] && segHighs[1] < segHighs[0];
    const ll = segLows[2] < segLows[1] && segLows[1] < segLows[0];

    if (hh && hl) {
      return { name: "uptrend-hh-hl", direction: 1, confidence: 0.6, weight: 1.0 };
    }
    if (lh && ll) {
      return { name: "downtrend-lh-ll", direction: -1, confidence: 0.6, weight: 1.0 };
    }
    if (hh && !hl) {
      return { name: "weak-uptrend", direction: 1, confidence: 0.35, weight: 0.5 };
    }
    if (ll && !lh) {
      return { name: "weak-downtrend", direction: -1, confidence: 0.35, weight: 0.5 };
    }

    return null;
  }

  // ─── Linear regression slope helper ────────────────────────
  _linearSlope(points) {
    const n = points.length;
    if (n < 3) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const [x, y] of points) {
      sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;
    return (n * sumXY - sumX * sumY) / denom;
  }
}
