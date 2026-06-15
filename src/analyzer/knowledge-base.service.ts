import { Injectable } from "@nestjs/common";
import { loadKnowledgeBase, type KnowledgeBase } from "./knowledge-base.util";

// Loads + compiles the knowledge base once at construction; the engine pulls it into each
// AnalysisInput.
@Injectable()
export class KnowledgeBaseService {
  private readonly kb: KnowledgeBase = loadKnowledgeBase();

  get(): KnowledgeBase {
    return this.kb;
  }
}
