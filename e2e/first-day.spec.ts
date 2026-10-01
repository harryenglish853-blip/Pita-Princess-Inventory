import { expect, test } from "@playwright/test";

// A real restaurant's first day: sign up, create the restaurant, follow the
// checklist, upload products from a spreadsheet, start the first count.
test("new restaurant: sign up, set up, import products, start the first count", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const email = `owner-${Date.now()}@pita.test`;

  await page.goto("/signup");
  await page.fill('input[name="full_name"]', "Harry Owner");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "Friday2026!");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding/);
  await page.fill('input[name="org_name"]', "Pita Princess");
  await page.fill('input[name="location_code"]', "1");
  await page.fill('input[name="location_name"]', "Main Street");
  await page.selectOption('select[name="timezone"]', "America/Chicago");
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await page.waitForURL((u) => u.pathname === "/");

  // Empty home screen points at the checklist
  await expect(page.getByTestId("setup-banner")).toContainText("Finish setting up · 0 of 8 done");
  await page.getByTestId("setup-banner").click();
  await page.waitForURL(/\/setup$/);
  await expect(page.getByTestId("step-products")).toHaveAttribute("data-done", "false");
  await page.getByTestId("step-products").getByRole("link", { name: "Import spreadsheet" }).click();
  await page.waitForURL(/\/inventory\/import$/);

  // Paste cells as copied from a sheet (tab separated), with everyday spellings
  const sheet = [
    ["Product", "UOM", "Pack", "Supplier", "SUPC", "Price", "Storage", "Par"],
    ["Chicken Breast", "lbs", "40", "Sysco", "1234567", "$131.50", "Walk-In Cooler", "80"],
    ["Pita Bread", "each", "12", "Local Bakery", "", "6.00", "Dry Storage", "48"],
    ["Tahini", "lb", "", "Sysco", "7654321", "", "Dry Storage", ""],
    ["Mystery", "furlongs", "", "", "", "", "", ""],
  ].map((r) => r.join("\t")).join("\n");
  await page.getByLabel("Paste spreadsheet cells").fill(sheet);
  await expect(page.getByTestId("column-map")).toContainText("Product → Item name");
  await page.getByRole("button", { name: "Preview 4 items" }).click();
  await expect(page.getByTestId("import-summary")).toContainText("3 new");
  await expect(page.getByTestId("import-summary")).toContainText("1 with problems");
  await expect(page.getByText('Unknown count unit "furlongs"')).toBeVisible();
  await page.getByRole("button", { name: "Import 3 items" }).click();
  await expect(page.getByText("Your items are in.")).toBeVisible();

  // Checklist reflects it
  await page.goto("/setup");
  await expect(page.getByTestId("step-products")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("step-storage")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("step-vendors")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("step-shelf")).toContainText("3 of 3 placed");

  // First count lists the imported items, case + pound entry for chicken
  await page.goto("/counts");
  await page.getByRole("button", { name: "Start count" }).click();
  await page.getByText("Full inventory", { exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start count" }).click();
  await page.waitForURL(/\/counts\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("count-progress")).toHaveText(/^0 \/ 3$/);
  await expect(page.getByTestId("current-item")).toHaveText("Chicken Breast");
  await expect(page.getByTestId("focus-card")).toContainText("= 40 LB");

  // Password can be changed
  await page.goto("/account");
  await page.getByLabel("New password").fill("Saturday2026!");
  await page.getByLabel("Type it again").fill("Saturday2026!");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
