import type { ModelRef, EvaluationReceipt, ReleaseDecision, ModelReleaseDecision, ArtifactRef,
  DataLineageReceipt, DataLineageDecision, DataLineagePreprocessing } from 'footprintjs-ml';

/** Explicit top-level scope-property names; no workflow-specific names are assumed. */
export interface MLInvestigationBindings {
  readonly model: string;
  readonly receipt: string;
  readonly decision: string;
  readonly allowed: string;
  readonly releasedModel: string;
}
/** Optional captured-data bindings. All nine configured scope keys must differ. */
export interface MLDataLineageBindings {
  readonly receipt: string;
  readonly decision: string;
  readonly preprocessing: string;
  readonly manifest: string;
}
/** Optional selection evidence; these keys must differ from all other bindings. */
export interface MLSelectionBindings {
  readonly manifest: string;
  readonly results: string;
  readonly receipt: string;
  readonly decision: string;
  readonly candidate: string;
}
/** Optional artifact-publication evidence. All configured scope keys must differ. */
export interface MLPublicationBindings {
  readonly pin: string;
  readonly plan: string;
  readonly preparation: string;
  readonly publication: string;
  readonly attempt: string;
}
export interface MLInvestigationDescriptor {
  readonly schemaVersion: 1;
  readonly bindings: MLInvestigationBindings;
  readonly dataLineage?: MLDataLineageBindings;
  readonly selection?: MLSelectionBindings;
  readonly publication?: MLPublicationBindings;
}
/** Minimal native saved-commit shape; other FootPrint fields are preserved. */
export interface SavedWorkflowCommit {
  readonly idx?: number;
  readonly stage?: string;
  readonly stageId?: string;
  readonly runtimeStageId?: string;
  readonly overwrite?: Readonly<Record<string, unknown>>;
}
export interface SavedWorkflowSnapshot {
  readonly commitLog: readonly SavedWorkflowCommit[];
  readonly executionTree: unknown;
  readonly sharedState?: Readonly<Record<string, unknown>>;
}
/** Any saved FootPrint snapshot, or its existing recording wrapper. No release bindings are required.
 * When both aliases are supplied they must contain equivalent retained data; conflicting aliases are rejected. */
export type WorkflowRecordingInput<S extends SavedWorkflowSnapshot = SavedWorkflowSnapshot> = S |
  ({ readonly snapshot: S; readonly footprint?: S } | { readonly footprint: S; readonly snapshot?: S }) & {
    readonly events?: readonly unknown[];
    readonly structure?: unknown;
  };
export interface SavedWorkflowRecording<S extends SavedWorkflowSnapshot = SavedWorkflowSnapshot> {
  readonly snapshot: S;
  readonly events?: readonly unknown[];
  readonly structure?: unknown;
}
export interface SavedRecordingToolpackOptions {
  readonly previewChars?: number;
  readonly valueMaxChars?: number;
  readonly sliceMaxDepth?: number;
  readonly sliceMaxNodes?: number;
}
/** Only the public offline toolpack is needed; callers own optional dependency loading. */
export interface SavedRecordingBridge<A = unknown, T = unknown> {
  openRecording(recording: SavedWorkflowRecording): A;
  traceToolpack(artifacts: A, options?: SavedRecordingToolpackOptions): T;
  callTraceTool(tools: T, name: string, args?: Readonly<Record<string, unknown>>): string | Promise<string>;
}
/** The native backtrack tool's exclusive commit bound and resource limits. */
export interface BacktrackRecordedVariableOptions {
  readonly before?: number;
  readonly element?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}
export interface WorkflowRecordingOptions {
  readonly toolpack?: SavedRecordingToolpackOptions;
}
export interface WorkflowRecordingSession<S extends SavedWorkflowSnapshot = SavedWorkflowSnapshot, A = unknown, T = unknown> {
  readonly recording: SavedWorkflowRecording<S>;
  readonly snapshot: S;
  readonly artifacts: A;
  readonly tools: T;
  readonly transcript: readonly NativeLensTranscriptEntry[];
  /** Native argument corrections, warnings and evidence text are returned verbatim. */
  call(tool: string, args?: Readonly<Record<string, unknown>>): Promise<NativeLensTranscriptEntry>;
  backtrack(variable: string, options?: BacktrackRecordedVariableOptions): Promise<NativeLensTranscriptEntry>;
}
export type AdapterWorkflowRunInput<S extends SavedWorkflowSnapshot = SavedWorkflowSnapshot> =
  ({ readonly footprint: S; readonly snapshot?: S } | { readonly snapshot: S; readonly footprint?: S }) & {
    readonly workflow?: { readonly kind: string };
    readonly mlInvestigation: MLInvestigationDescriptor;
    readonly rows?: readonly unknown[];
    readonly supplemental?: { readonly footprintCallbacks?: readonly unknown[] };
  };
