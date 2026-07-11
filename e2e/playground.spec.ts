import { expect, type Page, test } from "@playwright/test";

interface TestCIVerification {
  url: string;
}

interface TestUpstreamCI {
  status: "passed" | "not_passed" | "not_recorded" | "not_checked";
  url?: string;
  conclusion?: string;
}

interface TestEngine {
  version: string;
  commit: string;
  artifact: string;
  sha256: string;
  parseModes?: string[];
  ci?: TestCIVerification;
  upstreamCI?: TestUpstreamCI;
}

interface TestManifest {
  channels: {
    release: TestEngine;
    main: TestEngine;
  };
  releases: TestEngine[];
}

test("synchronizes the AST tree and loads every release plus main", async ({ page }) => {
  test.setTimeout(300_000);

  const loadedWasmArtifacts = new Set<string>();
  page.on("response", (response) => {
    if (!response.ok()) {
      return;
    }
    const artifact = response.url().split("/").at(-1);
    if (artifact?.endsWith(".wasm")) {
      loadedWasmArtifacts.add(artifact);
    }
  });

  await page.goto("./");

  const manifest = await loadTestManifest(page);
  expect(manifest.releases.length).toBeGreaterThan(1);
  expect(manifest.releases.slice(1).map((release) => release.version)).toEqual(
    [...manifest.releases.slice(1).map((release) => release.version)].sort((left, right) =>
      compareStableVersions(right, left),
    ),
  );
  expect(manifest.releases.every((release) => /^v\d+\.\d+\.\d+$/.test(release.version))).toBe(true);
  expect(engineArtifactIdentity(manifest.channels.release)).toEqual(
    engineArtifactIdentity(manifest.releases[0]),
  );
  const latestRelease = manifest.releases[0];
  if (latestRelease === undefined) {
    throw new Error("the generated manifest did not include a latest release");
  }
  expect(compareStableVersions(latestRelease.version, "v0.8.0")).toBeGreaterThanOrEqual(0);
  expect(supportsSchemaType(latestRelease)).toBe(true);

  const legacyRelease = manifest.releases.find((release) => !supportsSchemaType(release));
  if (legacyRelease === undefined) {
    throw new Error("the generated manifest did not include a legacy release");
  }
  expect(compareStableVersions(legacyRelease.version, "v0.8.0")).toBeLessThan(0);

  const status = page.getByRole("status");
  const source = page.getByRole("textbox", { name: "SQL or GQL source" });
  const sqlOutput = page.getByRole("textbox", { name: "SQL output" });
  const releaseEngine = page.getByRole("radio", { name: /^Release/ });
  const mainEngine = page.getByRole("radio", { name: /main snapshot/ });
  const parseMode = page.getByRole("combobox", { name: "Parse mode" });
  const releaseVersion = page.getByRole("combobox", { name: "Release version" });

  await expect(releaseEngine).toBeChecked();
  await expect(releaseVersion).toHaveValue(latestRelease.version);
  const releaseOptions = await releaseVersion.locator("option").evaluateAll((options) =>
    options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent?.trim(),
    })),
  );
  expect(releaseOptions).toEqual(
    manifest.releases.map((release, index) => ({
      value: release.version,
      label: `${release.version}${index === 0 ? " (latest)" : ""}`,
    })),
  );

  await source.fill("SELECT 1 + 2");
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(status).toContainText("Parsed", { timeout: 30_000 });

  const astTree = page.getByRole("tree", { name: "Parsed AST" });
  await expect(astTree).toBeVisible();
  await source.press("Home");
  for (let offset = 0; offset < 9; offset += 1) {
    await source.press("ArrowRight");
  }

  const binaryExpression = astTree.getByRole("treeitem", { name: /Expr: BinaryExpr/ });
  await expect(binaryExpression).toHaveAttribute("aria-selected", "true");
  await expect(binaryExpression).toHaveAttribute("aria-expanded", "true");

  const leftLiteral = astTree.getByRole("treeitem", { name: /Left: IntLiteral/ });
  await leftLiteral.click();
  await expect(leftLiteral).toHaveAttribute("aria-selected", "true");
  await expect(leftLiteral).toBeFocused();
  await expect
    .poll(() => page.locator(".cm-selectionBackground").count(), {
      message: "selecting a ranged AST node should highlight its source",
    })
    .toBeGreaterThan(0);

  await page.getByRole("tab", { name: "JSON" }).click();
  const astJsonOutput = page.getByRole("textbox", { name: "AST JSON output" });
  await expect(astJsonOutput).toHaveValue(/"type": "BinaryExpr"/);
  await expect(astJsonOutput).toHaveValue(/"range"/);

  await page.getByRole("tab", { name: "SQL" }).click();
  await expect(sqlOutput).toHaveValue("SELECT 1 + 2");

  // Keep the tree hidden while parsing non-ASCII source and moving the cursor.
  // Returning to the tab must reveal the UTF-16-selected node, while the node's
  // byte offsets remain different in the JSON projection.
  await page.getByRole("tab", { name: "JSON" }).click();
  await source.fill("SELECT '😀' + 'é'");
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(status).toContainText("Parsed", { timeout: 30_000 });
  await source.press("Home");
  for (let offset = 0; offset < 12; offset += 1) {
    await source.press("ArrowRight");
  }

  await page.getByRole("tab", { name: "AST tree" }).click();
  const unicodeBinaryExpression = astTree.getByRole("treeitem", { name: /Expr: BinaryExpr/ });
  await expect(unicodeBinaryExpression).toHaveAttribute("aria-selected", "true");
  const rightString = astTree.getByRole("treeitem", { name: /Right: StringLiteral/ });
  await rightString.click();
  await expect(rightString).toHaveAttribute("aria-selected", "true");
  await expect(rightString).toBeFocused();
  await expect(rightString).toHaveAttribute("aria-label", /UTF-16 14–17 · bytes 16–20/);

  // Revealing an item beyond the first page must keep the DOM bounded, and
  // the page controls must retain native keyboard activation inside the tree.
  const manySelectItems = `SELECT ${Array.from({ length: 101 }, (_, index) => index).join(", ")}`;
  await source.fill(manySelectItems);
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(status).toContainText("Parsed", { timeout: 30_000 });
  const previousResults = astTree.getByRole("button", {
    name: "Show previous 100 Results items (100 before)",
  });
  await expect(previousResults).toBeVisible();
  expect(await astTree.getByRole("treeitem").count()).toBeLessThan(140);

  const pagedResults = astTree.getByRole("treeitem", { name: /Results: Array \(101\)/ });
  await pagedResults.press("ArrowRight");
  await expect(astTree.getByRole("treeitem", { name: /\[100\]: ExprSelectItem/ })).toBeFocused();

  await previousResults.press("Enter");
  const firstPageResult = astTree.getByRole("treeitem", { name: /\[0\]: ExprSelectItem/ });
  await expect(firstPageResult).toBeVisible();
  await expect(firstPageResult).toBeFocused();

  await page.getByRole("tab", { name: "SQL" }).click();
  for (const [index, release] of manifest.releases.entries()) {
    if (index !== 0) {
      await releaseVersion.selectOption(release.version);
    }

    await expect(releaseEngine).toBeChecked();
    await expect(releaseVersion).toHaveValue(release.version);
    await expectEngineDetails(page, release, release.version);
    await expect(parseMode.getByRole("option", { name: "Schema type" })).toHaveCount(
      supportsSchemaType(release) ? 1 : 0,
    );
    await expect
      .poll(() => loadedWasmArtifacts.has(release.artifact), {
        message: `${release.version} WASM should be requested successfully`,
        timeout: 30_000,
      })
      .toBe(true);

    await source.fill("SELECT 1");
    await page.getByRole("button", { name: "Parse", exact: true }).click();
    await expect(status).toContainText("Parsed", { timeout: 30_000 });
    await expect(sqlOutput).toHaveValue("SELECT 1");

    if (index === 0) {
      // The bridge must contain an upstream panic so the long-lived Worker
      // remains usable after malformed first-token input.
      await source.fill("'");
      await page.getByRole("button", { name: "Parse", exact: true }).click();
      await expect(status).toContainText(/Diagnostics|Parse failed/);

      await source.fill("SELECT 2");
      await page.getByRole("button", { name: "Parse", exact: true }).click();
      await expect(status).toContainText("Parsed");
      await expect(sqlOutput).toHaveValue("SELECT 2");
    }
  }

  await mainEngine.check();
  await expect(mainEngine).toBeChecked();
  await expect(releaseVersion).toHaveCount(0);
  await expectEngineDetails(page, manifest.channels.main, "main");
  await expect(parseMode.getByRole("option", { name: "Schema type" })).toHaveCount(
    supportsSchemaType(manifest.channels.main) ? 1 : 0,
  );
  await expect
    .poll(() => loadedWasmArtifacts.has(manifest.channels.main.artifact), {
      message: "main WASM should be requested successfully",
      timeout: 30_000,
    })
    .toBe(true);

  await source.fill("SELECT 1");
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(status).toContainText("Parsed", { timeout: 30_000 });
  await expect(sqlOutput).toHaveValue("SELECT 1");

  const presetTrigger = page.getByRole("button", { name: /Browse \d+ presets/ });
  await expect(presetTrigger).toBeEnabled();
  await presetTrigger.click();

  const presetDialog = page.getByRole("dialog", { name: "Browse parser presets" });
  await expect(presetDialog).toBeVisible();
  await expect(presetDialog.getByRole("link").locator("code")).toHaveText(/^[0-9a-f]{40}$/);

  await presetDialog
    .getByRole("searchbox", { name: "Search path or source" })
    .fill("query/select_star.sql");
  const presetFiles = presetDialog.getByRole("listbox", { name: "Preset files" });
  await expect(presetFiles.getByRole("option")).toHaveCount(1);
  await presetFiles.selectOption("query/select_star.sql");
  await presetDialog.getByRole("button", { name: "Load preset" }).click();

  await expect(presetDialog).toBeHidden();
  await expect(mainEngine).toBeChecked();
  await expect(parseMode).toHaveValue("query");
  await expect(source).toContainText(/SELECT \*/);
  await expect(status).toContainText("Parsed");
  await expect(page.locator(".loaded-preset code")).toHaveText("query/select_star.sql");
  await expect(page.getByText("Loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "memefish repository" })).toHaveAttribute(
    "href",
    "https://github.com/cloudspannerecosystem/memefish",
  );
  await expect(page.getByRole("link", { name: "memefish-playground repository" })).toHaveAttribute(
    "href",
    "https://github.com/apstndb/memefish-playground",
  );
});

