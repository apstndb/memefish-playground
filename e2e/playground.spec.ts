import { expect, test } from "@playwright/test";

test("parses with both release and main WASM engines under the Pages base path", async ({
  page,
}) => {
  await page.goto("./");

  const status = page.getByRole("status");
  const source = page.getByRole("textbox", { name: "SQL or GQL source" });
  const sqlOutput = page.getByRole("textbox", { name: "SQL output" });
  const releaseEngine = page.getByRole("radio", { name: /Latest release/ });
  const mainEngine = page.getByRole("radio", { name: /main snapshot/ });

  await expect(releaseEngine).toBeChecked();
  await expect(status).toContainText("Parsed");
  await expectFullCommit(page);

  await source.fill("SELECT 1");
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(status).toContainText("Parsed");
  await page.getByRole("tab", { name: "SQL" }).click();
  await expect(sqlOutput).toHaveValue("SELECT 1");

  // v0.8.0 can panic on malformed first-token input. The bridge must contain
  // that failure per request so the long-lived Worker remains usable.
  await source.fill("'");
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(status).toContainText(/Diagnostics|Parse failed/);

  await source.fill("SELECT 2");
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(status).toContainText("Parsed");
  await expect(sqlOutput).toHaveValue("SELECT 2");

  await mainEngine.check();
  await expect(mainEngine).toBeChecked();
  await expect(status).toContainText("Parsed");
  await expect(sqlOutput).toHaveValue("SELECT 2");
  await expectFullCommit(page);
});

async function expectFullCommit(page: import("@playwright/test").Page): Promise<void> {
  const identity = page.getByRole("complementary", { name: "Loaded engine identity" });
  await expect(identity.locator("code")).toHaveText(/^[0-9a-f]{40}$/);
}
