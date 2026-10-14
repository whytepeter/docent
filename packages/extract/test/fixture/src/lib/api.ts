export interface Store {
  save(value: string): void;
}

export function createClient() {
  function post(path: string) {
    return path.toUpperCase();
  }
  return { post };
}
