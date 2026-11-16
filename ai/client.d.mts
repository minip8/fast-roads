// Types for ai/client.mjs (the reference client), for the tests that drive the worker with it.
export declare const MSG: Record<'hello' | 'init' | 'ready' | 'reset' | 'resetOk' | 'step' | 'stepOk' | 'error' | 'close', number>;
export declare const WORKER: string;
export interface StepReply {
  obs: Float32Array; reward: Float32Array; terminated: Uint8Array; truncated: Uint8Array;
  info: Float64Array; done: Uint32Array; finalObs: Float32Array;
}
export declare class EnvWorker {
  constructor(workerPath?: string, opts?: { quiet?: boolean });
  n: number; D: number; F: number;
  hello(): Promise<any>;
  init(numEnvs: number, seed?: number, config?: object): Promise<any>;
  reset(options?: object | (object | null)[]): Promise<{ obs: Float32Array; info: Float64Array }>;
  step(actions: Float32Array): Promise<StepReply>;
  sendFrame(type: number, arg: number, body: Uint8Array): void;
  sendJson(type: number, value: unknown): void;
  expect(type: number): Promise<Uint8Array>;
  close(): Promise<number | null>;
}