async function loadTestManifest(page: Page): Promise<TestManifest> {
  return page.evaluate(async () => {
    const response = await fetch(new URL("wasm/versions.json", window.location.href), {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`could not load the generated manifest: HTTP ${response.status}`);
    }
    return response.json() as Promise<TestManifest>;
  });
}

async function expectEngineDetails(page: Page, engine: TestEngine, label: string): Promise<void> {
  const identity = page.getByRole("complementary", { name: "Loaded engine identity" });
  await expect(identity.locator("strong")).toHaveText(label);
  await expect(identity.locator("code")).toHaveText(engine.commit);

  const advisory = identity.locator(".upstream-ci");
  const upstreamCI = engine.upstreamCI;
  if (upstreamCI === undefined) {
    if (engine.ci === undefined) {
      await expect(advisory).toHaveCount(0);
      return;
    }
    await expectLinkedAdvisory(advisory, "Upstream CI passed", engine.ci.url);
    return;
  }

  switch (upstreamCI.status) {
    case "passed":
      await expectLinkedAdvisory(advisory, "Upstream CI passed", upstreamCI.url);
      break;
    case "not_passed":
      await expectLinkedAdvisory(advisory, "Upstream CI did not pass", upstreamCI.url);
      await expect(advisory).toHaveAttribute(
        "title",
        new RegExp(`concluded ${escapeRegExp(upstreamCI.conclusion ?? "")} \\(advisory only\\)`),
      );
      break;
    case "not_recorded":
      await expectUnlinkedAdvisory(advisory, "Upstream CI not recorded");
      break;
    case "not_checked":
      await expectUnlinkedAdvisory(advisory, "Upstream CI not checked");
      break;
  }
}

async function expectLinkedAdvisory(
  advisory: import("@playwright/test").Locator,
  label: string,
  url: string | undefined,
): Promise<void> {
  if (url === undefined) {
    throw new Error(`${label} is missing its upstream workflow URL`);
  }
  await expect(advisory).toHaveText(label);
  await expect(advisory).toHaveAttribute("href", url);
  await expect(advisory).toHaveAttribute("title", /advisory only/);
}

async function expectUnlinkedAdvisory(
  advisory: import("@playwright/test").Locator,
  label: string,
): Promise<void> {
  await expect(advisory).toHaveText(label);
  await expect(advisory).not.toHaveAttribute("href", /.+/);
  await expect(advisory).toHaveAttribute("title", /advisory only/);
}

function engineArtifactIdentity(
  engine: TestEngine | undefined,
): Record<string, string> | undefined {
  if (engine === undefined) {
    return undefined;
  }
  return {
    version: engine.version,
    commit: engine.commit,
    artifact: engine.artifact,
    sha256: engine.sha256,
  };
}

function supportsSchemaType(engine: TestEngine): boolean {
  return engine.parseModes === undefined || engine.parseModes.includes("schemaType");
}

function compareStableVersions(left: string, right: string): number {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
