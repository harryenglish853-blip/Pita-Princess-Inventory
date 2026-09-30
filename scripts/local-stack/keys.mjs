// Generates HS256 anon + service_role API keys for the local stack.
// Usage: node keys.mjs <jwt-secret>   -> prints shell `export` lines
import crypto from "node:crypto";

const secret = process.argv[2];
if (!secret) throw new Error("usage: node keys.mjs <jwt-secret>");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const exp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
console.log(`export SUPABASE_ANON_KEY=${sign({ iss: "supabase-local", role: "anon", exp })}`);
console.log(`export SUPABASE_SERVICE_ROLE_KEY=${sign({ iss: "supabase-local", role: "service_role", exp })}`);
