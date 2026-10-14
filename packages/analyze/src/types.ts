import type { Discovery, Refutation, Verification } from "./schemas.ts";

export type Feature = Discovery["features"][number] & {
  /** Files that also appear in other features (shared code). */
  sharedWith?: string[];
};

/** The feature map. Proposed by Claude, edited and approved by the user, then frozen. */
export interface FeatureMap {
  version: 1;
  state: "proposed" | "approved";
  commit: string | null;
  proposedAt: string;
  approvedAt?: string;
  model: string;
  provider: string;
  features: Feature[];
  unassigned: Discovery["unassigned"];
  /** Things the mechanical check fixed or dropped from Claude's answer. */
  notes: string[];
}

export type CheckResult = { ok: boolean; reason?: string };

export type CheckedEvidence = Verification["claims"][number]["evidence"][number] & { check: CheckResult };

export interface FeatureAnalysis {
  version: 1;
  featureId: string;
  generatedAt: string;
  model: string;
  provider: string;
  /** Hash of the feature's file hashes; when it changes, the analysis is stale. */
  filesHash: string;
  summary: string;
  analogy: string;
  status: Verification["status"];
  statusReason: string;
  flow: (Verification["flow"][number] & { check: CheckResult })[];
  claims: (Omit<Verification["claims"][number], "evidence"> & {
    evidence: CheckedEvidence[];
    /** The label Claude gave before the citation check, when the check changed it. */
    claimedLabel?: Verification["claims"][number]["label"];
    checkNote?: string;
    /** The second reader's verdict, for claims that reached it (confirmed and record). */
    review?: Omit<Refutation["verdicts"][number], "id">;
  })[];
  issues: (Omit<Verification["issues"][number], "evidence"> & { evidence: CheckedEvidence[] })[];
}

export type AnalysisClaim = FeatureAnalysis["claims"][number];
