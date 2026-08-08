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
  line: number | null;
  col: number | null;
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
