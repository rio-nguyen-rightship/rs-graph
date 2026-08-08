import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsIfPresent } from "./redactSecrets.js";

describe("redactSecrets", () => {
  it("redacts key=value style secrets while keeping the key name", () => {
    expect(redactSecrets('services.AddDbContext(o => o.UseSqlServer("password=hunter2;Server=x"))')).toContain(
      "password=[REDACTED]",
    );
    expect(redactSecrets("apiKey: 'sk-abc123def456'")).toBe("apiKey: '[REDACTED]'");
  });

  it("redacts AWS access keys, bearer tokens, and JWTs", () => {
    expect(redactSecrets("key = AKIAABCDEFGHIJKLMNOP")).toContain("[REDACTED_AWS_KEY]");
    expect(redactSecrets("Authorization: Bearer abc.def-123_ghi")).toContain("Bearer [REDACTED]");
    expect(
      redactSecrets("token = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    ).toContain("[REDACTED_JWT]");
  });

  it("leaves ordinary signatures and GUIDs untouched", () => {
    const signature = "public User GetUser(int id, Guid correlationId = default)";
    expect(redactSecrets(signature)).toBe(signature);

    const withGuid = 'id: string = "550e8400-e29b-41d4-a716-446655440000"';
    expect(redactSecrets(withGuid)).toBe(withGuid);
  });

  it("passes through null/undefined unchanged", () => {
    expect(redactSecretsIfPresent(null)).toBeNull();
    expect(redactSecretsIfPresent(undefined)).toBeUndefined();
    expect(redactSecretsIfPresent("password=abc123")).toContain("[REDACTED]");
  });
});
