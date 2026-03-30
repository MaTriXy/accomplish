export interface ReplayContext {
  runId: string;
  cancelled: boolean;
  paused: boolean;
  stepMode: boolean;
  stepBudget: number;
  resumePromise: Promise<void> | null;
  resolveResume: (() => void) | null;
}

export interface Point {
  x: number;
  y: number;
}
