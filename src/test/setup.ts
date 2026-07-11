import "@testing-library/jest-dom/vitest";

if (typeof Range !== "undefined" && Range.prototype.getClientRects === undefined) {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as DOMRectList;
}
