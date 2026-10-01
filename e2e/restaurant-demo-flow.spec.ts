import { createHmac } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { login, newSession } from "./helpers";

/**
 * The restaurant demo flow from the specification, end to end in the browser.
 * (Steps 11–15, the weekly count, are covered by count-offline.spec.ts.)
 */
test.describe.configure({ mode: "serial" });

async function asEmployee(browser: Browser, name: string, pin: string) {
  const s = await newSession(browser, "employee@example.com", { mobile: true });
  await s.page.waitForURL(/\/who/);
  await s.page.getByTestId("who-names").getByRole("button", { name }).click();
  for (const d of pin) await s.page.getByTestId("pin-pad").getByRole("button", { name: d, exact: true }).click();
  await expect(s.page.getByTestId("employee-home")).toBeVisible();
  return s;
}

async function stubVendorSites(page: Page) {
  await page.context().route(/^https:\/\/(shop\.sysco\.com|order\.example\.com)\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>vendor site</h1>" }));
}

let syscoPo = "";

test("1–7: Sysco order placed on its website, short delivery received by an employee, management alerted", async ({ browser }) => {
  const gm = await newSession(browser, "gm@example.com");
  await gm.page.goto("/ordering");
  const sysco = gm.page.getByTestId("vendor-card-Sysco").locator("xpath=ancestor::section[1]");
  await sysco.getByRole("link", { name: "View suggested order" }).click();
  await gm.page.getByLabel("Show the full order guide").check();
  await gm.page.getByLabel("Order quantity Chicken Breast, Boneless").fill("5");
  await gm.page.getByRole("button", { name: "Mark as ordered" }).click();
  await gm.page.getByRole("dialog").getByRole("button", { name: "Yes, mark as ordered" }).click();
  await gm.page.waitForURL(/\/ordering$/);
  await expect(gm.page.getByTestId("vendor-card-Sysco").locator("xpath=ancestor::section[1]")).toContainText("ORDERED");
  syscoPo = (await gm.page.getByTestId("vendor-card-Sysco").locator("xpath=ancestor::section[1]").getByText(/ORDERED · PO-\d+/).textContent())!.split("· ")[1];

  // 2–3. Carlos identifies himself on the shared login and receives the truck
  const emp = await asEmployee(browser, "Carlos", "4826");
  await emp.page.getByTestId("employee-home").getByText("Receive delivery").click();
  await emp.page.locator("li", { hasText: syscoPo }).getByRole("button", { name: "Receive", exact: true }).click();
  await emp.page.waitForURL(/receiving\/[0-9a-f-]{36}$/);
  const receiptUrl = emp.page.url();
  await emp.page.getByRole("button", { name: "Everything arrived as ordered" }).click();
  // 4. one product short: 5 ordered and invoiced, 4 arrived
  await emp.page.getByTestId("received-1001").fill("4");
  await expect(emp.page.getByTestId("flags-1001")).toContainText("Short delivery");
  await expect(emp.page.getByTestId("flags-1001")).toContainText("Invoice ≠ received");
  await emp.page.getByLabel("Invoice #").fill(`SYS-${Date.now()}`);
  await emp.page.getByRole("button", { name: "Complete receiving" }).click();
  await expect(emp.page.locator("main")).toContainText("Awaiting reconciliation");

  // 5–6. management reconciles; inventory rises by what arrived (4 cases), the shortage is credited
  await gm.page.goto(receiptUrl);
  await gm.page.getByRole("button", { name: /Credit shortages/ }).click();
  const calc = (await gm.page.getByTestId("calc-total").textContent())!.replace(/[$,]/g, "");
  await gm.page.getByLabel("Invoice total $").fill(calc);
  await gm.page.getByRole("button", { name: "Reconcile & post" }).click();
  await gm.page.getByRole("dialog").getByRole("button", { name: "Reconcile & post" }).click();
  await expect(gm.page.getByText("Reconciled and posted", { exact: true })).toBeVisible();

  // 7. the discrepancy is on the dashboard and an email is queued for management
  await gm.page.goto("/");
  await expect(gm.page.locator("main")).toContainText("Delivery discrepancies on");
  const owner = await newSession(browser, "owner@example.com");
  await owner.page.goto("/admin/email");
  await expect(owner.page.locator("tr", { hasText: "Delivery discrepancies on" }).first()).toContainText("gm@example.com");
  await owner.page.goto("/admin/audit");
  await expect(owner.page.locator("tbody tr", { hasText: "Delivery received" }).first()).toContainText("Carlos");
  expect([...gm.errors, ...emp.errors, ...owner.errors]).toEqual([]);
  await Promise.all([gm.context.close(), emp.context.close(), owner.context.close()]);
});

test("8–9: an employee logs waste later; inventory decreases and the cost is calculated", async ({ browser }) => {
  const emp = await asEmployee(browser, "Maria", "3691");
  await emp.page.goto("/waste");
  await emp.page.getByLabel("Search item").fill("chicken");
  await emp.page.getByRole("button", { name: "Chicken Breast, Boneless" }).click();
  await emp.page.getByLabel("Quantity").fill("3");
  await emp.page.getByRole("button", { name: "Dropped" }).click();
  await emp.page.getByRole("button", { name: "Log waste" }).click();
  await expect(emp.page.getByText(/Waste logged/)).toBeVisible();
  expect(emp.errors).toEqual([]);
  await emp.context.close();
});

test("10: a Toast order arrives by webhook and creates theoretical usage once", async ({ browser, request }) => {
  const secret = process.env.TOAST_WEBHOOK_SECRET ?? "local-toast-secret";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()).replace(/-/g, "");
  const guid = `e2e-${Date.now()}`;
  const body = JSON.stringify({ eventType: "orders_updated", details: { order: { guid, businessDate: Number(day), modifiedDate: new Date().toISOString(), numberOfGuests: 2,
    checks: [{ guid: "c", selections: [{ guid: `${guid}-s`, item: { guid: "P200" }, displayName: "Cheeseburger", quantity: 2, price: 17.9 }] }] } } });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  const headers = { "Content-Type": "application/json", "Toast-Signature": sig, "Toast-Restaurant-External-ID": "6f1c2a54-0d7e-4b8a-9b1e-101101101101" };
  const first = await request.post("/api/toast/webhook", { data: body, headers });
  expect(first.status()).toBe(200);
  expect((await first.json()).results[0].status).toBe("applied");
  const again = await request.post("/api/toast/webhook", { data: body, headers });
  expect((await again.json()).results[0].status).toBe("unchanged");
  const forged = await request.post("/api/toast/webhook", { data: body, headers: { ...headers, "Toast-Signature": "x" + sig } });
  expect(forged.status()).toBe(401);

  const gm = await newSession(browser, "gm@example.com");
  await gm.page.goto("/sales/toast");
  await expect(gm.page.locator("tr", { hasText: guid.slice(0, 13) }).filter({ has: gm.page.getByText("APPLIED", { exact: true }) })).toHaveCount(1);
  await expect(gm.page.locator("tr", { hasText: guid.slice(0, 13) }).filter({ has: gm.page.getByText("UNCHANGED", { exact: true }) })).toHaveCount(1);
  await expect(gm.page.getByRole("heading", { name: "UNMAPPED TOAST ITEMS" })).toBeVisible();
  await expect(gm.page.locator("main")).toContainText("Lamb Gyro Special");
  expect(gm.errors).toEqual([]);
  await gm.context.close();
});

