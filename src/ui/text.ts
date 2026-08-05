export function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
