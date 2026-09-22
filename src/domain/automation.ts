import type { App } from '../ui/App';
import type { CostConfig, EngineBackend, FitApplyExtras, SimConfig } from '../types';

/** Test-build-only bridge. It uses the actual app controllers and worker;
 * neither script evaluation nor a second hidden simulation is exposed. */
export interface WorkerStamp {
  generation: number;
  revision: number;
  frameSequence: number;
}
export interface AutomationFence {
  cmd: 'automationFence';
  requestId: string;
}
export interface AutomationAcknowledgment extends WorkerStamp {
  type: 'automationAck';
  requestId: string;
  tick: number;
  error?: string;
}
export type AutomationCommand =
  | { cmd: 'configure'; config: SimConfig }
  | { cmd: 'step'; ticks: number }
  | { cmd: 'reset' | 'play' | 'pause' | 'probeBackends' }
  | { cmd: 'backend'; backend: EngineBackend }
  | { cmd: 'fit_apply'; config: SimConfig; extras: FitApplyExtras }
  | { cmd: 'cost'; config: CostConfig }
  | { cmd: 'view'; theme?: 'petri' | 'lab'; layout?: 'configure' | 'observe'; chart?: 'compartments' | 'reff' | 'costs'; mode?: 'active' | 'total'; expanded?: boolean; speed?: number };

export interface AppAutomation {
  sync(pause?: boolean): Promise<Record<string, unknown>>;
  command(command: AutomationCommand): Promise<Record<string, unknown>>;
  snapshot(): Record<string, unknown>;
}

declare global {
  interface Window { __MEMELAB_AUTOMATION__?: AppAutomation }
}

export function installAutomation(app: App): void {
  if (import.meta.env.VITE_MEMELAB_AUTOMATION !== '1') return;
  Object.defineProperty(window, '__MEMELAB_AUTOMATION__', {
    configurable: false,
    value: Object.freeze({
      sync: (pause = true) => app.automationSync(pause),
      command: (command: AutomationCommand) => app.automationCommand(command),
      snapshot: () => app.automationSnapshot(),
    } satisfies AppAutomation),
  });
}
