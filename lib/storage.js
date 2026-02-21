// File-based storage — persists scalper state to disk
// Replaces chrome.storage for Node.js localhost mode

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "state.json");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let _cache = null;

function loadAll() {
  if (_cache) return _cache;
  try {
    if (existsSync(STATE_FILE)) {
      _cache = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } else {
      _cache = {};
    }
  } catch {
    _cache = {};
  }
  return _cache;
}

function flush() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(_cache, null, 2), "utf-8");
  } catch (e) {
    try { process.stderr.write(`[Storage] Write error: ${e.message}\n`); } catch {}
  }
}

const DEFAULTS = {
  settings: {
    defaultBetSize: 1,
    maxBetSize: 10,
  },
  wallet: null,
};

export async function get(key) {
  const all = loadAll();
  return all[key] !== undefined ? all[key] : DEFAULTS[key];
}

export async function set(key, value) {
  const all = loadAll();
  all[key] = value;
  flush();
}

export async function getAll() {
  return { ...DEFAULTS, ...loadAll() };
}

export async function getSettings() {
  return get("settings");
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  await set("settings", updated);
  return updated;
}
