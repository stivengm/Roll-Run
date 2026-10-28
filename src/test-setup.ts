/**
 * Preparación global de las pruebas unitarias (vitest + jsdom).
 *
 * Node 25 trae su propio `localStorage` global: sin `--localstorage-file` no funciona y además
 * tapa el de jsdom. Usamos un almacenamiento en memoria (también para `sessionStorage`).
 */
class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.data.set(String(key), String(value));
  }
}

// Se reemplaza sin leer el global: solo acceder al de Node ya imprime un aviso en cada worker.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
