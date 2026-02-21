// Install PolyWhale as a Windows Service
// Run: node install-service.js
// Remove: node install-service.js remove

import { Service } from "node-windows";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const svc = new Service({
  name: "PolyWhale",
  description: "PolyWhale v2 — Polymarket Crypto Scalper",
  script: join(__dirname, "server.js"),
  nodeOptions: [],
  env: [{
    name: "NODE_ENV",
    value: "production"
  }],
  // Auto-restart on crash, up to 3 times, then wait 60s
  wait: 2,
  grow: 0.5,
  maxRestarts: 100,
});

if (process.argv[2] === "remove") {
  svc.on("uninstall", () => {
    console.log("PolyWhale service removed.");
  });
  svc.uninstall();
} else {
  svc.on("install", () => {
    console.log("PolyWhale service installed! Starting...");
    svc.start();
  });
  svc.on("alreadyinstalled", () => {
    console.log("Service already installed. Starting...");
    svc.start();
  });
  svc.on("start", () => {
    console.log("PolyWhale service is running!");
    console.log("It will auto-restart on crash and survive reboots.");
    console.log("");
    console.log("To check status:  sc query PolyWhale");
    console.log("To stop:          node install-service.js remove");
    console.log("Logs at:          c:\\tradingbot\\data\\crash.log");
    console.log("Dashboard:        http://localhost:3000");
  });
  svc.on("error", (err) => {
    console.error("Error:", err);
  });
  svc.install();
}
