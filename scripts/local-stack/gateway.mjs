// Minimal stand-in for the Supabase API gateway (Kong) used by the Docker-free
// local stack: routes /auth/v1/* to GoTrue and /rest/v1/* to PostgREST.
import http from "node:http";

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const routes = [
  { prefix: "/auth/v1", port: Number(process.env.AUTH_PORT ?? 9999) },
  { prefix: "/rest/v1", port: Number(process.env.REST_PORT ?? 3001) },
];

http
  .createServer((req, res) => {
    const route = routes.find((r) => req.url.startsWith(r.prefix));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "no route" }));
    }
    const headers = { ...req.headers, host: `127.0.0.1:${route.port}` };
    const upstream = http.request(
      { host: "127.0.0.1", port: route.port, method: req.method, path: req.url.slice(route.prefix.length) || "/", headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `upstream error: ${e.message}` }));
    });
    req.pipe(upstream);
  })
  .listen(PORT, () => console.log(`gateway listening on :${PORT}`));
