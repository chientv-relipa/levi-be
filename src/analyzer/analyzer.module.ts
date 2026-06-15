import { Module } from "@nestjs/common";
import { AnalyzerService } from "./analyzer.service";
import { KnowledgeBaseService } from "./knowledge-base.service";

@Module({
  providers: [AnalyzerService, KnowledgeBaseService],
  exports: [AnalyzerService, KnowledgeBaseService],
})
export class AnalyzerModule {}
