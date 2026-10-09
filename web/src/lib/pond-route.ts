export function resolvePondId(
  pondId: string | string[] | undefined,
): string | null {
  if (!pondId) return null;
  return Array.isArray(pondId) ? pondId[0] ?? null : pondId;
}