export interface AdapterWorkflowRecording<S extends SavedWorkflowSnapshot = SavedWorkflowSnapshot> {
  readonly snapshot: S;
  readonly workflow: { readonly kind: 'ml-adapter-workflow/v1' };
  readonly mlInvestigation: MLInvestigationDescriptor;
  readonly supplemental: { readonly footprintCallbacks: readonly unknown[] };
}
export interface SavedFoldedState {
  readonly state: Readonly<Record<string, unknown>>;
  readonly basis?: string;
  readonly skipped?: readonly unknown[];
}
export interface SavedCursorStop {
  readonly step: number;
  readonly runtimeStageId?: string;
  readonly label?: string;
  readonly commitIdx?: number;
}
export interface SavedWorkflowCursor {
  readonly stops: readonly SavedCursorStop[];
  jumpTo(target: number | string): { readonly moved: boolean; readonly reason?: string };
  at(): SavedCursorStop | undefined;
  stateAt(): SavedFoldedState;
  changedSince(): readonly string[];
}
/**
 * Public APIs supplied by the host's existing Lens/foottrace installation.
 * Source/log parameters are opaque native shapes, intentionally without a
 * dependency on a particular FootPrint package version. A/T preserve the
 * actual artifact/tool types inferred from the injected implementation.
 */
export interface SavedRunLensBridge<A = unknown, T = unknown> {
  openRecording(recording: AdapterWorkflowRecording): A;
  traceToolpack(artifacts: A, options?: { readonly previewChars?: number; readonly valueMaxChars?: number }): T;
  callTraceTool(tools: T, name: string, args?: Readonly<Record<string, unknown>>): string | Promise<string>;
  stateAt(snapshot: any, commitIdx: number): SavedFoldedState;
  findLastWriter(commitLog: readonly any[], key: string, beforeExclusive?: number): SavedWorkflowCommit | undefined;
  timeTravel(snapshot: any): SavedWorkflowCursor;
}
/** Captured values are projections, not an additional core-contract validation. */
export type CapturedModelRef = Partial<ModelRef>;
export type CapturedEvaluationReceipt = Partial<EvaluationReceipt>;
export type CapturedReleaseDecision = (Partial<ReleaseDecision> & Pick<ReleaseDecision, 'kind' | 'allowed'>) |
  (Partial<ModelReleaseDecision> & Pick<ModelReleaseDecision, 'kind' | 'allowed'>);
