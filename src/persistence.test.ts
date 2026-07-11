import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type StorageLike,
} from "./persistence";

class MemoryStorage implements StorageLike {
  value: string | null = null;

  getItem(): string | null {
    return this.value;
  }

  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

describe("preference persistence", () => {
  it("round-trips valid local preferences", () => {
    const storage = new MemoryStorage();
    const preferences = { engine: "main", mode: "query", source: "SELECT 1" } as const;

    expect(savePreferences(preferences, storage)).toBe(true);
    expect(loadPreferences(storage)).toEqual(preferences);
  });

  it("falls back safely when storage reads, writes, or JSON parsing fail", () => {
    const throwingStorage: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(loadPreferences(throwingStorage)).toEqual(DEFAULT_PREFERENCES);
    expect(savePreferences(DEFAULT_PREFERENCES, throwingStorage)).toBe(false);

    const malformedStorage = new MemoryStorage();
    malformedStorage.value = "{not json";
    expect(loadPreferences(malformedStorage)).toEqual(DEFAULT_PREFERENCES);
  });
});
