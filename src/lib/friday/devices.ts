/**
 * FRIDAY · devices
 *
 * Real device control over the existing kernel bridge: Android phones on a
 * cable (ADB), Bluetooth devices Windows has paired, and devices that
 * advertise themselves on this WiFi network — plus the local-network phone
 * companion.
 *
 * Rules this store enforces on the UI side:
 *  - Nothing is simulated. Outside the desktop app every call reports
 *    "desktop only" instead of inventing devices.
 *  - FRIDAY never asks for, stores or replays another device's unlock code.
 *    Access comes from the platform's own trust (ADB authorization, Windows
 *    pairing, one-time companion pairing code).
 *  - Every action that touches another device runs as an approved kernel tool
 *    call, so the permission gate in kernel/tools.py still applies.
 */
import { isDesktop } from "./bridge";

export type AndroidDevice = {
  serial: string;
  state: string;
  model: string;
  authorized: boolean;
  hint: string;
};

export type BluetoothDevice = {
  address: string;
  name: string;
  connected: boolean;
  kind: string;
};

export type NetworkDevice = {
  name: string;
  address: string;
  kind: string;
  controlUrl?: string;
};

export type CompanionStatus = {
  enabled: boolean;
  url: string | null;
  ip: string | null;
  port: number | null;
  phones: { id: string; name: string; pairedAt: number; lastSeen: number }[];
};

export type DevicesState = {
  supported: boolean;
  busy: boolean;
  error: string | null;
  android: AndroidDevice[];
  androidNote: string | null;
  bluetooth: BluetoothDevice[];
  bluetoothNote: string | null;
  network: NetworkDevice[];
  networkNote: string | null;
  companion: CompanionStatus | null;
  pairing: { code: string; expiresAt: number } | null;
};

const EMPTY: DevicesState = {
  supported: false,
  busy: false,
  error: null,
  android: [],
  androidNote: null,
  bluetooth: [],
  bluetoothNote: null,
  network: [],
  networkNote: null,
  companion: null,
  pairing: null,
};

type Kernel = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const kernel = (): Kernel | null => {
  const bridge = (window as unknown as { friday?: { kernel?: Kernel } }).friday;
  return bridge?.kernel ?? null;
};

/**
 * Run a kernel tool. The renderer never claims approval for itself: the
 * desktop permission gate decides and mints the signed authorization.
 */
async function runTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const call = kernel();
  if (!call) throw new Error("Device control is only available in the FRIDAY desktop app.");
  const result = (await call("tool.exec", { name, args })) as T & {
    ok?: boolean;
    error?: string;
  };
  if (result && result.ok === false) throw new Error(result.error || `${name} failed`);
  return result;
}

class DevicesStore {
  private state: DevicesState = { ...EMPTY, supported: isDesktop() };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): DevicesState => this.state;

  private set(patch: Partial<DevicesState>) {
    this.state = { ...this.state, ...patch, supported: isDesktop() };
    this.listeners.forEach((fn) => fn());
  }

  /** One refresh for every transport. Each part fails independently. */
  async refresh(): Promise<void> {
    if (!isDesktop()) {
      this.set({ supported: false, error: null });
      return;
    }
    this.set({ busy: true, error: null });
    await Promise.all([this.refreshAndroid(), this.refreshBluetooth(), this.refreshCompanion()]);
    this.set({ busy: false });
  }

  async refreshAndroid(): Promise<void> {
    try {
      const res = await runTool<{ devices: AndroidDevice[] }>("android.list");
      this.set({ android: res.devices || [], androidNote: null });
    } catch (error) {
      this.set({ android: [], androidNote: (error as Error).message });
    }
  }

  async refreshBluetooth(): Promise<void> {
    try {
      const res = await runTool<{ devices: BluetoothDevice[] }>("bluetooth.list");
      this.set({ bluetooth: res.devices || [], bluetoothNote: null });
    } catch (error) {
      this.set({ bluetooth: [], bluetoothNote: (error as Error).message });
    }
  }

  /** WiFi discovery is explicit — it takes seconds and touches the network. */
  async discoverNetwork(): Promise<void> {
    this.set({ busy: true });
    try {
      const res = await runTool<{
        mdns: NetworkDevice[];
        dlna: NetworkDevice[];
        mdnsError?: string;
        dlnaError?: string;
      }>("network.discover", { kind: "all" });
      this.set({
        network: [...(res.mdns || []), ...(res.dlna || [])],
        networkNote: res.mdnsError || res.dlnaError || null,
      });
    } catch (error) {
      this.set({ network: [], networkNote: (error as Error).message });
    } finally {
      this.set({ busy: false });
    }
  }

  async scanBluetooth(): Promise<void> {
    this.set({ busy: true });
    try {
      const res = await runTool<{ devices: BluetoothDevice[] }>("bluetooth.scan", { seconds: 6 });
      const seen = new Set(this.state.bluetooth.map((d) => d.address));
      const extra = (res.devices || []).filter((d) => !seen.has(d.address));
      this.set({ bluetooth: [...this.state.bluetooth, ...extra], bluetoothNote: null });
    } catch (error) {
      this.set({ bluetoothNote: (error as Error).message });
    } finally {
      this.set({ busy: false });
    }
  }

  async openApp(app: string, serial?: string) {
    return runTool("android.open_app", { app, serial });
  }

  async mirror(serial?: string) {
    return runTool("android.mirror", { serial });
  }

  async media(command: string) {
    return runTool("bluetooth.media", { command });
  }

  async cast(controlUrl: string, mediaUrl: string) {
    return runTool("network.cast", { controlUrl, mediaUrl });
  }

  // ------------------------------------------------------------- companion
  async refreshCompanion(): Promise<void> {
    const call = kernel();
    if (!call) return;
    try {
      const status = (await call("companion.status")) as CompanionStatus;
      this.set({ companion: status });
    } catch (error) {
      this.set({ error: (error as Error).message });
    }
  }

  async pair(): Promise<void> {
    const call = kernel();
    if (!call) return;
    const pairing = (await call("companion.pair")) as { code: string; expiresAt: number };
    this.set({ pairing });
  }

  async revoke(id: string): Promise<void> {
    const call = kernel();
    if (!call) return;
    await call("companion.revoke", { id });
    await this.refreshCompanion();
  }
}

export const devices = new DevicesStore();
