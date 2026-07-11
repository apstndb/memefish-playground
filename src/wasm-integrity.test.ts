import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyWasmAsset } from "./wasm-integrity";

const subtle = webcrypto.subtle as SubtleCrypto;

describe("verifyWasmAsset", () => {
  it("accepts bytes with the expected size and SHA-256 digest", async () => {
    const bytes = new TextEncoder().encode("memefish wasm").buffer;

    await expect(
      verifyWasmAsset(
        bytes,
        13,
        "efe455c7e7259b959123c1da56eb14444891497d76596551add8d2ef8e4e777b",
        subtle,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a size mismatch before hashing", async () => {
    const bytes = new TextEncoder().encode("wasm").buffer;
    const digest = vi.fn();

    await expect(
      verifyWasmAsset(bytes, bytes.byteLength + 1, "a".repeat(64), { digest }),
    ).rejects.toThrow("size does not match");
    expect(digest).not.toHaveBeenCalled();
  });

  it("rejects a digest mismatch and digest-provider failures", async () => {
    const bytes = new TextEncoder().encode("wasm").buffer;

    await expect(verifyWasmAsset(bytes, bytes.byteLength, "a".repeat(64), subtle)).rejects.toThrow(
      "digest does not match",
    );

    await expect(
      verifyWasmAsset(bytes, bytes.byteLength, "a".repeat(64), {
        digest: vi.fn().mockRejectedValue(new Error("unavailable")),
      }),
    ).rejects.toThrow("digest could not be verified");
  });
});
