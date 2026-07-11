export class WasmIntegrityError extends Error {
  override name = "WasmIntegrityError";
}

export async function verifyWasmAsset(
  bytes: ArrayBuffer,
  expectedBytes: number,
  expectedSha256: string,
  subtle: Pick<SubtleCrypto, "digest"> = crypto.subtle,
): Promise<void> {
  if (bytes.byteLength !== expectedBytes) {
    throw new WasmIntegrityError("WebAssembly size does not match version metadata.");
  }

  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", bytes);
  } catch (error) {
    throw new WasmIntegrityError("WebAssembly digest could not be verified.", { cause: error });
  }
  if (toHex(new Uint8Array(digest)) !== expectedSha256.toLowerCase()) {
    throw new WasmIntegrityError("WebAssembly digest does not match version metadata.");
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
