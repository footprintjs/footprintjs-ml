import type { DatasetRef, InferenceIdentity, JsonObject, ModelRef, TrainerAdapterOptions } from '../index.js';

export interface PythonModelRef extends ModelRef { readonly inferenceIdentity: InferenceIdentity }
export interface PythonBackendMetadata {
  readonly sessionId: string;
  readonly profile: string;
  readonly pluginSourceSha256: string;
  readonly preprocessingVersion: string;
  readonly evaluationMethodVersion: string;
  readonly [key: string]: unknown;
}
export interface PythonInitialization {
  readonly backend: PythonBackendMetadata;
  readonly datasets: Readonly<Record<string, DatasetRef>>;
}
export interface PythonInitializeRequest {
  readonly root: string;
  readonly pluginPath: string;
  readonly expectedProfile: string;
  readonly config?: JsonObject;
}
export interface PythonTrainerOptions extends TrainerAdapterOptions {
  readonly python?: string;
  readonly workerPath?: string | URL;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}
export type AdapterKitErrorCode = 'spawn' | 'protocol' | 'worker' | 'timeout' | 'exit' | 'closed' | 'transport';
export class AdapterKitError extends Error {
  readonly code: AdapterKitErrorCode; readonly command?: string; readonly workerType?: string;
  constructor(code: AdapterKitErrorCode, message: string, details: { command?: string; workerType?: string } = {}) {
    super(message); this.name = 'AdapterKitError'; this.code = code; this.command = details.command; this.workerType = details.workerType;
  }
}
