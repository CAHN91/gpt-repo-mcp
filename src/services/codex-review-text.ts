import { SecretScanner } from "./secret-scanner.js";

const scanner = new SecretScanner();

export function redactCodexReviewText(value: string): string {
  return scanner.redact(value.trim());
}
