import { createClient, type Store } from "./api";

export function helper(n: number) {
  return n * 2;
}

export function upload(file: string, store?: Store) {
  const client = createClient();
  helper(1);
  store?.save(file); // TODO: real store
  return client.post(file);
}
