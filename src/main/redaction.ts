export function redactSensitiveText(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^@\s/:]+):([^@\s]+)@/gi, '$1***:***@')
    .replace(/(proxy-authorization\s*:\s*)(basic|bearer)\s+\S+/gi, '$1$2 [REDACTED]')
    .replace(/([?&](?:password|passwd|secret|token)=)[^&\s]+/gi, '$1[REDACTED]')
}

export function safeErrorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
}
