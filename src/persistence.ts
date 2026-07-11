import { isParseMode, type EngineChannel, type ParseMode } from "./protocol";

const STORAGE_KEY = "memefish-playground:preferences:v1";

export interface Preferences {
  engine: EngineChannel;
  mode: ParseMode;
  source: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_PREFERENCES: Preferences = {
  engine: "release",
  mode: "statement",
  source: "SELECT SingerId, FirstName\nFROM Singers\nORDER BY SingerId",
};

export function loadPreferences(storage = browserStorage()): Preferences {
  if (storage === null) {
    return DEFAULT_PREFERENCES;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_PREFERENCES;
    }
    const value: unknown = JSON.parse(raw);
    if (!isPreferences(value)) {
      return DEFAULT_PREFERENCES;
    }
    return value;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences, storage = browserStorage()): boolean {
  if (storage === null) {
    return false;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPreferences(value: unknown): value is Preferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.engine === "release" || candidate.engine === "main") &&
    isParseMode(candidate.mode) &&
    typeof candidate.source === "string"
  );
}
