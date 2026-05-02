export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function clampText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}
