// Encrypted key storage — NEVER stored in plaintext
// Key is AES-256-GCM encrypted with user password via PBKDF2
export const WALLET_ADDRESS = ""; // Set after first connection
export const ENCRYPTED_KEY_HINT = "Stored encrypted in chrome.storage.local";

// The private key is saved encrypted through wallet-auth.js saveWallet()
// To use: call decryptPrivateKey(encryptedB64, password) from wallet-auth.js
