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
  "/admin/audit", "/inventory/storage", "/inventory/categories", "/search?q=chicken",
  "/ordering", "/commissary", "/commissary/new", "/sales/toast", "/admin/email", "/admin/employees", "/setup"];

// A page can return 200 and still show a database error (that is how a broken audit log once went unnoticed).
const ERROR_TEXT = /schema cache|could not find|does not exist|permission denied|violates|syntax error|Internal Server Error|Application error/i;

test("every main page renders without errors for the owner", async ({ browser }) => {
  const { page, errors } = await newSession(browser, "owner@example.com");
  for (const p of pages) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(200);
    await expect(page.locator("main h1").first(), p).toBeVisible();
    await expect(page.locator("main"), p).not.toContainText(ERROR_TEXT);
  }
  expect(errors).toEqual([]);
});

test("store manager and employee pages render without errors", async ({ browser }) => {
  for (const [email, list] of [
    ["gm@example.com", ["/", "/inventory", "/counts", "/receiving", "/ordering", "/vendors", "/commissary", "/commissary/new", "/waste", "/transfers",
                        "/recipes", "/sales", "/sales/toast", "/food-cost", "/reports", "/tasks", "/admin", "/admin/employees", "/admin/audit"]],
    ["maria@example.com", ["/", "/receiving", "/waste", "/transfers", "/tasks", "/counts", "/commissary"]],
    ["commissary@example.com", ["/", "/commissary", "/production", "/inventory", "/counts"]],
  ] as const) {
    const { page, errors, context } = await newSession(browser, email);
    for (const p of list) {
      const res = await page.goto(p);
      expect(res?.status(), `${email} ${p}`).toBe(200);
      await expect(page.locator("main h1").first(), `${email} ${p}`).toBeVisible();
      await expect(page.locator("main"), `${email} ${p}`).not.toContainText(ERROR_TEXT);
    }
    expect(errors, email).toEqual([]);
    await context.close();
  }
});
