import { expect, test } from "@playwright/test";
import { newSession } from "./helpers";

test("order with manager override, short delivery with back order, reconcile and post", async ({ browser }) => {
  const gm = await newSession(browser, "gm@example.com");
  await gm.page.goto("/purchasing");
  await gm.page.getByRole("link", { name: /US Foods/ }).first().click();
  await gm.page.waitForURL(/purchasing\/(new|[0-9a-f-]{36})/);
  if (!/\/new/.test(gm.page.url())) {
    // A draft already exists: edit it
    await gm.page.getByRole("link", { name: "Edit order" }).click();
  }
  // "Why?" explanation is available for every suggestion
  await gm.page.getByRole("button", { name: /Why .* CASE\?/ }).first().click();
  await expect(gm.page.getByRole("dialog").getByText("NEED", { exact: true })).toBeVisible();
  await gm.page.keyboard.press("Escape");
  await gm.page.getByLabel("Order quantity Chicken Breast, Boneless").fill("5");
  await gm.page.getByRole("button", { name: "Submit order" }).click();
  await gm.page.getByRole("dialog").getByRole("button", { name: "Submit order" }).click();
  await gm.page.waitForURL(/purchasing\/[0-9a-f-]{36}$/);
  await expect(gm.page.locator("main")).toContainText("Submitted");
  const poNumber = (await gm.page.locator("h1").textContent())!.split(" ")[0];

  const emp = await newSession(browser, "maria@example.com", { mobile: true });
  await emp.page.goto("/receiving");
  await emp.page.locator("li", { hasText: poNumber }).getByRole("button", { name: "Receive", exact: true }).click();
  await emp.page.waitForURL(/receiving\/[0-9a-f-]{36}$/);
  const receiptUrl = emp.page.url();
  await emp.page.getByRole("button", { name: "Everything arrived as ordered" }).click();
  await emp.page.getByTestId("received-1001").fill("4");
  await expect(emp.page.getByTestId("flags-1001")).toContainText("Short delivery");
  await expect(emp.page.getByTestId("flags-1001")).toContainText("Invoice ≠ received");
  await emp.page.getByText("Chicken Breast, Boneless", { exact: true }).click();
  await emp.page.getByLabel(/Back order the missing/).check();
  await emp.page.getByLabel("Invoice #").fill(`E2E-${Date.now()}`);
  await emp.page.getByRole("button", { name: "Complete receiving" }).click();
  await expect(emp.page.locator("main")).toContainText("Awaiting reconciliation");
  // Employees cannot reconcile
  await expect(emp.page.getByRole("button", { name: "Reconcile & post" })).toHaveCount(0);

  await gm.page.goto(receiptUrl);
  const calc = (await gm.page.getByTestId("calc-total").textContent())!.replace(/[$,]/g, "");
  await gm.page.getByLabel("Invoice total $").fill(calc);
  await expect(gm.page.getByTestId("over-short")).toHaveText("$0.00");
  await gm.page.getByRole("button", { name: "Reconcile & post" }).click();
  await gm.page.getByRole("dialog").getByRole("button", { name: "Reconcile & post" }).click();
  await expect(gm.page.getByText("Reconciled and posted", { exact: true })).toBeVisible();
  await gm.page.goto("/purchasing");
  await expect(gm.page.locator("tr", { hasText: poNumber }).first()).toContainText("Back Ordered");
  expect([...gm.errors, ...emp.errors]).toEqual([]);
});

test("invoice scanner explains when it is not configured", async ({ browser }) => {
  test.skip(!!process.env.ANTHROPIC_API_KEY, "scanner is configured in this environment");
  const gm = await newSession(browser, "gm@example.com");
  await gm.page.goto("/receiving");
  const link = gm.page.getByRole("link", { name: /Reconcile|Continue/ }).first();
  await link.click();
  await gm.page.getByRole("button", { name: "Scan invoice" }).click();
  await gm.page.locator('input[type="file"]').setInputFiles({ name: "invoice.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
  await expect(gm.page.getByRole("dialog")).toContainText("not set up");
});