test("16: food cost reports actual and theoretical from posted data", async ({ browser }) => {
  const owner = await newSession(browser, "owner@example.com");
  await owner.page.goto("/food-cost");
  await expect(owner.page.locator("main")).toContainText(/Actual/);
  await expect(owner.page.locator("main")).toContainText(/Theoretical/);
  expect(owner.errors).toEqual([]);
  await owner.context.close();
});

test("17–19: suggested Sysco and Greco lists, copy order list, open vendor websites", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stubVendorSites(page);
  await login(page, "gm@example.com");
  await page.goto("/ordering");
  for (const [vendor, url] of [["Greco", "https://order.example.com/greco"], ["Sysco", "https://shop.sysco.com"]] as const) {
    await page.getByTestId(`copy-${vendor}`).click();
    await expect(page.getByText(new RegExp(`${vendor} order list copied`))).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.startsWith(`${vendor.toUpperCase()} ORDER`)).toBe(true);
    const link = page.getByTestId(`open-${vendor}`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    expect(popup.url().startsWith(url)).toBe(true);
    await popup.close();
  }
  // WHY? explains a Greco suggestion
  await page.getByTestId("vendor-card-Greco").locator("xpath=ancestor::section[1]").getByRole("link", { name: "View suggested order" }).click();
  await page.getByRole("button", { name: /^Why / }).first().click();
  await expect(page.getByRole("dialog").getByText("NEED", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("HAVE", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("20: commissary order submitted, prepared, shipped and received with a difference", async ({ browser }) => {
  const gm = await newSession(browser, "gm@example.com");
  await gm.page.goto("/commissary/new");
  await gm.page.getByLabel("Quantity Meatballs, 2 oz").fill("50");
  await gm.page.getByLabel("Unit Meatballs, 2 oz").selectOption({ label: "EA" });
  await gm.page.getByRole("button", { name: "Submit to commissary" }).click();
  await gm.page.waitForURL(/commissary\/[0-9a-f-]{36}$/);
  const orderUrl = gm.page.url();
  await expect(gm.page.locator("h1")).toContainText("SUBMITTED");

  const cm = await newSession(browser, "commissary@example.com");
  await cm.page.goto(orderUrl);
  await cm.page.getByRole("button", { name: "Accept" }).click();
  await expect(cm.page.locator("h1")).toContainText("ACCEPTED");
  await cm.page.getByRole("button", { name: "Ready" }).click();
  await expect(cm.page.locator("h1")).toContainText("READY");
  await cm.page.getByRole("button", { name: "Ship order" }).click();
  await cm.page.getByRole("dialog").getByRole("button", { name: "Ship" }).click();
  await expect(cm.page.locator("h1")).toContainText("IN TRANSIT");

  const emp = await asEmployee(browser, "John", "2580");
  await emp.page.goto("/receiving");
  await emp.page.getByText("Commissary deliveries arriving").waitFor();
  await emp.page.goto(orderUrl);
  const meat = emp.page.getByLabel("Received Meatballs, 2 oz");
  await meat.fill("48");
  for (const input of await emp.page.getByLabel(/^Received /).all()) if (!(await input.inputValue())) await input.fill("0");
  await emp.page.getByRole("button", { name: /Confirm with 1 difference|Confirm with \d+ differences/ }).click();
  await expect(emp.page.locator("h1")).toContainText("RECEIVED");
  await expect(emp.page.locator("main")).toContainText("RECEIVED WITH DIFFERENCES");
  expect([...gm.errors, ...cm.errors, ...emp.errors]).toEqual([]);
  await Promise.all([gm.context.close(), cm.context.close(), emp.context.close()]);
});

test("21: the weekly owner email report is generated and previewed", async ({ browser }) => {
  const owner = await newSession(browser, "owner@example.com");
  await owner.page.goto("/admin/email");
  await owner.page.getByRole("button", { name: "Generate weekly report" }).click();
  await expect(owner.page.getByText(/Report generated/)).toBeVisible();
  await owner.page.locator("tr", { hasText: "Weekly Restaurant Inventory Report" }).first().getByRole("link", { name: "Preview" }).click();
  const frame = owner.page.frameLocator('[data-testid="email-preview"]');
  await expect(frame.getByText("VENDOR SPENDING")).toBeVisible();
  await expect(frame.getByText("Actual food cost")).toBeVisible();
  await expect(frame.getByRole("link", { name: "VIEW FULL REPORT" })).toBeVisible();
  expect(owner.errors).toEqual([]);
  await owner.context.close();
});
