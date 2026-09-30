import { expect, test } from "@playwright/test";
import { newSession } from "./helpers";

test("count keeps working offline, syncs when back online, and manager posts it", async ({ browser }) => {
  const counter = await newSession(browser, "maria@example.com", { mobile: true });
  const page = counter.page;
  await page.goto("/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  await page.getByText("Daily count", { exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start count" }).click();
  await page.waitForURL(/\/counts\/[0-9a-f-]{36}$/);
  const card = page.getByTestId("focus-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("current-item")).toHaveText("Chicken Breast, Boneless");

  // Case + weight: 1 CASE + 8.5 LB = 48.5 LB
  const inputs = card.locator("input");
  await inputs.nth(0).fill("1");
  await inputs.nth(1).fill("8.5");
  await expect(page.getByTestId("line-total")).toHaveText("48.5 LB");
  await card.getByRole("button", { name: /^Next/ }).click();
  await expect(page.getByTestId("count-progress")).toHaveText(/^1 \//);

  // Walk-in cooler: no signal
  await counter.context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await inputs.nth(0).fill("2");
  await card.getByRole("button", { name: /^Next/ }).click();
  await inputs.nth(0).fill("1*20+3");  // calculator input
  await card.getByRole("button", { name: /^Next/ }).click();
  await expect(page.getByTestId("sync-status").first()).toHaveAttribute("data-state", "offline");
  await expect(page.getByTestId("sync-status").first()).toContainText("2");

  // Voice phrase (typed fallback) — avocado 2 cases + 6 each = 102
  await page.getByText("Type a voice phrase").click();
  await page.getByLabel("Voice phrase").fill("avocado two cases six each");
  await page.getByRole("button", { name: "Interpret" }).click();
  await expect(page.getByTestId("current-item")).toHaveText("Avocado, Hass");
  await expect(page.getByTestId("line-total")).toHaveText("102 EA");

  // Back online: everything syncs
  await counter.context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("sync-status").first()).toHaveAttribute("data-state", "synced", { timeout: 20_000 });
  await expect(page.getByTestId("count-progress")).toHaveText(/^4 \//);
  const sessionUrl = new URL(page.url()).pathname + "/review";
  await page.getByRole("button", { name: "Save & review" }).click();
  await page.waitForURL(/\/counts$/);
  expect(counter.errors).toEqual([]);

  // Manager reviews and posts with the typed confirmation
  const mgr = await newSession(browser, "gm@example.com");
  await mgr.page.goto(sessionUrl);
  await expect(mgr.page.getByRole("heading", { level: 1 })).toContainText("Inventory review");
  await expect(mgr.page.getByText("Chicken Breast, Boneless")).toBeVisible();
  await mgr.page.getByRole("button", { name: "Post inventory" }).click();
  await mgr.page.getByLabel(/Type/).fill("POST");
  await mgr.page.getByRole("dialog").getByRole("button", { name: "Post inventory" }).click();
  await expect(mgr.page.getByText("Posted", { exact: true })).toBeVisible();
  expect(mgr.errors).toEqual([]);
});
