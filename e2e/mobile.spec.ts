import { expect, test } from "@playwright/test";
import { login } from "./helpers";

for (const p of ["/", "/counts", "/receiving", "/waste", "/purchasing", "/inventory"]) {
  test(`no horizontal scroll on phones: ${p}`, async ({ page }) => {
    await login(page, "gm@example.com");
    await page.goto(p);
    await expect(page.locator("main h1").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });
}
