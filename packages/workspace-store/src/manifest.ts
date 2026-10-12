import type { CrossRepoIndex, CrossRepoOwner } from "./resolveWorkspace.js";

export interface ManifestCounterpart {
  repo: string;
  symbolId: string;
  role: string;
}

export interface ManifestEntry {
  key: string;
  name: string;
  counterparts: ManifestCounterpart[];
}

export interface RepoManifest {
  repo: string;
  generatedAt: string;
  workspaceConfigPath: string;
  routesDefined: ManifestEntry[];
  routesCalled: ManifestEntry[];
  messagesPublished: ManifestEntry[];
  messagesConsumed: ManifestEntry[];
  signalsPublished: ManifestEntry[];
  signalsConsumed: ManifestEntry[];
}

/** A cross-repo key's own prefix already encodes its kind (see resolveWorkspace.ts's
 * routeSymbolIdToKey/ownerKeyFor) — more robust than reading it off an owner, since a
 * reference-only key (a route consumer whose producer isn't indexed yet) has no owner at all. */
function keyKind(key: string): "Route" | "MessageContract" | "HubEvent" | undefined {
  if (key.startsWith("xrepo:route:")) return "Route";
  if (key.startsWith("xrepo:message:")) return "MessageContract";
  if (key.startsWith("xrepo:signal:")) return "HubEvent";
  return undefined;
}

function displayName(key: string, owners: CrossRepoOwner[]): string {
  return owners[0]?.name ?? key.replace(/^xrepo:(route|message|signal):/, "");
}

function sortEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Projects the already-built cross-repo index down to just one repo's own integration surface —
 * no new indexing, purely a report over data buildCrossRepoIndex already computed. A Route
 * consumer never gets an owned symbol row (only an edge — see resolveWorkspace.ts), so
 * "routesCalled" is keyed off this repo's own INVOKES_ROUTE references where no owner belongs to
 * it; a MessageContract/HubEvent gets a real owned row on *both* sides, so which bucket it lands
 * in (published vs. consumed) is decided by this repo's own PUBLISHES/CONSUMES edge, not by
 * ownership.
 */
export function computeRepoManifest(index: CrossRepoIndex, repoName: string, workspaceConfigPath: string): RepoManifest {
  const routesDefined: ManifestEntry[] = [];
  const routesCalled: ManifestEntry[] = [];
  const messagesPublished: ManifestEntry[] = [];
  const messagesConsumed: ManifestEntry[] = [];
  const signalsPublished: ManifestEntry[] = [];
  const signalsConsumed: ManifestEntry[] = [];

  const keys = new Set<string>([...index.ownersByKey.keys(), ...index.referencesByKey.keys()]);
  for (const key of keys) {
    const kind = keyKind(key);
    if (!kind) continue;

    const owners = index.ownersByKey.get(key) ?? [];
    const references = index.referencesByKey.get(key) ?? [];
    const name = displayName(key, owners);
    const ownedHere = owners.some((o) => o.repo === repoName);
    const ownReferences = references.filter((r) => r.repo === repoName);

    if (kind === "Route") {
      if (ownedHere) {
        const callers = references.filter((r) => r.repo !== repoName);
        routesDefined.push({
          key,
          name,
          counterparts: callers.map((r) => ({ repo: r.repo, symbolId: r.fromSymbolId, role: r.edgeType })),
        });
      } else if (ownReferences.some((r) => r.edgeType === "INVOKES_ROUTE")) {
        routesCalled.push({
          key,
          name,
          counterparts: owners.map((o) => ({ repo: o.repo, symbolId: o.symbolId, role: "producer" })),
        });
      }
      continue;
    }

    const published = ownReferences.some((r) => r.edgeType === "PUBLISHES");
    const consumed = ownReferences.some((r) => r.edgeType === "CONSUMES");
    if (!published && !consumed) continue;

    const otherConsumers = references.filter((r) => r.repo !== repoName && r.edgeType === "CONSUMES");
    const otherPublishers = references.filter((r) => r.repo !== repoName && r.edgeType === "PUBLISHES");
    const pubBucket = kind === "MessageContract" ? messagesPublished : signalsPublished;
    const conBucket = kind === "MessageContract" ? messagesConsumed : signalsConsumed;

    if (published) {
      pubBucket.push({
        key,
        name,
        counterparts: otherConsumers.map((r) => ({ repo: r.repo, symbolId: r.fromSymbolId, role: "consumer" })),
      });
    }
    if (consumed) {
      conBucket.push({
        key,
        name,
        counterparts: otherPublishers.map((r) => ({ repo: r.repo, symbolId: r.fromSymbolId, role: "publisher" })),
      });
    }
  }

  return {
    repo: repoName,
    generatedAt: new Date().toISOString(),
    workspaceConfigPath,
    routesDefined: sortEntries(routesDefined),
    routesCalled: sortEntries(routesCalled),
    messagesPublished: sortEntries(messagesPublished),
    messagesConsumed: sortEntries(messagesConsumed),
    signalsPublished: sortEntries(signalsPublished),
    signalsConsumed: sortEntries(signalsConsumed),
  };
}

function renderSection(heading: string, entries: ManifestEntry[], counterpartLabel: string): string {
  const lines = [`## ${heading}`, ""];
  if (entries.length === 0) {
    lines.push("_(none)_", "");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(`- \`${entry.name}\` (\`${entry.key}\`)`);
    if (entry.counterparts.length === 0) {
      lines.push(`  - ${counterpartLabel}: none known yet`);
    } else {
      for (const c of entry.counterparts) {
        lines.push(`  - ${counterpartLabel}: ${c.repo} (\`${c.symbolId}\`)`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderManifestMarkdown(manifest: RepoManifest): string {
  return [
    `# Cross-repo integration surface: ${manifest.repo}`,
    "",
    `Generated by \`rs-graph generate-manifest ${manifest.workspaceConfigPath}\` at ${manifest.generatedAt}.`,
    "Do not edit by hand — regenerate with the same command.",
    "",
    renderSection("Routes this repo defines", manifest.routesDefined, "called by"),
    renderSection("Routes this repo calls in other repos", manifest.routesCalled, "defined by"),
    renderSection("Messages this repo publishes", manifest.messagesPublished, "consumed by"),
    renderSection("Messages this repo consumes", manifest.messagesConsumed, "published by"),
    renderSection("SignalR events this repo publishes", manifest.signalsPublished, "consumed by"),
    renderSection("SignalR events this repo consumes", manifest.signalsConsumed, "published by"),
  ].join("\n");
}

/** The two files `rs-graph generate-manifest` writes per repo — see docs/mcp-tools.md's
 * "PR-review manifest" section for why this is a committed file, not another `.rs-graph/`
 * cache entry. */
export function buildManifestForRepo(
  index: CrossRepoIndex,
  repoName: string,
  workspaceConfigPath: string,
): { markdown: string; json: RepoManifest } {
  const manifest = computeRepoManifest(index, repoName, workspaceConfigPath);
  return { markdown: renderManifestMarkdown(manifest), json: manifest };
}
