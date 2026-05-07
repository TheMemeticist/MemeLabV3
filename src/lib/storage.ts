// Tiny localStorage wrapper. Schema-versioned. All keys under cda_v3:.

const PREFIX = 'cda_v3:';
const SCHEMA_VERSION = 1;

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { v: number; data: T };
    if (parsed.v !== SCHEMA_VERSION) return fallback;
    return parsed.data ?? fallback;
  } catch {
    return fallback;
  }
}

export function write<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ v: SCHEMA_VERSION, data }));
  } catch {
    /* quota / disabled — ignore */
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* */
  }
}
