// Wallet authentication for Polymarket CLOB API
// L1: EIP-712 signature from private key
// L2: HMAC-SHA256 signed requests using derived API credentials

import * as storage from "./storage.js";

// ─── Encryption (PBKDF2 + AES-GCM) ──────────────────────

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPrivateKey(privateKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(privateKey)
  );
  // Store salt + iv + ciphertext as base64
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptPrivateKey(encryptedB64, password) {
  const combined = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const ciphertext = combined.slice(28);
  const key = await deriveKey(password, salt);
  const dec = new TextDecoder();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return dec.decode(decrypted);
}

// ─── HMAC-SHA256 for L2 Auth ─────────────────────────────

async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret), c => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export function buildL2Headers(apiKey, secret, passphrase, timestamp, method, path, body = "") {
  // Polymarket L2 auth: HMAC-SHA256(secret, timestamp + method + path + body)
  const message = timestamp + method.toUpperCase() + path + body;
  return hmacSha256(secret, message).then(signature => ({
    "POLY-API-KEY": apiKey,
    "POLY-SIGNATURE": signature,
    "POLY-TIMESTAMP": timestamp,
    "POLY-PASSPHRASE": passphrase,
  }));
}

// ─── Wallet Management ───────────────────────────────────

export async function saveWallet(privateKey, password, walletAddress) {
  const encrypted = await encryptPrivateKey(privateKey, password);
  await storage.set("wallet", {
    address: walletAddress,
    encryptedKey: encrypted,
    hasApiCreds: false,
    apiKey: null,
    secret: null,
    passphrase: null,
  });
}

export async function getWallet() {
  return storage.get("wallet");
}

export async function saveApiCredentials(apiKey, secret, passphrase) {
  const wallet = await getWallet();
  if (!wallet) throw new Error("No wallet configured");
  wallet.hasApiCreds = true;
  wallet.apiKey = apiKey;
  wallet.secret = secret;
  wallet.passphrase = passphrase;
  await storage.set("wallet", wallet);
}

export async function getAuthHeaders(method, path, body = "") {
  const wallet = await getWallet();
  if (!wallet || !wallet.hasApiCreds) throw new Error("Wallet not authenticated");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return buildL2Headers(wallet.apiKey, wallet.secret, wallet.passphrase, timestamp, method, path, body);
}

export async function isWalletConfigured() {
  const wallet = await getWallet();
  return !!(wallet && wallet.address);
}

export async function isWalletAuthenticated() {
  const wallet = await getWallet();
  return !!(wallet && wallet.hasApiCreds && wallet.apiKey);
}

export async function clearWallet() {
  await storage.set("wallet", null);
}
