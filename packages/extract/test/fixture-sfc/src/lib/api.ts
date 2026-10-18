export async function saveUser(name: string): Promise<void> {
  await fetch("/api/users", { method: "POST", body: name });
}

export function formatName(name: string): string {
  return name.trim();
}