export interface AdapterDecisionChoice {
  readonly runtimeStageId: string;
  readonly stageName: string;
  readonly commitIdx: number;
  readonly allowed: boolean;
  readonly status?: ReleaseDecision['status'];
}
export interface ProjectedWorkflowState {
  readonly model?: CapturedModelRef | null;
  readonly receipt?: CapturedEvaluationReceipt | null;
  readonly decision?: CapturedReleaseDecision | null;
  readonly allowed?: unknown;
  readonly releasedModel?: CapturedModelRef | null;
  /** Absent when the required artifact references were not captured. */
  readonly checkpointMatches?: boolean;
  /** Absent for v1 receipts or missing measured identities. */
  readonly inferenceMatches?: boolean;
  readonly dataLineage?: CapturedDataLineageState;
  readonly selection?: CapturedSelectionState;
  readonly publication?: CapturedPublicationState;
}
export interface CapturedPublicationState {
  readonly pin?: unknown;
  readonly plan?: unknown;
  readonly preparation?: unknown;
  readonly publication?: unknown;
  readonly attempt?: unknown;
}
export interface CapturedPublicationSummary extends CapturedPublicationState {
  readonly writerStageIds: Readonly<Partial<Record<keyof MLPublicationBindings, string>>>;
}
/** Raw captured selection values. Reading them does not rerun the selection guard. */
export interface CapturedSelectionState {
  readonly manifest?: unknown;
  readonly results?: unknown;
  readonly receipt?: unknown;
  readonly decision?: unknown;
  readonly candidate?: unknown;
}
export interface CapturedSelectionSummary extends CapturedSelectionState {
  readonly writerStageIds: Readonly<Partial<Record<keyof MLSelectionBindings, string>>>;
}
/** Raw recorded values; this reader does not validate or recompute lineage. */
export interface CapturedDataLineageState {
  readonly receipt?: Partial<DataLineageReceipt> | null;
  readonly decision?: Partial<DataLineageDecision> | null;
  readonly preprocessing?: (Partial<DataLineagePreprocessing> & { readonly observation?: unknown }) | null;
  readonly manifest?: Partial<ArtifactRef> | null;
}
export interface CapturedDataLineageSummary extends CapturedDataLineageState {
  readonly receiptWriterStageId?: string;
  readonly decisionWriterStageId?: string;
  readonly preprocessingWriterStageId?: string;
  /** Earliest captured non-null write through the selected decision. */
  readonly firstCapturedPreprocessingFitWriterStageId?: string;
  readonly manifestWriterStageId?: string;
}
export interface AdapterWorkflowSummary {
  readonly isAdapterWorkflow: true;
  readonly selectedDecisionStageId: string;
  readonly selectedDecisionStageName: string;
  readonly selectedCommitIdx: number;
  readonly activeModel?: CapturedModelRef | null;
  readonly validatedModel?: CapturedModelRef | null;
  readonly evaluationReceipt?: CapturedEvaluationReceipt | null;
  readonly releaseDecision: CapturedReleaseDecision;
  readonly releaseAllowed?: unknown;
  /** Final run value, separate from the selected earlier decision. */
  readonly releasedModel?: CapturedModelRef | null;
  readonly checkpointMatches?: boolean;
  readonly inferenceMatches?: boolean;
  readonly modelWriterStageId?: string;
  readonly receiptWriterStageId?: string;
  readonly finalReleaseWriterStageId?: string;
  readonly dataLineage?: CapturedDataLineageSummary;
  readonly selection?: CapturedSelectionSummary;
  readonly publication?: CapturedPublicationSummary;
}
export interface AdapterWorkflowAnchors {
  readonly decision: string;
  readonly guard: string;
  readonly identityCheck: string;
  readonly recovery?: string;
  readonly validation?: string;
  readonly receipt?: string;
  readonly release?: string;
  readonly dataLineage?: string;
  readonly lineageDecision?: string;
  readonly preprocessing?: string;
  readonly firstPreprocessingFit?: string;
  readonly splitManifest?: string;
  readonly selectionManifest?: string;
  readonly selectionResults?: string;
  readonly selectionReceipt?: string;
  readonly selectionDecision?: string;
  readonly selectedCandidate?: string;
  readonly releasePin?: string;
  readonly releasePlan?: string;
  readonly releasePreparation?: string;
  readonly publication?: string;
  readonly publicationAttempt?: string;
}
export interface NativeLensTranscriptEntry {
  readonly ordinal: number;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly owner: 'agentfootprint/observe: existing Lens toolpack';
}
export interface SupplementalWorkflowEvidence {
  readonly kind: 'Decision callback' | 'Retry callback' | 'Backend callback';
  readonly pointer: string;
  readonly pointerSource: 'Input recording passed to openAdapterWorkflowRun';
  readonly event: unknown;
}
export interface AdapterWorkflowRunOptions {
  /** A real runtimeStageId that committed a write to the configured decision key. */
  readonly decisionStageId?: string;
}
export interface AdapterWorkflowSession<S extends SavedWorkflowSnapshot = SavedWorkflowSnapshot, A = unknown, T = unknown> {
  readonly recording: AdapterWorkflowRecording<S>;
  readonly snapshot: S;
  readonly callbacks: readonly unknown[];
  readonly artifacts: A;
  readonly tools: T;
  readonly cursor: SavedWorkflowCursor;
  readonly anchors: AdapterWorkflowAnchors;
  readonly final: SavedFoldedState;
  readonly selected: SavedFoldedState;
  readonly bindings: MLInvestigationBindings;
  readonly dataLineageBindings?: MLDataLineageBindings;
  readonly selectionBindings?: MLSelectionBindings;
  readonly publicationBindings?: MLPublicationBindings;
  readonly selectedDecisionStageId: string;
  readonly decisionChoices: readonly AdapterDecisionChoice[];
  readonly summary: AdapterWorkflowSummary;
  readonly transcript: readonly NativeLensTranscriptEntry[];
  readonly supplemental: readonly SupplementalWorkflowEvidence[];
  readonly boundaries: readonly string[];
  projectState(state: Readonly<Record<string, unknown>>): ProjectedWorkflowState;
  call(tool: string, args?: Readonly<Record<string, unknown>>): Promise<NativeLensTranscriptEntry>;
  investigate(question?: 'release' | 'writer' | 'gate' | 'lineage' | 'selection' | 'publication'): Promise<readonly NativeLensTranscriptEntry[]>;
  stop(target: number | string): { readonly stop: SavedCursorStop; readonly folded: SavedFoldedState; readonly changedKeys: readonly string[] };
}

/** Reopens recorded JSON only. Bridge/tool results are returned verbatim. */
export function openWorkflowRecording<S extends SavedWorkflowSnapshot, A = unknown, T = unknown>(
  input: WorkflowRecordingInput<S>, bridge: SavedRecordingBridge<A, T>, options?: WorkflowRecordingOptions,
): WorkflowRecordingSession<S, A, T>;

/** Optional release-specific projection over the same native saved-run tools. */
export function openAdapterWorkflowRun<S extends SavedWorkflowSnapshot, A = unknown, T = unknown>(
  input: AdapterWorkflowRunInput<S>, bridge: SavedRunLensBridge<A, T>, options?: AdapterWorkflowRunOptions,
): AdapterWorkflowSession<S, A, T>;
