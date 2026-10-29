/** FRIDAY · shared architecture contracts. */
export interface ModuleContext {
  /** Absolute path of the FRIDAY root folder chosen at install time. */
  root: string;
  /** Structured logger scoped to the module id. */
  log: (level: "info" | "warn" | "error", message: string, meta?: unknown) => void;
  /** Global event bus handle. */
  emit: (event: string, payload?: unknown) => void;
  on: (event: string, handler: (payload?: unknown) => void) => () => void;
}

export interface FridayModule {
  readonly id: string;
  init(ctx: ModuleContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
