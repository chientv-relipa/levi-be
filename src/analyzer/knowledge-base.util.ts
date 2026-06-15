// Curated threat intelligence the analyzer consults: verified target packages, known
// scam/drainer addresses, and prompt-injection / sensitive-intent patterns. Loaded once
// from `data/knowledge-base.json` and compiled into fast lookups.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export interface KnowledgeBaseFile {
  verifiedTargets?: Record<string, string>;
  scamTargets?: Record<string, string>;
  promptInjectionPatterns?: string[];
  sensitiveIntentPatterns?: string[];
}

interface PatternRule {
  /** Human-readable form (the source string) for findings. */
  label: string;
  re: RegExp;
}

export interface KnowledgeBase {
  /** normalized address -> label (e.g. "Sui Framework"). */
  verifiedTargets: Map<string, string>;
  /** normalized address -> reason. */
  scamTargets: Map<string, string>;
  injectionRules: PatternRule[];
  sensitiveRules: PatternRule[];
}

// src/analyzer → ../../data/knowledge-base.json (CommonJS __dirname).
const DEFAULT_PATH = resolve(__dirname, "..", "..", "data", "knowledge-base.json");

/** Normalize a Sui address for comparison (lowercase + zero-padded to 32 bytes). */
export function normalizeAddr(addr: string): string {
  if (!addr) return "";
  try {
    return normalizeSuiAddress(addr.toLowerCase());
  } catch {
    return addr.toLowerCase();
  }
}

function compileRules(patterns: string[] | undefined): PatternRule[] {
  return (patterns ?? []).map((p) => ({ label: p, re: new RegExp(p, "i") }));
}

function normalizeMap(record: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(record ?? {})) {
    map.set(normalizeAddr(k), v);
  }
  return map;
}

/** Compile a parsed knowledge-base file into runtime lookups. */
export function buildKnowledgeBase(file: KnowledgeBaseFile): KnowledgeBase {
  return {
    verifiedTargets: normalizeMap(file.verifiedTargets),
    scamTargets: normalizeMap(file.scamTargets),
    injectionRules: compileRules(file.promptInjectionPatterns),
    sensitiveRules: compileRules(file.sensitiveIntentPatterns),
  };
}

/** Read + compile the knowledge base from disk (defaults to data/knowledge-base.json). */
export function loadKnowledgeBase(path: string = DEFAULT_PATH): KnowledgeBase {
  const file = JSON.parse(readFileSync(path, "utf8")) as KnowledgeBaseFile;
  return buildKnowledgeBase(file);
}

/** Label if the target is a verified package, else null. */
export function isVerifiedTarget(kb: KnowledgeBase, addr: string): string | null {
  return kb.verifiedTargets.get(normalizeAddr(addr)) ?? null;
}

/** Reason if the target is a known scam/drainer address, else null. */
export function scamReason(kb: KnowledgeBase, addr: string): string | null {
  return kb.scamTargets.get(normalizeAddr(addr)) ?? null;
}

/**
 * Normalize text before pattern matching so trivial obfuscation (extra/odd whitespace,
 * casing, zero-width characters) can't slip a known pattern past the deterministic layer.
 * Semantic paraphrase is intentionally out of scope here — that is the LLM analyzer's job.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/[​-‍﻿]/g, "") // zero-width chars
    .replace(/\s+/g, " ") // collapse whitespace runs (incl. newlines/tabs)
    .toLowerCase()
    .trim();
}

/** Prompt-injection pattern labels matched in `text`. */
export function matchInjection(kb: KnowledgeBase, text: string): string[] {
  if (!text) return [];
  const t = normalizeText(text);
  return kb.injectionRules.filter((r) => r.re.test(t)).map((r) => r.label);
}

/** Sensitive / high-risk intent pattern labels matched in `text`. */
export function matchSensitiveIntent(kb: KnowledgeBase, text: string): string[] {
  if (!text) return [];
  const t = normalizeText(text);
  return kb.sensitiveRules.filter((r) => r.re.test(t)).map((r) => r.label);
}
