export const ALL_PARSE_MODES = Object.freeze([
  "statement",
  "statements",
  "query",
  "expr",
  "type",
  "schemaType",
  "ddl",
  "ddls",
  "dml",
  "dmls",
]);

const legacySchemaTypeTag = "memefish_pre_v0_8";

export function capabilitiesForMemefishVersion(version) {
  if (typeof version !== "string") {
    throw new TypeError("memefish version must be a string");
  }
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version);
  if (match === null) {
    throw new Error(`unsupported memefish module version: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const hasSchemaTypeAPI = major > 0 || minor >= 8;
  return {
    parseModes: hasSchemaTypeAPI
      ? [...ALL_PARSE_MODES]
      : ALL_PARSE_MODES.filter((mode) => mode !== "schemaType"),
    buildTags: hasSchemaTypeAPI ? [] : [legacySchemaTypeTag],
  };
}
