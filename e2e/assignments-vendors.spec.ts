import { expect, test } from "@playwright/test";
import { newSession } from "./helpers";

test("manager assigns storage areas; the counter's sheet opens on their area", async ({ browser }) => {
  const gm = await newSession(browser, "gm@example.com");
  await gm.page.goto("/counts");
  await gm.page.getByRole("button", { name: "Start count" }).click();
  await gm.page.getByText("Location count", { exact: true }).click();
  await gm.page.getByRole("dialog").getByLabel("Walk-In Cooler").check();
  await gm.page.getByRole("dialog").getByLabel("Dry Storage A").check();
  await gm.page.getByRole("dialog").getByRole("button", { name: "Start count" }).click();
  await gm.page.waitForURL(/\/counts\/[0-9a-f-]{36}$/);
  const countUrl = gm.page.url();

  await gm.page.goto(`${countUrl}/assign`);
  await expect(gm.page.getByTestId("area-Dry Storage A")).toContainText("nobody assigned");
  await gm.page.getByLabel("Maria Lopez: Dry Storage A").check();
  await gm.page.getByRole("button", { name: "Save assignments" }).click();
  await expect(gm.page.getByText("Assignments saved", { exact: true })).toBeVisible();
  await expect(gm.page.getByTestId("area-Dry Storage A")).toContainText("Maria Lopez");

  const maria = await newSession(browser, "maria@example.com", { mobile: true });
  await maria.page.goto("/counts");
  await expect(maria.page.locator("section", { has: maria.page.locator(`a[href="${new URL(countUrl).pathname}"]`) })).toContainText("Your areas: Dry Storage A");
  await maria.page.goto(countUrl);
  await expect(maria.page.getByRole("button", { name: "Dry Storage A · yours" })).toHaveAttribute("aria-pressed", "true");
  // Employees cannot open the assignment screen
  await maria.page.goto(`${countUrl}/assign`);
  await expect(maria.page.getByRole("button", { name: "Save assignments" })).toHaveCount(0);
  expect([...gm.errors, ...maria.errors]).toEqual([]);
});

test("store overrides a vendor's delivery schedule, then returns to company settings", async ({ browser }) => {
  const gm = await newSession(browser, "gm@example.com");
  await gm.page.goto("/vendors");
  await gm.page.getByRole("link", { name: "Local Produce Company" }).first().click();
  await gm.page.waitForURL(/\/vendors\/[0-9a-f-]{36}$/);
  const store = gm.page.getByTestId("store-vendor-settings");
  await store.getByText("Change for this store").click();
  await store.getByLabel("Lead time (days)").fill("3");
  await store.getByLabel("Store account #").fill("LPC-101");
  await store.getByRole("button", { name: "Save for this store" }).click();
  await expect(gm.page.getByTestId("store-vendor-effective")).toContainText("3 day(s) *");
  await expect(gm.page.getByTestId("store-vendor-effective")).toContainText("LPC-101 *");

  if (!(await store.evaluate((d) => (d as HTMLDetailsElement).open))) await store.getByText("Change for this store").click();
  await store.getByRole("button", { name: "Use company settings" }).click();
  await gm.page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(gm.page.getByText("Store now uses the company settings")).toBeVisible();
  await expect(gm.page.getByTestId("store-vendor-effective")).not.toContainText("*");
  expect(gm.errors).toEqual([]);
});
