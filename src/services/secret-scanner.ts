import { createHash } from "node:crypto";
import { findSecretValues, redactSecretValues } from "../policies/secret-patterns.js";

export class SecretScanner {
  hasSecretValue(text: string): boolean {
    return findSecretValues(text).length > 0;
  }

  hasNewSecretValue(oldText: string, nextText: string): boolean {
    const oldSecrets = this.countSecretFingerprints(oldText);
    const nextSecrets = this.countSecretFingerprints(nextText);

    for (const [fingerprint, nextCount] of nextSecrets) {
      if (nextCount > (oldSecrets.get(fingerprint) ?? 0)) {
        return true;
      }
    }
    return false;
  }

  redact(text: string): string {
    return redactSecretValues(text);
  }

  private countSecretFingerprints(text: string): Map<string, number> {
    const fingerprints = new Map<string, number>();
    for (const match of findSecretValues(text)) {
      const fingerprint = createHash("sha256").update(match.value).digest("hex");
      fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
    }
    return fingerprints;
  }
}
