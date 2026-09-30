import { expect, type Browser, type Page } from "@playwright/test";

export const PASSWORD = "Demo1234!";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login")), page.click('button[type="submit"]')]);
}

export async function newSession(browser: Browser, email: string, opts: { mobile?: boolean } = {}) {
  const context = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await login(page, email);
  return { context, page, errors };
}

export async function expectNoPageErrors(errors: string[]) {
  expect(errors, errors.join("\n")).toEqual([]);
}
