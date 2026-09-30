import { expect, test } from "@playwright/test";
import { newSession } from "./helpers";

test("waste logging updates the waste log", async ({ browser }) => {
  const { page, errors } = await newSession(browser, "maria@example.com");
  await page.goto("/waste");
  await page.getByLabel("Search item").fill("french");
  await page.getByRole("button", { name: 'French Fries 3/8"' }).click();
  await page.getByLabel("Quantity").fill("1.5");
  await page.getByRole("button", { name: "Dropped" }).click();
  await page.getByRole("button", { name: "Log waste" }).click();
  await expect(page.getByText(/Waste logged/)).toBeVisible();
  await expect(page.locator("table").last()).toContainText('French Fries 3/8"');
  expect(errors).toEqual([]);
});

const pages = ["/", "/inventory", "/counts", "/purchasing", "/receiving", "/vendors", "/waste", "/transfers", "/recipes", "/production",
  "/sales", "/food-cost", "/reports", "/reports?r=efficiency", "/reports?r=vendors", "/tasks", "/admin", "/admin/users", "/admin/locations",
  "/admin/audit", "/inventory/storage", "/inventory/categories", "/search?q=chicken"];

test("every main page renders without errors for the owner", async ({ browser }) => {
  const { page, errors } = await newSession(browser, "owner@example.com");
  for (const p of pages) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(200);
    await expect(page.locator("main h1").first(), p).toBeVisible();
  }
  expect(errors).toEqual([]);
});
