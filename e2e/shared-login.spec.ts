import { expect, test, type Page } from "@playwright/test";
import { newSession } from "./helpers";

async function enterPin(page: Page, pin: string) {
  for (const d of pin) await page.getByTestId("pin-pad").getByRole("button", { name: d, exact: true }).click();
}

test("shared employee login: who are you + PIN, actions recorded under the person", async ({ browser }) => {
  const { page, errors } = await newSession(browser, "employee@example.com");
  await expect(page).toHaveURL(/\/who/);
  await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();

  // nothing else is reachable until someone is identified
  await page.goto("/waste");
  await expect(page).toHaveURL(/\/who/);

  await page.getByTestId("who-names").getByRole("button", { name: "Carlos" }).click();
  await enterPin(page, "1357");
  await expect(page.getByTestId("pin-pad").getByRole("alert")).toContainText("Incorrect PIN");
  await enterPin(page, "4826");
  await expect(page.getByTestId("employee-home")).toBeVisible();
  await expect(page.getByTestId("acting-employee")).toContainText("Carlos");
  await expect(page.getByText("Receive delivery", { exact: false }).first()).toBeVisible();

  // employees do not get management screens
  await page.goto("/food-cost");
  await expect(page).toHaveURL(/\/denied/);

  // log waste as Carlos
  await page.goto("/waste");
  await page.getByLabel("Search item").fill("french");
  await page.getByRole("button", { name: 'French Fries 3/8"' }).click();
  await page.getByLabel("Quantity").fill("3");
  await page.getByRole("button", { name: "Dropped" }).click();
  await page.getByRole("button", { name: "Log waste" }).click();
  await expect(page.getByText(/Waste logged/)).toBeVisible();

  // switch person returns to the picker
  await page.getByTestId("acting-employee").getByRole("button", { name: "Switch" }).click();
  await expect(page).toHaveURL(/\/who/);
  expect(errors).toEqual([]);

  // the owner sees Carlos in the audit log
  const owner = await newSession(browser, "owner@example.com");
  await owner.page.goto("/admin/audit?q=French");
  const row = owner.page.locator("tbody tr", { hasText: "Wasted 3 LB" }).first();
  await expect(row).toContainText("Carlos");
  await expect(row).toContainText("Employee Login (shared)");
  await owner.context.close();
});
