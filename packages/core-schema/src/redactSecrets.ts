/**
 * Redacts likely secrets out of free-form text extracted from source (signatures, doc
 * summaries) before it's persisted — see the security note in docs/architecture.md. Indexers
 * capture things like default parameter values, decorator arguments, and DI registration call
 * text verbatim; this is a defense-in-depth backstop against a hardcoded credential ending up
 * in the graph database, applied once centrally (in graph-store's ingest) rather than
 * duplicated per-language indexer.
 *
 * Deliberately keyword/pattern-based rather than entropy-based: a purely statistical
 * "high-entropy string" detector would flag ordinary GUIDs and hashes used as legitimate
 * default values, which are common and not secrets.
 */

interface SecretPattern {
  pattern: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // key=value / key: "value" style — redact just the value, keep the key name for context.
  {
    pattern:
      /((?:password|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key|connectionstring)\s*[:=]\s*)(['"]?)([^\s'";,)]{3,})\2/gi,
    replacement: "$1$2[REDACTED]$2",
  },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: "[REDACTED_JWT]" },
  { pattern: /xox[baprs]-[0-9A-Za-z-]+/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function redactSecretsIfPresent<T extends string | null | undefined>(text: T): T {
  return (text == null ? text : redactSecrets(text)) as T;
}
