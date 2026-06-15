// Pure JSON-view helpers for controllers. They convert bigints to strings (Fastify's JSON
// serializer throws on bigint) and build the owner-signed escalation links.

import { bytesToHex } from "@noble/hashes/utils";
import { actionStatus } from "../levi-sdk";
import type { ActionRecord } from "../../store/store.interface";
import type { EngineResult } from "../../engine/engine.service";

const STATUS_LABEL: Record<number, string> = {
  [actionStatus.pending]: "Pending",
  [actionStatus.approved]: "Approved",
  [actionStatus.escalated]: "Escalated",
  [actionStatus.blocked]: "Blocked",
  [actionStatus.rejected]: "Rejected",
};

export const labelStatus = (status: number): string => STATUS_LABEL[status] ?? "Unknown";

export const hex0x = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

/** Owner-signed escalation links — present only while an action is Escalated. */
export function escalationLinks(status: number, actionId: string, baseUrl: string) {
  if (status !== actionStatus.escalated) return null;
  const base = baseUrl.replace(/\/$/, "");
  return {
    approve: `${base}/api/v1/actions/${actionId}/build-approve`,
    reject: `${base}/api/v1/actions/${actionId}/build-reject`,
    review: `${base}/api/v1/actions/${actionId}`,
  };
}

/** JSON view of a stored action record (no bigints). */
export function recordView(rec: ActionRecord, reasoning: string | null, baseUrl: string) {
  return {
    actionId: rec.actionObjectId,
    onchainActionId: rec.onchainActionId,
    agentId: rec.agentId,
    targetProgram: rec.targetProgram,
    value: rec.value,
    status: rec.status,
    decision: rec.decision,
    rawScore: rec.rawScore,
    analyzer: rec.analyzer,
    reasoningHash: rec.reasoningHash,
    verdictDigest: rec.verdictDigest ?? null,
    reasoning,
    escalation: escalationLinks(rec.status, rec.actionObjectId, baseUrl),
  };
}

/** JSON view of an engine verdict returned from a synchronous submit. */
export function verdictView(v: EngineResult, baseUrl: string) {
  return {
    actionId: v.actionObjectId,
    agentId: v.agentId,
    decision: v.decision,
    rawScore: v.rawScore,
    status: v.status,
    analyzer: v.analyzer,
    reasoning: v.reasoning,
    reasoningHash: v.reasoningHash,
    verdictDigest: v.verdictDigest ?? null,
    skipped: v.skipped,
    escalation: escalationLinks(v.status, v.actionObjectId, baseUrl),
  };
}
