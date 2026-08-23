import { Injectable } from '@angular/core';

// Stand-in for @microsoft/signalr's HubConnection (plus this org's own thin wrapper convention,
// which calls its underlying connection's .on/.invoke under a differently-named method) — not
// available here, but TsGraphBuilder matches on/subscribe/invoke purely by member name plus a
// resolvable event-name argument, so this exercises the same resolution path as the real
// SDK/wrapper.
export class HubConnection {
  on(eventName: string, callback: (...args: unknown[]) => void): void {}
  subscribe(eventName: string, callback: (...args: unknown[]) => void): void {}
  invoke(methodName: string, ...args: unknown[]): void {}
}

// Real usage (qiportal's SignalFunctions, psc-riskiq-app's PscRiskIqSignalREvents) always names
// an event through an exported constants object like this, never a literal at the call site —
// see TsGraphBuilder.resolveStringValue's one-hop constant resolution.
export const SignalEvents = {
  voyageStatusChanged: 'voyageStatusChanged',
  checklistGenerationCompleted: 'checklistGenerationCompleted',
};

@Injectable({ providedIn: 'root' })
export class SignalClientService {
  private connection = new HubConnection();

  subscribeToVoyageStatusChanged(callback: (data: unknown) => void): void {
    this.connection.on(SignalEvents.voyageStatusChanged, callback);
  }

  subscribeToChecklistGenerationCompleted(callback: (data: unknown) => void): void {
    this.connection.subscribe(SignalEvents.checklistGenerationCompleted, callback);
  }

  invokeOnboardingHub(data: unknown): void {
    this.connection.invoke('InvokeServerFunction', 'OnboardingHub', data);
  }
}
