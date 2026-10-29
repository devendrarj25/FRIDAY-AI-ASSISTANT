/**
 * Friday Hub · saved GitHub repo connections (not Settings → Updates).
 *
 * Updates still owns FRIDAY's own `repo` + encrypted token and the update check.
 * Hub stores extra repos in `config/github.json` `connections[]` and never
 * asks whether FRIDAY herself is out of date.
 */

const DESKTOP_ONLY = "This action needs the FRIDAY desktop app.";

export type HubConnection = {
  id: string;
  repo: string;
  label: string;
  role: "self" | "linked";
  hasToken: boolean;
  private: boolean;
  visibility?: "private" | "public" | "unknown";
  defaultBranch: string;
  localPath: string | null;
};

export type HubConnectionList = {
  ok: boolean;
  selectedId?: string;
  connections?: HubConnection[];
  error?: string;
  reused?: boolean;
  checkout?: { ok: boolean; empty?: boolean; dir?: string | null; error?: string };
};

export type HubWorkflow = {
  id: number;
  name: string;
  path: string;
  state: string;
};

export type HubRelease = {
  tag: string;
  name: string;
  notes?: string;
  prerelease?: boolean;
  url?: string;
  at?: number;
};

type HubRepoBridge = {
  githubHubConnections?: () => Promise<HubConnectionList>;
  githubHubAddConnection?: (payload: {
    repo: string;
    token?: string;
    label?: string;
  }) => Promise<HubConnectionList>;
  githubHubRemoveConnection?: (id: string) => Promise<HubConnectionList>;
  githubHubSelectConnection?: (id: string) => Promise<HubConnectionList>;
  githubHubTestConnection?: (id: string) => Promise<{
    ok: boolean;
    repo?: string;
    private?: boolean;
    error?: string;
    warning?: string;
  }>;
  githubHubWorkflows?: () => Promise<{
    ok: boolean;
    repo?: string;
    workflows?: HubWorkflow[];
    error?: string;
  }>;
  githubHubDispatchWorkflow?: (payload: {
    workflow: string | number;
    ref?: string;
    confirm: boolean;
  }) => Promise<{ ok: boolean; dispatched?: boolean; error?: string }>;
  githubHubReleases?: () => Promise<{
    ok: boolean;
    releases?: HubRelease[];
    error?: string;
  }>;
  githubCreateRepo?: (payload: {
    name: string;
    description?: string;
    private?: boolean;
    org?: string;
    confirm: boolean;
  }) => Promise<{
    ok: boolean;
    repo?: string;
    url?: string;
    error?: string;
    connected?: boolean;
    checkout?: { ok: boolean; empty?: boolean; dir?: string | null; error?: string };
  }>;
  githubPackagePush?: (payload: {
    zip?: string;
    folder?: string;
    message?: string;
    confirm: boolean;
  }) => Promise<{
    ok: boolean;
    pushed?: boolean;
    committed?: boolean;
    repo?: string;
    error?: string;
    warning?: string;
  }>;
  pickImportZip?: () => Promise<{ ok: boolean; file?: string; cancelled?: boolean }>;
  pickImportFolder?: () => Promise<{ ok: boolean; folder?: string; cancelled?: boolean }>;
};

const bridge = (): HubRepoBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { friday?: HubRepoBridge }).friday;

export const hubReposAvailable = () => Boolean(bridge()?.githubHubConnections);

export const listHubConnections = async (): Promise<HubConnectionList> =>
  (await bridge()?.githubHubConnections?.()) ?? { ok: false, error: DESKTOP_ONLY };

export const addHubConnection = async (payload: { repo: string; token?: string; label?: string }) =>
  (await bridge()?.githubHubAddConnection?.(payload)) ?? { ok: false, error: DESKTOP_ONLY };

export const removeHubConnection = async (id: string) =>
  (await bridge()?.githubHubRemoveConnection?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

export const selectHubConnection = async (id: string) =>
  (await bridge()?.githubHubSelectConnection?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

export const testHubConnection = async (id: string) =>
  (await bridge()?.githubHubTestConnection?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

export const listHubWorkflows = async () =>
  (await bridge()?.githubHubWorkflows?.()) ?? { ok: false, error: DESKTOP_ONLY };

export const dispatchHubWorkflow = async (workflow: string | number, ref?: string) =>
  (await bridge()?.githubHubDispatchWorkflow?.({
    workflow,
    confirm: true,
    ...(ref ? { ref } : {}),
  })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const listHubReleases = async () =>
  (await bridge()?.githubHubReleases?.()) ?? { ok: false, error: DESKTOP_ONLY };

export const createHubRepository = async (payload: {
  name: string;
  description?: string;
  private?: boolean;
  org?: string;
}) =>
  (await bridge()?.githubCreateRepo?.({ ...payload, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const packagePushHub = async (payload: {
  zip?: string;
  folder?: string;
  message?: string;
}) =>
  (await bridge()?.githubPackagePush?.({ ...payload, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const pickHubZip = async () =>
  (await bridge()?.pickImportZip?.()) ?? { ok: false, cancelled: true };

export const pickHubFolder = async () =>
  (await bridge()?.pickImportFolder?.()) ?? { ok: false, cancelled: true };
