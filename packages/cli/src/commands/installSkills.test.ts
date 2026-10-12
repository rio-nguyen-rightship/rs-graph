import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkills, installSkillsWorkspace } from "./installSkills.js";

describe("installSkills", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-install-skills-test-"));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const skillFile = (name: string) => path.join(repo, ".claude", "skills", name, "SKILL.md");

  it("copies every shipped skill into the repo's .claude/skills", () => {
    const result = installSkills(repo);

    expect(result.written).toHaveLength(2);
    expect(fs.readFileSync(skillFile("rs-graph"), "utf8")).toContain("name: rs-graph");
    expect(fs.readFileSync(skillFile("rs-graph-cross-repo-review"), "utf8")).toContain("name: rs-graph-cross-repo-review");
  });

  it("is a no-op the second time", () => {
    installSkills(repo);

    const second = installSkills(repo);

    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(2);
  });

  it("leaves a locally edited skill alone unless forced", () => {
    installSkills(repo);
    fs.writeFileSync(skillFile("rs-graph"), "my own version");

    const kept = installSkills(repo);
    expect(kept.differing).toHaveLength(1);
    expect(fs.readFileSync(skillFile("rs-graph"), "utf8")).toBe("my own version");

    const forced = installSkills(repo, { force: true });
    expect(forced.written).toHaveLength(1);
    expect(fs.readFileSync(skillFile("rs-graph"), "utf8")).toContain("name: rs-graph");
  });

  it("installs into every repo of a workspace and skips none that exist", () => {
    const a = path.join(repo, "a");
    const b = path.join(repo, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const config = path.join(repo, "workspace.json");
    fs.writeFileSync(config, JSON.stringify({ repos: [{ name: "a", path: "./a" }, { name: "b", path: "./b" }] }));

    installSkillsWorkspace(config);

    expect(fs.existsSync(path.join(a, ".claude", "skills", "rs-graph", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(b, ".claude", "skills", "rs-graph-cross-repo-review", "SKILL.md"))).toBe(true);
  });
});
