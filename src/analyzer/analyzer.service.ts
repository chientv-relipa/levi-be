import { Inject, Injectable, Logger } from "@nestjs/common";

import { RELAYER_CONFIG, type RelayerConfig } from "../config/relayer-config";
import type { Analyzer, AnalysisInput, AnalysisResult } from "./analyzer.types";
import { RuleBasedAnalyzer } from "./rule-based.analyzer";
import { ClaudeAnalyzer } from "./claude.analyzer";
import { CompositeAnalyzer } from "./composite.analyzer";

// Factory + facade: Claude Opus 4.8 (wrapped in the deterministic hard-deny floor) when an
// API key is configured, otherwise the offline rule-based analyzer. The engine depends only
// on the `Analyzer` interface this service implements.
@Injectable()
export class AnalyzerService implements Analyzer {
  private readonly delegate: Analyzer;
  readonly name: string;

  constructor(@Inject(RELAYER_CONFIG) cfg: RelayerConfig) {
    this.delegate = cfg.anthropicApiKey
      ? new CompositeAnalyzer(new ClaudeAnalyzer(cfg.anthropicApiKey))
      : new RuleBasedAnalyzer();
    this.name = this.delegate.name;
    new Logger("Analyzer").log(
      `using ${cfg.anthropicApiKey ? "Claude Opus 4.8 (+deny floor)" : "rule-based (offline)"}`
    );
  }

  analyze(input: AnalysisInput): Promise<AnalysisResult> {
    return this.delegate.analyze(input);
  }
}
