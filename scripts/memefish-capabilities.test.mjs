import { describe, expect, it } from "vitest";
import { capabilitiesForMemefishVersion } from "./memefish-capabilities.mjs";

describe("capabilitiesForMemefishVersion", () => {
  it.each([
    "v0.8.0",
    "v0.8.1-0.20260710071317-fd610852d27f",
    "v1.0.0",
  ])("enables the public schema type helper for %s", (version) => {
    const capabilities = capabilitiesForMemefishVersion(version);
    expect(capabilities.parseModes).toContain("schemaType");
    expect(capabilities.buildTags).toEqual([]);
  });

  it("uses the legacy build path before v0.8.0", () => {
    const capabilities = capabilitiesForMemefishVersion("v0.7.0");
    expect(capabilities.parseModes).not.toContain("schemaType");
    expect(capabilities.buildTags).toEqual(["memefish_pre_v0_8"]);
  });

  it.each(["", "main", "v0.8", "0.8.0"])("rejects unknown version shape %j", (version) => {
    expect(() => capabilitiesForMemefishVersion(version)).toThrow(
      "unsupported memefish module version",
    );
  });
});
