import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("weekly count on a tablet: big inputs, numeric keyboard, no sideways scrolling", async ({ page }) => {
  await login(page, "gm@example.com");
  await page.goto("/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  await page.getByText("Location count", { exact: true }).click();
  await page.getByRole("dialog").getByLabel("Walk-In Cooler").check();
  await page.getByRole("dialog").getByRole("button", { name: "Start count" }).click();
  await page.waitForURL(/\/counts\/[0-9a-f-]{36}$/);
  const card = page.getByTestId("focus-card");
  await expect(card).toBeVisible();
  const input = card.locator("input").first();
  await expect(input).toHaveAttribute("inputmode", /decimal|numeric/);
  const box = await input.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);   // comfortable touch target
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await input.fill("12");
  await card.getByRole("button", { name: /^(Next|Save)/ }).click();
  await expect(page.getByTestId("sync-status").first()).toHaveAttribute("data-state", /synced|syncing|saved/);
});
