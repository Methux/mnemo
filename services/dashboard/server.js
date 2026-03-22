const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "18800", 10);
const GRAPHITI_URL = process.env.GRAPHITI_URL || "http://graphiti:18799";
const NEO4J_BROWSER_URL = process.env.NEO4J_BROWSER_URL || "http://neo4j:7474";

const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");

const server = http.createServer(async (req, res) => {
  // --- API proxy endpoints ---
  if (req.url === "/api/health") {
    try {
      const resp = await fetch(`${GRAPHITI_URL}/health`);
      const data = await resp.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", message: e.message }));
    }
    return;
  }

  if (req.url === "/api/search" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const resp = await fetch(`${GRAPHITI_URL}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const data = await resp.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Serve dashboard HTML ---
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(indexHtml);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mnemo-dashboard] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[mnemo-dashboard] Graphiti backend: ${GRAPHITI_URL}`);
});
