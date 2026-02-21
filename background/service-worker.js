// PolyWhale — Background Service Worker
// Runs the crypto scalper, ticks every 30 seconds
// Keep-alive: pings itself to prevent MV3 from killing us mid-tick

import * as api from "../lib/polymarket-api.js";
import * as store from "../lib/storage.js";
import * as wallet from "../lib/wallet-auth.js";
import { Scalper } from "../lib/scalper.js";

const SCALP_ALARM = "scalper-tick";
const TICK_TIMEOUT = 20000; // max 20s per tick — abort if stuck
const scalper = new Scalper();
let _proxyLoaded = false;
let _tickRunning = false;

// ─── Open Side Panel on icon click ───────────────
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Load proxy from settings ───────────────────
async function ensureProxy() {
  if (_proxyLoaded) return;
  const settings = await store.getSettings();
  let mode = settings.proxyMode || "off";

  // Auto-migrate: corsproxy.io is 403-blocked
  if (mode === "corsproxy") {
    mode = "off";
    await store.updateSettings({ proxyMode: "off" });
    console.log("[PolyWhale] Migrated proxy from corsproxy → off (use VPN)");
  }

  const custom = settings.customProxyUrl || "";
  api.setProxy(mode, custom);
  _proxyLoaded = true;
  console.log(`[PolyWhale] Proxy loaded: ${mode}`);
}

// Load proxy immediately when module runs (every service worker wake-up)
ensureProxy();

// ─── Startup ─────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[PolyWhale] Installed");
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await ensureProxy();
  initAlarms();
  await startScalper();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await ensureProxy();
  initAlarms();
  await startScalper();
});

async function startScalper() {
  try {
    await scalper.init();
    await scalper.save();
    console.log("[PolyWhale] Scalper v5 started, positions:", scalper.positions.length);

    // Load markets and tick immediately
    await scalper.refreshMarkets();
    if (scalper.markets.length > 0) {
      await scalper.tick();
    }
    console.log("[PolyWhale] Startup done. Positions:", scalper.positions.length);
  } catch (e) {
    console.error("[PolyWhale] Scalper start error:", e);
  }
}

function initAlarms() {
  chrome.alarms.create(SCALP_ALARM, { periodInMinutes: 0.5 }); // every 30s
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureProxy();
  if (alarm.name === SCALP_ALARM) await runScalperTick();
});

// ─── Self-recovery: re-create alarm if it goes missing ──
setInterval(async () => {
  const alarm = await chrome.alarms.get(SCALP_ALARM);
  if (!alarm) {
    console.warn("[PolyWhale] Alarm lost — recreating");
    initAlarms();
  }
}, 60000);

// ─── Scalper Tick (guarded) ──────────────────────
// Wraps entire tick in a timeout so a hung fetch can't kill the worker
async function runScalperTick() {
  if (_tickRunning) { console.warn("[PolyWhale] Tick already running, skip"); return; }
  _tickRunning = true;

  // Keep-alive: ping ourselves every 5s during tick to prevent MV3 sleep
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 5000);

  try {
    const deadline = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tick timeout")), TICK_TIMEOUT)
    );

    await Promise.race([
      (async () => {
        if (!scalper.running) await scalper.init();
        // Refresh markets every 60s — 5m markets expire fast
        if (!scalper._lastRefresh || Date.now() - scalper._lastRefresh > 60000) {
          await scalper.refreshMarkets();
        }
        await scalper.tick();
      })(),
      deadline,
    ]);
  } catch (e) {
    console.error("[PolyWhale] Scalper tick error:", e.message || e);
    scalper.log("ERROR", `Tick failed: ${e.message || "timeout"}`);
    await scalper.save().catch(() => {});
  } finally {
    clearInterval(keepAlive);
    _tickRunning = false;
  }
}

// ─── Message Handler ─────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true;
});

async function handleMessage(msg) {
  await ensureProxy();
  switch (msg.type) {
    case "GET_STATE": return getFullState();
    case "SAVE_WALLET":
      try {
        await wallet.saveWallet(msg.privateKey, msg.password, msg.address);
        return { success: true };
      } catch (e) { return { success: false, error: e.message }; }
    case "CLEAR_WALLET":
      await wallet.clearWallet();
      return { success: true };
    case "UPDATE_SETTINGS":
      await store.updateSettings(msg.settings);
      return { success: true };
    case "SET_PROXY":
      api.setProxy(msg.proxyMode || "off", msg.customProxyUrl || "");
      await store.updateSettings({ proxyMode: msg.proxyMode, customProxyUrl: msg.customProxyUrl });
      api.clearCache();
      _proxyLoaded = true;
      return { success: true };
    case "TEST_CONNECTION":
      return testConnection();
    case "CLEAR_LOGS":
      scalper.logs = [];
      await scalper.save();
      return { success: true };
    case "RESET_SCALPER":
      await store.set("scalperState", null);
      scalper.positions = [];
      scalper.history = [];
      scalper.totalPnl = 0;
      scalper.totalBets = 0;
      scalper.wins = 0;
      scalper.losses = 0;
      scalper._priceHistory = {};
      scalper._tickCount = 0;
      scalper.logs = [];
      scalper.log("INIT", "Scalper reset — starting fresh");
      await scalper.refreshMarkets();
      if (scalper.markets.length > 0) await scalper.tick();
      return { success: true };
    default: return { error: "Unknown message type" };
  }
}

async function getFullState() {
  const all = await store.getAll();
  const w = await wallet.getWallet();
  return {
    scalperStats: scalper.getStats(),
    settings: all.settings || {},
    wallet: w ? { address: w.address, hasApiCreds: w.hasApiCreds } : null,
  };
}

async function testConnection() {
  try {
    api.clearCache();
    const markets = await api.fetchCryptoMarkets();
    const proxy = api.getProxyMode();
    return markets?.length > 0
      ? { success: true, marketCount: markets.length, proxy }
      : { success: false, error: "No markets returned", proxy };
  } catch (e) {
    return { success: false, error: e.message, proxy: api.getProxyMode() };
  }
}

console.log("[PolyWhale] Service worker loaded");
