/* e2e 静态服务器：把 web/ 目录按真实 Go FileServer 的语义提供出来（无构建、无后端）。
   仅用于 Playwright 测试；`/api/*`、`/v1/*` 由 page.route 在浏览器侧拦截，不会到达这里。 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..", "web");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".png": "image/png"
};

export function createStaticServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    // 防路径穿越：只允许 web/ 下的普通文件
    const target = path.normalize(path.join(webRoot, pathname));
    if (!target.startsWith(webRoot)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(target)] || "application/octet-stream"
      });
      fs.createReadStream(target).pipe(res);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 4173);
  createStaticServer().listen(port, "127.0.0.1", () => {
    console.log(`e2e static server on http://127.0.0.1:${port}`);
  });
}
