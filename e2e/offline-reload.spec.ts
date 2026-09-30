import { expect, test } from "@playwright/test";
import { newSession } from "./helpers";

test("a downloaded count opens with no connection at all (service worker + device copy)", async ({ browser }) => {
  const { context, page } = await newSession(browser, "john@example.com", { mobile: true });
  await page.goto("/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  await page.getByText("Location count", { exact: true }).click();
  await page.getByRole("dialog").getByLabel("Walk-In Freezer").check();
  await page.getByRole("dialog").getByRole("button", { name: "Start count" }).click();
  await page.waitForURL(/\/counts\/[0-9a-f-]{36}$/);
  const url = page.url();
  await expect(page.getByTestId("focus-card")).toBeVisible();
  // Service worker is active in production builds; give it a moment to install and claim
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15_000 });
  await page.goto("/counts");
  await page.getByRole("link", { name: /Start counting|Continue count/ }).first().waitFor();
  // The card for this session (opening a count already keeps a device copy, so the
  // button may already read "Saved"; clicking it re-downloads the sheet and page)
  const card = page.locator("section", { has: page.locator(`a[href="${new URL(url).pathname}"]`) }).first();
  await card.getByRole("button", { name: /Download for offline|Saved to device/ }).click();
  await expect(page.getByText("Saved to this device for offline counting")).toBeVisible();
  await page.waitForTimeout(1500);

  await context.setOffline(true);
  await page.goto(url);  // full page load with no network
  await expect(page.getByTestId("focus-card")).toBeVisible();
  await expect(page.getByTestId("current-item")).not.toBeEmpty();
  const input = page.getByTestId("focus-card").locator("input").first();
  await input.fill("3");
  await page.getByTestId("focus-card").getByRole("button", { name: /^(Next|Save)/ }).click();
  await expect(page.getByTestId("sync-status").first()).toHaveAttribute("data-state", "offline");

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("sync-status").first()).toHaveAttribute("data-state", "synced", { timeout: 20_000 });
});
