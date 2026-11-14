import { expect, test } from "@playwright/test";

test("on a computer the page asks to be opened on a phone, with a way to carry on anyway", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-screen", "desktop");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This one's for your phone");
  await expect(page.locator(".card__link")).toHaveText("http://localhost:4174/");
  await page.getByRole("link", { name: "Continue here anyway" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-screen", /waiting|start/);
});
