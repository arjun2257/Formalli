"use strict";
const fs = require("fs");
const path = require("path");

const backendUrl = String(process.env.BACKEND_URL || "").trim().replace(/\/$/, "");
const content = `window.FORMALLI_CONFIG = Object.freeze({ backendUrl: ${JSON.stringify(backendUrl)} });\n`;
fs.writeFileSync(path.join(__dirname, "public", "config.js"), content, "utf8");
console.log(`Generated public/config.js for ${backendUrl || "local auto-detection"}`);
