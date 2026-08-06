export function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function boundedSingleLine(value: string, max = 300): string {
  const compact = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
