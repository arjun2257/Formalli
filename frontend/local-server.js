"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(String(req.url || "/").split("?")[0]);
    const relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const requested = path.resolve(root, relativePath);
    const safePath = requested.startsWith(root) ? requested : path.join(root, "index.html");
    const filePath = fs.existsSync(safePath) && fs.statSync(safePath).isFile()
      ? safePath
      : path.join(root, "index.html");

    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`ForMalli frontend running at http://0.0.0.0:${port}`);
  });
