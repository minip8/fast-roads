// In-memory localStorage for tests (Node's built-in one needs a file and warns without it).
const data = new Map<string, string>();
const memoryStorage: Storage = {
  get length() { return data.size; },
  clear: () => data.clear(),
  getItem: (k) => data.get(k) ?? null,
  key: (i) => [...data.keys()][i] ?? null,
  removeItem: (k) => { data.delete(k); },
  setItem: (k, v) => { data.set(k, String(v)); },
};
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true });
