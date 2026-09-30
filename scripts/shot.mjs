// Dev helper: log in as a demo user and screenshot pages. Usage: node scripts/shot.mjs <email> <out-dir> <path> [path...]
import { chromium } from "@playwright/test";
const [email, out, ...paths] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:3000";
const mobile = process.env.MOBILE === "1";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/login");
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', "Demo1234!");
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }), page.click('button[type="submit"]')]);
for (const p of paths) {
  const res = await page.goto(base + p, { waitUntil: "networkidle", timeout: 60000 });
  const name = p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home";
  await page.screenshot({ path: `${out}/${name}${mobile ? "_m" : ""}.png`, fullPage: true });
  console.log(p, res?.status());
}
if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
await browser.close();
