export interface SymbolSummary {
  id: string;
  name: string;
  kind: string;
  signature: string;
  docSummary: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  startCol: number | null;
  endCol: number | null;
  modifiers: string[];
  external: boolean;
}

export interface SymbolWithDepth extends SymbolSummary {
  depth: number;
}

export interface ReferenceHit {
  symbol: SymbolSummary;
  /** One entry per call/reference site — a symbol calling the target from N places gets one
   * ReferenceHit with N occurrences, not N duplicate hits each repeating the full symbol. */
  occurrences: Array<{ line: number | null; col: number | null }>;
}

export interface GraphStats {
  totalFiles: number;
  totalSymbols: number;
  byKind: Record<string, number>;
  byLanguage: Record<string, number>;
}

export interface ClassHierarchy {
  ancestors: SymbolWithDepth[];
  descendants: SymbolWithDepth[];
}

export interface FileDependencies {
  imports: string[];
  importedBy: string[];
}

export interface RouteMapping {
  route: SymbolSummary;
  handler: SymbolSummary | null;
}

export interface DiRegistration {
  registration: SymbolSummary;
  target: SymbolSummary | null;
}

export interface ComponentBinding {
  component: {
    id: string;
    name: string;
    selector: string | null;
    framework: string;
    templatePath: string | null;
  };
  boundSymbols: SymbolSummary[];
  /** True when this component binds to more symbols than maxBoundSymbols — a template-heavy
   * component (a big form, in practice) can bind to far more members than a typical one, so
   * capping only the outer component list doesn't bound a single row's own size. */
  boundSymbolsTruncated: boolean;
}

export interface ContextPack {
  symbols: SymbolSummary[];
  edges: Array<{ from: string; to: string; edgeType: string }>;
  truncated: boolean;
}

export interface ImpactAnalysisResult {
  symbols: SymbolWithDepth[];
  truncated: boolean;
}
