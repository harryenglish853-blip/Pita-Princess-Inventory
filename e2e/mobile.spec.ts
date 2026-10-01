import { expect, test } from "@playwright/test";
import { login } from "./helpers";

for (const p of ["/", "/counts", "/receiving", "/waste", "/purchasing", "/inventory", "/ordering", "/commissary", "/commissary/new", "/sales/toast", "/tasks"]) {
  test(`no horizontal scroll on phones: ${p}`, async ({ page }) => {
    await login(page, "gm@example.com");
    await page.goto(p);
    await expect(page.locator("main h1").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });
}

test("no horizontal scroll on phones: employee home and PIN pad", async ({ page }) => {
  await login(page, "employee@example.com");
  await page.waitForURL(/\/who/);
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByTestId("who-names").getByRole("button", { name: "Alex" }).click();
  for (const d of "5937") await page.getByTestId("pin-pad").getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByTestId("employee-home")).toBeVisible();
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const label of ["Home", "Receive", "Waste", "Tasks"]) await expect(nav.getByRole("link", { name: label })).toBeVisible();
});
