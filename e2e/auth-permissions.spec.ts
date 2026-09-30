import { expect, test } from "@playwright/test";
import { login, newSession } from "./helpers";

test("unauthenticated users are sent to login", async ({ page }) => {
  await page.goto("/inventory");
  await expect(page).toHaveURL(/\/login\?next=%2Finventory/);
});

test("wrong password shows an error", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "gm@example.com");
  await page.fill('input[name="password"]', "wrong-password");
  await page.click('button[type="submit"]');
  await expect(page.getByRole("alert").first()).toContainText("incorrect");
});

test("employee sees operational actions only", async ({ browser }) => {
  const { page, errors } = await newSession(browser, "maria@example.com");
  await expect(page.getByRole("link", { name: "Count inventory" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Food Cost (AvT)" })).toHaveCount(0);
  await page.goto("/admin/users");
  await expect(page).toHaveURL(/\/denied/);
  await page.goto("/food-cost");
  await expect(page).toHaveURL(/\/denied/);
  expect(errors).toEqual([]);
});

test("general manager cannot edit corporate product master", async ({ browser }) => {
  const { page } = await newSession(browser, "gm@example.com");
  await page.goto("/inventory");
  await page.getByRole("link", { name: "Chicken Breast, Boneless" }).click();
  await page.getByRole("link", { name: "Product master" }).click();
  await expect(page.getByText("read-only for your role")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save product" })).toHaveCount(0);
});

test("owner signs in and sees the corporate scorecard", async ({ page }) => {
  await login(page, "owner@example.com");
  await expect(page.getByText("ALL LOCATIONS · LAST 28 DAYS")).toBeVisible();
});
