/**
 * Bridge client for the packaged desktop app.
 *
 * In the browser preview `window.friday` is absent, so the UI falls back to the
 * mock data in src/lib/friday/mock.ts. In Electron this connects to the local
 * Python kernel over WebSocket using the per-launch token.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type BridgeEvent = { type: string; data: unknown };

declare global {
  interface Window {
    friday?: {
      isDesktop: true;
      getBridgeConfig: () => Promise<{ url: string; token: string }>;
      onKernelLog: (cb: (p: { level: string; text: string }) => void) => () => void;
      onKernelExit: (cb: (p: { code: number }) => void) => () => void;
      pickFolder?: () => Promise<string | null>;
      getWorkspaceRoot?: () => Promise<string | null>;
      setWorkspaceRoot?: (path: string) => Promise<string>;
      // Custom title-strip window controls (native caption is hidden while the
      // OS keeps owning snap, resize and the system menu).
      minimizeWindow?: () => void;
      closeWindow?: () => void;
      toggleMaximizeWindow?: () => void;
      openWindowSystemMenu?: () => void;
      getWindowState?: () => Promise<{
        maximized: boolean;
        minimized: boolean;
        focused: boolean;
        fullScreen: boolean;
      }>;
      onWindowState?: (
        cb: (state: {
          maximized: boolean;
          minimized: boolean;
          focused: boolean;
          fullScreen: boolean;
        }) => void,
      ) => () => void;

      // Durable JSON state (chat history, memory, brain, models, tasks).
      getState?: (namespace: string) => Promise<unknown>;
      setState?: (namespace: string, value: unknown) => Promise<boolean>;

      detectHardware?: () => Promise<unknown>;
      networkStatus?: (force?: boolean) => Promise<{
        online: boolean;
        at: number;
        checkedAt: number;
        detail: string;
      }>;
      onNetworkStatus?: (
        cb: (state: { online: boolean; at: number; checkedAt: number; detail: string }) => void,
      ) => () => void;
      /** FRIDAY's own installed skills — listed and run straight from the brain. */
      listSkills?: () => Promise<{ skills?: unknown[] } | unknown[]>;
      invokeSkill?: (
        id: string,
        input?: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      sendChat?: (request: {
        requestId: string;
        sessionId: string;
        prompt: string;
        modelIds?: string[];
        /** Real routing task (coding, research, vision, …), never "chat". */
        task?: string;
        /** auto | local-only | cloud-only | hybrid | manual | multi */
        routeMode?: string;
        routingSurface?: "voice" | "chat";
        system?: string;
      }) => string;
      abortChat?: (requestId: string) => void;
      /** Deliberate multi-model collaboration — 2-3 real concurrent calls. */
      parallelChat?: (request: {
        requestId?: string;
        sessionId?: string;
        prompt: string;
        modelIds?: string[];
        task?: string;
        system?: string;
        count?: number;
        reason?: string;
        qualityTarget?: string;
        strategy?: string;
      }) => Promise<{
        ok: boolean;
        error?: string;
        reason?: string | null;
        results: {
          modelId: string;
          label: string;
          access: string;
          type?: string | null;
          ok: boolean;
          text: string;
          ms: number;
          error?: string | null;
        }[];
      }>;

      onChatDelta?: (
        cb: (event: { requestId: string; modelId?: string; text: string }) => void,
      ) => () => void;
      onChatTool?: (
        cb: (event: { requestId: string; modelId?: string; name: string }) => void,
      ) => () => void;
      onChatDone?: (
        cb: (event: {
          requestId: string;
          cancelled?: boolean;
          modelId?: string;
          answeredBy?: {
            line: string;
            display?: string;
            badge?: string;
            auto?: boolean;
            modelId?: string;
            providerName?: string;
            chain?: { display: string; reason: string }[];
            parts?: string[];
          };
        }) => void,
      ) => () => void;

      onChatError?: (cb: (event: { requestId: string; error: string }) => void) => () => void;

      // One shared conversation across devices (desktop + paired phone).
      setActiveSession?: (sessionId: string) => Promise<{ sessionId: string | null }>;
      onSessionMessage?: (
        cb: (event: {
          sessionId: string;
          role: "user" | "assistant";
          text: string;
          origin?: string;
          modelId?: string | null;
        }) => void,
      ) => () => void;
      onSessionDelta?: (
        cb: (event: { sessionId?: string; modelId?: string; delta?: string }) => void,
      ) => () => void;
      onCompanionCognize?: (
        cb: (event: { sessionId?: string; prompt?: string }) => void,
      ) => () => void;
      companionCognizeAck?: (sessionId: string) => Promise<{ ok?: boolean }>;
      companionCognizeDone?: (payload: {
        sessionId: string;
        text?: string;
        error?: string;
      }) => Promise<{ ok?: boolean }>;

      // Dynamic model registry + billing policy (main process is authoritative).
      modelRegistry?: (
        force?: boolean,
      ) => Promise<{ at: number; policy: string; models: unknown[] }>;
      modelUsagePolicy?: () => Promise<{ policy: string }>;
      setModelUsagePolicy?: (policy: string) => Promise<{ policy: string }>;
      modelHealthState?: () => Promise<
        { modelId: string; status: string; cooldownUntil: number; coolingDown: boolean }[]
      >;
      onModelRegistryChanged?: (cb: (p: { at: number; provider?: string }) => void) => () => void;
      onModelHealthChanged?: (
        cb: (p: { modelId: string; status: string; cooldownUntil: number }) => void,
      ) => () => void;
      onModelPolicy?: (cb: (p: { policy: string }) => void) => () => void;
    };
  }
}

export const isDesktop = () => typeof window !== "undefined" && Boolean(window.friday?.isDesktop);

export class KernelBridge {
  private socket: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: BridgeEvent) => void>();

  async connect(): Promise<void> {
    if (!window.friday) throw new Error("bridge unavailable outside the desktop app");
    const { url, token } = await window.friday.getBridgeConfig();

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => socket.send(JSON.stringify({ token }));
      socket.onerror = () => reject(new Error("kernel bridge connection failed"));
      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "ready") {
          this.socket = socket;
          resolve();
          return;
        }
        if (typeof msg.id === "number") {
          const pending = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (!pending) return;
          if (msg.type === "error") pending.reject(new Error(msg.error));
          else pending.resolve(msg.data);
          return;
        }
        this.listeners.forEach((fn) => fn(msg as BridgeEvent));
      };
      socket.onclose = () => {
        this.socket = null;
        this.pending.forEach((p) => p.reject(new Error("bridge closed")));
        this.pending.clear();
      };
    });
  }

  on(listener: (e: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket) return Promise.reject(new Error("bridge not connected"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
}
