import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProjects } from "./detect.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-detect-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe("detectProjects", () => {
  it("detects a .NET/ASP.NET Core project via .csproj contents", () => {
    write(
      "src/Api.csproj",
      `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
    );
    const detection = detectProjects(tmpDir);
    expect(detection.languages.has("csharp")).toBe(true);
    expect(detection.frameworks.has("aspnetcore")).toBe(true);
  });

  it("finds the .slnx solution file (not just legacy .sln) so multi-project solutions get indexed as a whole", () => {
    write("src/Api.csproj", `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`);
    write("src/Domain.csproj", `<Project Sdk="Microsoft.NET.Sdk"></Project>`);
    write("Sample.slnx", `<Solution><Project Path="src/Api.csproj" /><Project Path="src/Domain.csproj" /></Solution>`);
    const detection = detectProjects(tmpDir);
    expect(detection.markers.slnFiles).toHaveLength(1);
    expect(detection.markers.slnFiles[0]).toMatch(/Sample\.slnx$/);
  });

  it("detects an Angular project via package.json dependencies", () => {
    write(
      "package.json",
      JSON.stringify({ name: "app", dependencies: { "@angular/core": "^17.0.0" } }),
    );
    const detection = detectProjects(tmpDir);
    expect(detection.languages.has("typescript")).toBe(true);
    expect(detection.frameworks.has("angular")).toBe(true);
  });

  it("detects an Aurelia project via package.json dependencies", () => {
    write(
      "package.json",
      JSON.stringify({ name: "app", dependencies: { "aurelia-framework": "^1.4.1" } }),
    );
    const detection = detectProjects(tmpDir);
    expect(detection.languages.has("typescript")).toBe(true);
    expect(detection.frameworks.has("aurelia")).toBe(true);
  });

  it("detects a Python/Flask project via requirements.txt contents", () => {
    write("requirements.txt", "Flask==3.0.0\nrequests==2.31.0\n");
    const detection = detectProjects(tmpDir);
    expect(detection.languages.has("python")).toBe(true);
    expect(detection.frameworks.has("flask")).toBe(true);
  });

  it("ignores node_modules/bin/obj when walking", () => {
    write("node_modules/some-dep/package.json", JSON.stringify({ dependencies: { "@angular/core": "1.0.0" } }));
    write("bin/Debug/Api.csproj", `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`);
    const detection = detectProjects(tmpDir);
    expect(detection.languages.size).toBe(0);
  });

  it("returns no languages for an empty directory", () => {
    const detection = detectProjects(tmpDir);
    expect(detection.languages.size).toBe(0);
    expect(detection.frameworks.size).toBe(0);
  });
});
