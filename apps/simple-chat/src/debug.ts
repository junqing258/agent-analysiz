export type DiagnosticLogger = (
  stage: string,
  details?: Record<string, unknown>,
) => void;

export function isDebugEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** Structured, secret-safe diagnostics for local CLI troubleshooting. */
export function createDiagnosticLogger(
  enabled: boolean,
): DiagnosticLogger | undefined {
  if (!enabled) return undefined;
  return (stage, details = {}) =>
    console.error(
      `[simple-chat][${new Date().toISOString()}] ${stage} ${JSON.stringify(details)}`,
    );
}
