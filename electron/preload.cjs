// Minimal, explicit bridge surface exposed to the renderer.
// The renderer can never run arbitrary system commands — only these calls.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

let chatSequence = 0;

/** Store identity of the selected FRIDAY folder; null before one is chosen. */
function storageIdentity() {
  try {
    return ipcRenderer.sendSync("state:identity") || null;
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld("friday", {
  isDesktop: true,
  version: () => ipcRenderer.invoke("app:version"),
  paths: () => ipcRenderer.invoke("app:paths"),
  getBridgeConfig: () => ipcRenderer.invoke("bridge:config"),

  // Chat is brokered by the main process. The renderer only submits/cancels
  // requests and receives compact stream events; it never runs model work.
  sendChat: (request) => {
    const requestId = request?.requestId || `chat-${Date.now()}-${++chatSequence}`;
    ipcRenderer.send("chat:send", { ...request, requestId });
    return requestId;
  },
  abortChat: (requestId) => ipcRenderer.send("chat:abort", requestId),
  // Deliberate multi-model collaboration (hard task or owner-requested second
  // opinion). Returns every candidate's real answer for the Brain to reconcile.
  parallelChat: (request) => ipcRenderer.invoke("chat:parallel", request),
  onParallelChat: on("chat:parallel-done"),

  onChatDelta: on("chat:delta"),
  onChatTool: on("chat:tool"),
  onChatDone: on("chat:done"),
  onChatError: on("chat:error"),

  // One shared conversation across devices: turns that arrive from the paired
  // phone are mirrored here so the desktop chat stays in sync live.
  setActiveSession: (sessionId) => ipcRenderer.invoke("session:set-active", sessionId),
  onSessionMessage: on("session:message"),
  onSessionDelta: on("session:delta"),
  onCompanionCognize: on("companion:cognize"),
  companionCognizeAck: (sessionId) => ipcRenderer.invoke("companion:cognize-ack", sessionId),
  companionCognizeDone: (payload) => ipcRenderer.invoke("companion:cognize-done", payload),

  // Boot sequence.
  getBootSteps: () => ipcRenderer.invoke("boot:steps"),
  onBootStep: on("boot:step"),

  // Startup orchestration (scan → services → verify → readiness).
  getStartupState: () => ipcRenderer.invoke("startup:state"),
  runStartup: () => ipcRenderer.invoke("startup:run"),
  onStartupState: on("startup:state"),

  // Primary folder: native picker + persisted setting.
  pickFolder: () => ipcRenderer.invoke("workspace:pick"),
  getWorkspaceRoot: () => ipcRenderer.invoke("workspace:get"),
  setWorkspaceRoot: (path) => ipcRenderer.invoke("workspace:set", path),

  // Persisted FRIDAY preferences (settings page + voice configuration).
  getPreferences: () => ipcRenderer.invoke("prefs:get"),
  setPreferences: (value) => ipcRenderer.invoke("prefs:set", value),

  // Background life: the window hides into the tray instead of quitting, so the
  // renderer needs explicit show/hide and one real quit call.
  showWindow: () => ipcRenderer.send("window:show"),
  hideWindow: () => ipcRenderer.send("window:hide"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  reportVoiceState: (state) => ipcRenderer.send("voice:state", state),
  getTrayVoiceState: () => ipcRenderer.invoke("voice:tray-state"),
  onVoicePause: on("voice:pause"),

  // Neural voice (edge-tts): free, no key, natural Hindi / Indian-English.
  neuralVoiceStatus: () => ipcRenderer.invoke("voice:neural-status"),
  installNeuralVoice: () => ipcRenderer.invoke("voice:neural-install"),
  listNeuralVoices: () => ipcRenderer.invoke("voice:neural-voices"),
  speakNeural: (payload) => ipcRenderer.invoke("voice:neural-speak", payload),
  duckAudio: (payload) => ipcRenderer.invoke("voice:duck", payload || {}),
  meetingStatus: () => ipcRenderer.invoke("voice:meeting"),
  voiceprintStatus: () => ipcRenderer.invoke("voice:voiceprint-status"),
  clearVoiceprint: () => ipcRenderer.invoke("voice:voiceprint-clear"),
  onVoicePartial: on("voice:partial"),

  // Local voice-model library stored inside the workspace.
  importVoiceModel: (payload) => ipcRenderer.invoke("voice:import", payload),
  removeVoiceModel: (filePath) => ipcRenderer.invoke("voice:remove", filePath),
  listVoiceModels: () => ipcRenderer.invoke("voice:list"),

  // Durable JSON state per namespace (chat, brain, memory, models, tasks).
  // The identity is read synchronously at bridge creation so the renderer can
  // discard a browser cache that belongs to a different or deleted root.
  storageIdentity: storageIdentity(),
  getState: (namespace) => ipcRenderer.invoke("state:get", namespace),
  // Re-validate every component against disk and rewrite the root's registry,
  // integrity and boot records.
  rebuildRootRegistry: () => ipcRenderer.invoke("root:registry"),
  setState: (namespace, value) => ipcRenderer.invoke("state:set", namespace, value),

  // Workspace lifecycle.
  verifyWorkspace: (path) => ipcRenderer.invoke("workspace:verify", path),
  repairWorkspace: (path) => ipcRenderer.invoke("workspace:repair", path),
  scanWorkspace: (force) => ipcRenderer.invoke("workspace:scan", Boolean(force)),
  revealWorkspaceFolder: (relative) => ipcRenderer.invoke("workspace:reveal", relative),

  // Detection (never installs anything on its own).
  detectProviders: () => ipcRenderer.invoke("providers:detect"),
  listOllamaModels: () => ipcRenderer.invoke("providers:ollama-models"),
  detectComponents: () => ipcRenderer.invoke("components:detect"),
  detectHardware: () => ipcRenderer.invoke("hardware:detect"),
  detectSensors: () => ipcRenderer.invoke("system:sensors"),
  detectSecurity: () => ipcRenderer.invoke("system:security"),
  openWindowsSecurity: () => ipcRenderer.invoke("system:open-security"),

  // Live measured telemetry (one shared sampler in the main process).
  systemMetrics: () => ipcRenderer.invoke("system:metrics"),
  subscribeSystemMetrics: () => ipcRenderer.invoke("system:metrics-subscribe"),
  unsubscribeSystemMetrics: () => ipcRenderer.invoke("system:metrics-unsubscribe"),
  onSystemMetrics: on("system:metrics"),

  // Live FRIDAY service health (one shared prober in the main process).
  systemHealth: () => ipcRenderer.invoke("system:health"),
  subscribeSystemHealth: () => ipcRenderer.invoke("system:health-subscribe"),
  unsubscribeSystemHealth: () => ipcRenderer.invoke("system:health-unsubscribe"),
  onSystemHealth: on("system:health"),
  openSource: (url) => ipcRenderer.invoke("components:open-source", url),

  // First-run bootstrap state (<root>/config/first-run.json).
  firstRunState: () => ipcRenderer.invoke("first-run:state"),
  completeFirstRun: (payload) => ipcRenderer.invoke("first-run:complete", payload || {}),

  // Models manager — real Ollama / local-server / cloud operations.
  modelsInventory: () => ipcRenderer.invoke("models:inventory"),
  searchModels: (query, options) =>
    ipcRenderer.invoke("models:search", query || "", options || null),
  aiSuggestModels: (payload) => ipcRenderer.invoke("models:ai-suggest", payload || null),
  testModelProvider: (id, apiKey, options) =>
    ipcRenderer.invoke("models:test-provider", id, apiKey || null, options || null),
  syncModelKnowledge: () => ipcRenderer.invoke("models:sync-catalog"),
  healModelProviders: () => ipcRenderer.invoke("models:heal"),
  previewModelRoute: (prompt) => ipcRenderer.invoke("models:preview-route", prompt || ""),
  setProviderKey: (id, apiKey) => ipcRenderer.invoke("models:set-key", id, apiKey || null),
  setProviderEndpoint: (id, endpoint) =>
    ipcRenderer.invoke("models:set-endpoint", id, endpoint || null),
  providerEndpoints: () => ipcRenderer.invoke("models:endpoints"),
  providerKeys: () => ipcRenderer.invoke("models:keys"),
  providerRegistry: () => ipcRenderer.invoke("providers:registry"),
  sttStatus: (force, localOnly, warm) =>
    ipcRenderer.invoke("voice:stt-status", {
      force: Boolean(force),
      localOnly: Boolean(localOnly),
      warm: Boolean(warm),
    }),
  installStt: () => ipcRenderer.invoke("voice:stt-install"),
  transcribe: (payload) => ipcRenderer.invoke("voice:transcribe", payload),
  scoreTurn: (payload) => ipcRenderer.invoke("voice:score-turn", payload || {}),
  wakeEngineStatus: (payload) => ipcRenderer.invoke("voice:wake-status", payload || {}),
  installWakeEngine: () => ipcRenderer.invoke("voice:wake-install"),
  detectWakeWord: (payload) => ipcRenderer.invoke("voice:wake-detect", payload),
  verifyVoiceRuntime: (payload) => ipcRenderer.invoke("voice:verify", payload || {}),
  modelRouteMode: () => ipcRenderer.invoke("models:route-mode"),
  modelQualityTarget: () => ipcRenderer.invoke("models:quality-target"),
  modelRouteStrategy: () => ipcRenderer.invoke("models:route-strategy"),
  modelSelection: () => ipcRenderer.invoke("models:selection"),
  networkStatus: (force) => ipcRenderer.invoke("system:network", force),

  setModelRouteMode: (mode) => ipcRenderer.invoke("models:set-route-mode", mode),
  setModelQualityTarget: (value) => ipcRenderer.invoke("models:set-quality-target", value),
  setModelRouteStrategy: (value) => ipcRenderer.invoke("models:set-route-strategy", value),
  setModelSelection: (ids) => ipcRenderer.invoke("models:set-selection", ids),
  providerModeReadiness: (mode) => ipcRenderer.invoke("providers:mode-readiness", mode || null),
  showModel: (model) => ipcRenderer.invoke("models:show", model),
  runningModels: () => ipcRenderer.invoke("models:running"),
  pullModel: (model, jobId) => ipcRenderer.invoke("models:pull", model, jobId || null),
  downloadModel: (payload) => ipcRenderer.invoke("models:download", payload || {}),
  cancelModelJob: (jobId) => ipcRenderer.invoke("models:cancel", jobId),
  removeModel: (model) => ipcRenderer.invoke("models:remove", model),
  unloadModel: (model) => ipcRenderer.invoke("models:unload", model),
  probeModel: (model, prompt) => ipcRenderer.invoke("models:run-probe", model, prompt || null),
  routableModels: (force) => ipcRenderer.invoke("models:routable", Boolean(force)),
  // Dynamic registry for the chat model selector: free/paid classified, with
  // live health. API keys never cross this bridge — only model metadata does.
  modelRegistry: (force) => ipcRenderer.invoke("models:registry", Boolean(force)),
  modelUsagePolicy: () => ipcRenderer.invoke("models:policy"),
  setModelUsagePolicy: (policy) => ipcRenderer.invoke("models:set-policy", policy),
  // Billing safety — paid AI usage is locked in the main process by default.
  billingPolicy: () => ipcRenderer.invoke("billing:get"),
  setBillingPolicy: (patch) => ipcRenderer.invoke("billing:set", patch || {}),
  grantPaidUsage: (scope) => ipcRenderer.invoke("billing:grant", scope),
  setPaidKillSwitch: (on) => ipcRenderer.invoke("billing:kill-switch", Boolean(on)),
  providerAccessTiers: () => ipcRenderer.invoke("providers:access"),
  setProviderAccessTier: (id, tier, declaration) =>
    ipcRenderer.invoke("providers:set-access", id, tier, declaration || null),
  // Live billing + kernel-sync pushes, so the UI reflects a router decision the
  // moment it happens instead of on the next poll.
  onBillingState: on("models:billing"),
  onBillingBlocked: on("models:billing-blocked"),
  // Privacy / data-egress firewall — nothing leaves this PC without a fresh
  // confirmation, and the renderer can show what was asked and what was decided.
  privacyLastEgress: () => ipcRenderer.invoke("privacy:last"),
  classifyContent: (text) => ipcRenderer.invoke("privacy:classify", String(text || "")),
  onEgressPending: on("privacy:egress-pending"),
  onEgressDecided: on("privacy:egress-decided"),
  onKernelModelSync: on("models:kernel-sync"),

  // Connectivity graph — how every feature is wired to FRIDAY right now.
  connectivityGraph: () => ipcRenderer.invoke("connectivity:graph"),
  refreshConnectivity: () => ipcRenderer.invoke("connectivity:refresh"),
  onConnectivityChanged: on("connectivity:changed"),

  modelHealthState: () => ipcRenderer.invoke("models:health-state"),
  syncKernelModels: (force) => ipcRenderer.invoke("models:sync-kernel", Boolean(force)),
  selectModels: (task, preferred) =>
    ipcRenderer.invoke("models:select", task || "chat", preferred || []),
  modelHealth: (modelId) => ipcRenderer.invoke("models:health", modelId),
  modelEngines: () => ipcRenderer.invoke("models:engines"),
  startModelEngine: (id, selectedModel) =>
    ipcRenderer.invoke("models:engine-start", id, selectedModel || null),
  stopModelEngine: (id) => ipcRenderer.invoke("models:engine-stop", id),

  // Non-streaming kernel calls (chat history, memory, code runner).
  kernel: (method, params) => ipcRenderer.invoke("kernel:rpc", method, params || {}),
  // Owner permission policy for risky tools (allow / ask / deny per tool).
  toolPolicy: () => ipcRenderer.invoke("permissions:tool-policy"),
  setToolPolicy: (name, decision) =>
    ipcRenderer.invoke("permissions:set-tool-policy", name, decision),
  companionEnabled: () => ipcRenderer.invoke("companion:get"),
  setCompanionEnabled: (enabled) => ipcRenderer.invoke("companion:set", Boolean(enabled)),
  // One feature registry → the phone menu mirrors the desktop sidebar.
  publishCompanionFeatures: (payload) =>
    ipcRenderer.invoke("companion:publish-features", payload || []),
  companionRemote: () => ipcRenderer.invoke("companion:remote-get"),
  setCompanionRemote: (enabled) => ipcRenderer.invoke("companion:remote-set", Boolean(enabled)),

  // Plugins — shipped catalog from appRoot plus workspace packs. Enable is
  // capabilities.json (same store as the Plugins page). Hooks dispatch through
  // plugins:dispatch with capabilityRoots().
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  checkPluginUpdates: () => ipcRenderer.invoke("plugins:check-updates"),
  loadPlugin: (id) => ipcRenderer.invoke("plugins:load", id),
  reloadPlugin: (id) => ipcRenderer.invoke("plugins:reload", id),
  unloadPlugin: (id) => ipcRenderer.invoke("plugins:unload", id),
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke("plugins:set-enabled", id, enabled),
  removePlugin: (id) => ipcRenderer.invoke("plugins:remove", id),
  installPlugin: () => ipcRenderer.invoke("plugins:install"),
  invokePlugin: (id, command, args) => ipcRenderer.invoke("plugins:invoke", id, command, args),
  pluginTools: () => ipcRenderer.invoke("plugins:tools"),
  dispatchPluginHooks: (hook, payload, options) =>
    ipcRenderer.invoke("plugins:dispatch", hook, payload || {}, options || {}),
  onPluginEvent: on("plugin:event"),

  // Telemetry for the Diagnostics/Logs pages.
  telemetrySnapshot: () => ipcRenderer.invoke("telemetry:snapshot"),
  telemetryClear: () => ipcRenderer.invoke("telemetry:clear"),
  telemetryFiles: () => ipcRenderer.invoke("telemetry:files"),
  telemetryReadFile: (rel) => ipcRenderer.invoke("telemetry:read-file", rel),

  // Updates — always confirmed by the user before anything is applied.
  checkUpdates: () => ipcRenderer.invoke("updates:check"),
  applyUpdate: (update) => ipcRenderer.invoke("updates:apply", update),
  rollbackUpdate: (entry) => ipcRenderer.invoke("updates:rollback", entry),
  onUpdateProgress: on("updates:progress"),
  confirmRestart: (reason) => ipcRenderer.invoke("app:confirm-restart", reason),
  restartApp: (reason) => ipcRenderer.invoke("app:restart", reason),
  restartState: () => ipcRenderer.invoke("app:restart-state"),
  onRestartRequired: on("app:restart-required"),

  // Import — stage a FRIDAY ZIP/folder, review the diff, then apply or roll back.
  pickImportZip: () => ipcRenderer.invoke("import:pick-zip"),
  pickImportFolder: () => ipcRenderer.invoke("import:pick-folder"),
  stageImportBytes: (name, bytes) => ipcRenderer.invoke("import:stage-bytes", name, bytes),
  stageImportFile: (id, relative, bytes) =>
    ipcRenderer.invoke("import:stage-file", id, relative, bytes),
  downloadImport: (url, name, token) => ipcRenderer.invoke("import:download", url, name, token),
  scanImport: (source) => ipcRenderer.invoke("import:scan", source),
  verifyImport: (scan) => ipcRenderer.invoke("import:verify", scan),
  verifyImportPacks: (scan) => ipcRenderer.invoke("import:verify-packs", scan),
  applyImport: (scan, options) => ipcRenderer.invoke("import:apply", scan, options),
  rollbackImport: (backup) => ipcRenderer.invoke("import:rollback", backup),
  revealImport: (target) => ipcRenderer.invoke("import:reveal", target),
  onImportProgress: on("import:progress"),

  // GitHub update source — FRIDAY's own repo (private supported) as a feed.
  githubConfig: () => ipcRenderer.invoke("github:config"),
  githubSetConfig: (patch) => ipcRenderer.invoke("github:set-config", patch),
  githubTest: (override) => ipcRenderer.invoke("github:test", override),
  githubConnection: (refresh) => ipcRenderer.invoke("github:connection", refresh === true),

  githubCheck: (override) => ipcRenderer.invoke("github:check", override),
  githubPull: (ref) => ipcRenderer.invoke("github:pull", ref),
  githubRecord: (payload) => ipcRenderer.invoke("github:record", payload),
  githubDownloadInstaller: (asset) => ipcRenderer.invoke("github:download-installer", asset),
  githubRunInstaller: (file) => ipcRenderer.invoke("github:run-installer", file),
  // Safe update — verify, back up, install, then health-check / roll back.
  githubInstallUpdate: (payload) => ipcRenderer.invoke("github:install-update", payload),
  githubUpdateState: () => ipcRenderer.invoke("github:update-state"),
  githubRollback: (backup) => ipcRenderer.invoke("github:rollback", backup),
  // Source push — development only, and only when the owner asks for it.
  githubSourceStatus: () => ipcRenderer.invoke("github:source-status"),
  githubSourceSync: () => ipcRenderer.invoke("github:source-sync"),
  githubPushSource: (input) => ipcRenderer.invoke("github:push-source", input),
  githubPushAndSync: (input) => ipcRenderer.invoke("github:push-and-sync", input),

  // Release control — reads plus one explicit "start the GitHub workflow" call.
  githubReleases: (override) => ipcRenderer.invoke("github:releases", override),
  githubInstallerBundles: (override) => ipcRenderer.invoke("github:installer-bundles", override),
  githubAnalyze: (override) => ipcRenderer.invoke("github:analyze", override),
  githubDispatchRelease: (input) => ipcRenderer.invoke("github:dispatch-release", input),
  githubReleaseStatus: (override) => ipcRenderer.invoke("github:release-status", override),
  githubDispatchTestBuild: (input) => ipcRenderer.invoke("github:dispatch-test-build", input),
  githubReleaseRuns: (override) => ipcRenderer.invoke("github:release-runs", override),

  githubHubConnections: () => ipcRenderer.invoke("github:hub-connections"),
  githubHubAddConnection: (payload) => ipcRenderer.invoke("github:hub-add-connection", payload),
  githubHubRemoveConnection: (id) => ipcRenderer.invoke("github:hub-remove-connection", id),
  githubHubSelectConnection: (id) => ipcRenderer.invoke("github:hub-select-connection", id),
  githubHubTestConnection: (id) => ipcRenderer.invoke("github:hub-test-connection", id),
  githubHubWorkflows: () => ipcRenderer.invoke("github:hub-workflows"),
  githubHubDispatchWorkflow: (payload) =>
    ipcRenderer.invoke("github:hub-dispatch-workflow", payload),
  githubHubReleases: () => ipcRenderer.invoke("github:hub-releases"),
  githubCreateRepo: (payload) => ipcRenderer.invoke("github:create-repo", payload),
  githubPackagePush: (payload) => ipcRenderer.invoke("github:package-push", payload),

  onGithubUpdate: on("github:update-available"),
  onGithubConnection: on("github:connection"),
  onGithubUpdateHealth: on("github:update-health"),
  onGithubDownloadProgress: on("github:download-progress"),

  // Friday Hub · development / repo control.
  devWorkspace: () => ipcRenderer.invoke("dev:workspace"),
  devDiff: (file) => ipcRenderer.invoke("dev:diff", file),
  devValidate: (payload) => ipcRenderer.invoke("dev:validate", payload),
  devBranch: (payload) => ipcRenderer.invoke("dev:branch", payload),
  devPublish: (payload) => ipcRenderer.invoke("dev:publish", payload),
  devOpenPullRequest: (payload) => ipcRenderer.invoke("dev:open-pr", payload),
  devPullRequests: () => ipcRenderer.invoke("dev:pull-requests"),
  devChangeSets: () => ipcRenderer.invoke("dev:change-sets"),
  devQueueChangeSet: (entry) => ipcRenderer.invoke("dev:queue-change-set", entry),
  devUpdateChangeSet: (id, patch) => ipcRenderer.invoke("dev:update-change-set", id, patch),
  devRemoveChangeSet: (id) => ipcRenderer.invoke("dev:remove-change-set", id),
  devHistory: (payload) => ipcRenderer.invoke("dev:history", payload),
  devMergedPullRequests: () => ipcRenderer.invoke("dev:merged-prs"),
  devCommit: (sha) => ipcRenderer.invoke("dev:commit", sha),
  devRestorePreview: (sha) => ipcRenderer.invoke("dev:restore-preview", sha),
  devRevertCommit: (payload) => ipcRenderer.invoke("dev:revert-commit", payload),
  devRestoreCommit: (payload) => ipcRenderer.invoke("dev:restore-commit", payload),
  devCheckoutBranch: (payload) => ipcRenderer.invoke("dev:checkout-branch", payload),
  devListFiles: () => ipcRenderer.invoke("dev:list-files"),
  devReadFile: (file) => ipcRenderer.invoke("dev:read-file", file),
  devWriteFile: (payload) => ipcRenderer.invoke("dev:write-file", payload),
  devCommitFiles: (payload) => ipcRenderer.invoke("dev:commit-files", payload),
  onDevValidateProgress: on("dev:validate-progress"),

  // Friday Hub workbench — inspect, preview, edit and adopt a staged import.
  hubFiles: (scanId) => ipcRenderer.invoke("hub:files", scanId),
  hubRead: (scanId, file) => ipcRenderer.invoke("hub:read", scanId, file),
  hubWrite: (scanId, file, content) => ipcRenderer.invoke("hub:write", scanId, file, content),
  hubAnalyze: (scanId) => ipcRenderer.invoke("hub:analyze", scanId),
  hubExtract: (scanId, groups) => ipcRenderer.invoke("hub:extract", scanId, groups),
  hubWorkbench: (scanId, name) => ipcRenderer.invoke("hub:workbench", scanId, name),

  // Builds — FRIDAY identity uses scripts\build-windows.cmd; other apps use
  // the local factory (zip / this-project electron-builder). Never git-push.
  startBuild: (kind, options) => ipcRenderer.invoke("build:start", kind, options),
  cancelBuild: (id) => ipcRenderer.invoke("build:cancel", id),
  activeBuilds: () => ipcRenderer.invoke("build:active"),
  buildArtifacts: () => ipcRenderer.invoke("build:artifacts"),
  revealArtifact: (file) => ipcRenderer.invoke("build:reveal", file),
  buildRoot: () => ipcRenderer.invoke("build:root"),
  pickBuildRoot: () => ipcRenderer.invoke("build:pick-root"),
  factoryInspect: (dir) => ipcRenderer.invoke("factory:inspect", dir),
  factoryPickSource: () => ipcRenderer.invoke("factory:pick-source"),
  factoryKeep: (file) => ipcRenderer.invoke("factory:keep", file),
  factorySaveAs: (file) => ipcRenderer.invoke("factory:save-as", file),
  factoryInstallExe: (file) => ipcRenderer.invoke("factory:install-exe", file),
  factoryListKept: () => ipcRenderer.invoke("factory:list-kept"),
  onBuildProgress: on("build:progress"),

  // Self-maintenance — architecture index, impact verdicts, sandbox-verified
  // apply, and rollback. Every call reflects real files and real processes.
  // Environment / dependency registry (shared with browser mode).
  envRegistry: () => ipcRenderer.invoke("env:registry"),
  envRefresh: () => ipcRenderer.invoke("env:refresh"),
  envRepair: (id) => ipcRenderer.invoke("env:repair", id || null),
  envReadiness: () => ipcRenderer.invoke("env:readiness"),
  onEnvRepaired: on("env:repaired"),

  selfState: () => ipcRenderer.invoke("self:state"),
  selfIndex: (rebuild) => ipcRenderer.invoke("self:index", Boolean(rebuild)),
  selfScan: () => ipcRenderer.invoke("self:scan"),
  selfApply: (id, mode) => ipcRenderer.invoke("self:apply", { id, mode }),
  selfRollback: (backup) => ipcRenderer.invoke("self:rollback", backup),
  selfVerify: (areas) => ipcRenderer.invoke("self:verify", { areas }),

  selfHealth: () => ipcRenderer.invoke("self:health"),
  finetuneState: () => ipcRenderer.invoke("finetune:state"),
  finetuneProbe: () => ipcRenderer.invoke("finetune:probe"),
  finetuneStart: (job) => ipcRenderer.invoke("finetune:start", job),
  finetuneCancel: () => ipcRenderer.invoke("finetune:cancel"),
  finetuneAdapters: () => ipcRenderer.invoke("finetune:adapters"),
  finetuneActivate: (id) => ipcRenderer.invoke("finetune:activate", id),
  finetuneRemove: (id) => ipcRenderer.invoke("finetune:remove", id),
  onFinetuneRun: on("finetune:run"),
  // Read-only reads of FRIDAY's own project source (no write counterpart).
  selfReadSource: (relative) => ipcRenderer.invoke("self:read-source", relative),
  selfListSource: (relative) => ipcRenderer.invoke("self:list-source", relative),
  selfSearchSource: (query, options) => ipcRenderer.invoke("self:search-source", query, options),
  onSelfIndex: on("self:index"),
  onSelfImpact: on("self:impact"),
  onSelfProgress: on("self:progress"),
  onSelfRecord: on("self:record"),
  onHotReload: on("workspace:hot-reload"),

  // Capability discovery — manifest-driven agents/skills/tools/modules/
  // plugins/workflows/models, shipped and user-installed.
  listCapabilities: () => ipcRenderer.invoke("capabilities:list"),
  setCapabilityEnabled: (id, enabled) =>
    ipcRenderer.invoke("capabilities:set-enabled", id, enabled),
  reloadCapabilities: () => ipcRenderer.invoke("capabilities:reload"),
  installCapability: (pack) => ipcRenderer.invoke("capabilities:install", pack),
  uninstallCapability: (id) => ipcRenderer.invoke("capabilities:uninstall", id),
  installCapabilityFromUrl: (url) => ipcRenderer.invoke("capabilities:install-url", url),
  installCapabilityFromFile: (tree) => ipcRenderer.invoke("capabilities:install-file", tree),
  installCapabilityFromGithub: (tree, url) =>
    ipcRenderer.invoke("capabilities:install-github", tree, url),
  installSkillZip: () => ipcRenderer.invoke("capabilities:install-skill-zip"),
  installSkillFolder: () => ipcRenderer.invoke("capabilities:install-skill-folder"),
  installSkillGit: (url) => ipcRenderer.invoke("capabilities:install-skill-git", url),
  installToolZip: () => ipcRenderer.invoke("capabilities:install-tool-zip"),
  installToolFolder: () => ipcRenderer.invoke("capabilities:install-tool-folder"),
  installToolGit: (url) => ipcRenderer.invoke("capabilities:install-tool-git", url),
  installAgentZip: () => ipcRenderer.invoke("capabilities:install-agent-zip"),
  installAgentFolder: () => ipcRenderer.invoke("capabilities:install-agent-folder"),
  installAgentGit: (url) => ipcRenderer.invoke("capabilities:install-agent-git", url),
  installModuleZip: () => ipcRenderer.invoke("capabilities:install-module-zip"),
  installModuleFolder: () => ipcRenderer.invoke("capabilities:install-module-folder"),
  installModuleGit: (url) => ipcRenderer.invoke("capabilities:install-module-git", url),
  installPluginZip: () => ipcRenderer.invoke("capabilities:install-plugin-zip"),
  installPluginFolder: () => ipcRenderer.invoke("capabilities:install-plugin-folder"),
  installPluginGit: (url) => ipcRenderer.invoke("capabilities:install-plugin-git", url),
  installWorkflowZip: () => ipcRenderer.invoke("capabilities:install-workflow-zip"),
  installWorkflowFolder: () => ipcRenderer.invoke("capabilities:install-workflow-folder"),
  installWorkflowGit: (url) => ipcRenderer.invoke("capabilities:install-workflow-git", url),
  // Test-before-enable: re-run the real sandbox smoke test for one pack.
  verifyCapability: (id) => ipcRenderer.invoke("capabilities:verify", id),
  onCapabilitiesChanged: on("capabilities:changed"),
  onCapabilityVerifying: on("capabilities:verifying"),
  onCapabilityVerified: on("capabilities:verified"),

  // External service connectors — credentials never cross this boundary.
  listConnectors: () => ipcRenderer.invoke("connectors:list"),
  connectConnector: (id, values) => ipcRenderer.invoke("connectors:connect", id, values),
  disconnectConnector: (id) => ipcRenderer.invoke("connectors:disconnect", id),
  verifyConnector: (id) => ipcRenderer.invoke("connectors:verify", id),
  callConnector: (id, action, params) => ipcRenderer.invoke("connectors:call", id, action, params),
  startOAuthConnector: (id, values) => ipcRenderer.invoke("connectors:oauth-start", id, values),
  sendConnectorPhoneCode: (id, values) => ipcRenderer.invoke("connectors:phone-send", id, values),
  confirmConnectorPhoneCode: (id, values) =>
    ipcRenderer.invoke("connectors:phone-confirm", id, values),
  onConnectorsChanged: on("connectors:changed"),

  // Setup & Doctor — real diagnostics and guarded repairs.
  runDiagnostics: (options) => ipcRenderer.invoke("doctor:run", options || {}),
  applyDiagnosticFix: (id) => ipcRenderer.invoke("doctor:fix", id),
  rollbackDiagnosticFix: (entries) => ipcRenderer.invoke("doctor:rollback", entries),
  exportDiagnostics: (report) => ipcRenderer.invoke("doctor:export", report),
  onDiagnosticFixProgress: on("doctor:fix-progress"),

  // Install Manager — real detection and background install jobs.
  detectTools: (force) => ipcRenderer.invoke("tools:detect", Boolean(force)),
  latestToolVersions: () => ipcRenderer.invoke("tools:latest"),
  runToolJob: (job) => ipcRenderer.invoke("tools:run", job),
  cancelToolJob: (job) => ipcRenderer.invoke("tools:cancel", job),
  activeToolJobs: () => ipcRenderer.invoke("tools:active-jobs"),
  onToolProgress: on("tools:progress"),

  // FRIDAY's own browser.
  webSearch: (query, limit) => ipcRenderer.invoke("browser:search", query, limit || 8),
  webOpen: (url, options) => ipcRenderer.invoke("browser:open", url, options || {}),
  webDownload: (url, name) => ipcRenderer.invoke("browser:download", url, name || null),
  webScreenshot: (url) => ipcRenderer.invoke("browser:screenshot", url),
  webHistory: (limit) => ipcRenderer.invoke("browser:history", limit || 40),
  webInteract: (payload) => ipcRenderer.invoke("browser:interact", payload || {}),
  extractDocument: (payload) => ipcRenderer.invoke("documents:extract", payload || {}),
  libraryList: () => ipcRenderer.invoke("library:list"),
  libraryIngest: (payload) => ipcRenderer.invoke("library:ingest", payload || {}),
  libraryGet: (id) => ipcRenderer.invoke("library:get", id),
  libraryDelete: (id) => ipcRenderer.invoke("library:delete", id),
  libraryReveal: (id) => ipcRenderer.invoke("library:reveal", id),
  libraryZip: (ids) => ipcRenderer.invoke("library:zip", ids || []),
  libraryScan: () => ipcRenderer.invoke("library:scan"),
  libraryWrite: (payload) => ipcRenderer.invoke("library:write", payload || {}),
  libraryPin: (payload) => ipcRenderer.invoke("library:pin", payload || {}),
  libraryPatch: (payload) => ipcRenderer.invoke("library:patch", payload || {}),
  projectPickFolder: () => ipcRenderer.invoke("projects:pick-folder"),
  projectList: () => ipcRenderer.invoke("projects:list"),
  projectSave: (payload) => ipcRenderer.invoke("projects:save", payload || {}),
  projectGet: (id) => ipcRenderer.invoke("projects:get", id),
  projectSetActive: (id) => ipcRenderer.invoke("projects:set-active", id ?? null),
  projectDuplicate: (id) => ipcRenderer.invoke("projects:duplicate", id),
  projectArchive: (payload) => ipcRenderer.invoke("projects:archive", payload || {}),
  projectDelete: (id) => ipcRenderer.invoke("projects:delete", id),
  projectReveal: (id) => ipcRenderer.invoke("projects:reveal", id),
  projectWriteFile: (payload) => ipcRenderer.invoke("projects:write-file", payload || {}),
  projectListFiles: (id) => ipcRenderer.invoke("projects:list-files", id),
  projectReadFile: (payload) => ipcRenderer.invoke("projects:read-file", payload || {}),

  // Screen awareness — only ever works when the owner enabled it.
  screenVisionState: () => ipcRenderer.invoke("screen:state"),
  setScreenVision: (patch) => ipcRenderer.invoke("screen:set-state", patch || {}),
  screenSources: () => ipcRenderer.invoke("screen:sources"),
  captureScreen: (options) => ipcRenderer.invoke("screen:capture", options || {}),
  diagramOcr: (dataUrl) => ipcRenderer.invoke("diagram:ocr", dataUrl || ""),
  cameraState: () => ipcRenderer.invoke("camera:state"),
  setCamera: (patch) => ipcRenderer.invoke("camera:set-state", patch || {}),
  captureCamera: (options) => ipcRenderer.invoke("camera:capture", options || {}),
  ingestCamera: (payload) => ipcRenderer.invoke("camera:ingest", payload || {}),
  clipCamera: (options) => ipcRenderer.invoke("camera:clip", options || {}),

  // FRIDAY Browser — real Chromium tabs sharing one persistent session.
  browserSettings: () => ipcRenderer.invoke("browser:settings-get"),
  setBrowserSettings: (patch) => ipcRenderer.invoke("browser:settings-set", patch || {}),
  browserVisits: (limit) => ipcRenderer.invoke("browser:visits", limit || 200),
  addBrowserVisit: (entry) => ipcRenderer.invoke("browser:visit-add", entry || {}),
  clearBrowserVisits: () => ipcRenderer.invoke("browser:visits-clear"),
  browserBookmarks: () => ipcRenderer.invoke("browser:bookmarks"),
  addBrowserBookmark: (entry) => ipcRenderer.invoke("browser:bookmark-add", entry || {}),
  removeBrowserBookmark: (url) => ipcRenderer.invoke("browser:bookmark-remove", url),
  browserTabs: () => ipcRenderer.invoke("browser:tabs-get"),
  saveBrowserTabs: (state) => ipcRenderer.invoke("browser:tabs-set", state || {}),
  publishBrowserState: (state) => ipcRenderer.invoke("browser:live-publish", state || {}),
  liveBrowserState: () => ipcRenderer.invoke("browser:live-get"),
  browserCommand: (payload) => ipcRenderer.invoke("browser:live-command", payload || {}),
  browserCommandResult: (id, result) => ipcRenderer.invoke("browser:command-result", id, result),
  browserDownloads: () => ipcRenderer.invoke("browser:downloads"),
  clearBrowserDownloads: () => ipcRenderer.invoke("browser:downloads-clear"),
  clearBrowserData: (kinds) => ipcRenderer.invoke("browser:clear-data", kinds || null),
  browserCookieCount: () => ipcRenderer.invoke("browser:cookie-count"),
  clearOriginCookies: (url) => ipcRenderer.invoke("browser:clear-origin-cookies", url),
  browserActiveGuest: (id) => ipcRenderer.invoke("browser:active-guest", id),
  revealDownload: (file) => ipcRenderer.invoke("browser:reveal-download", file),
  openExternalUrl: (url) => ipcRenderer.invoke("browser:open-external", url),
  onBrowserCommand: on("browser:command"),
  onBrowserDownload: on("browser:download"),
  onBrowserPopup: on("browser:popup"),
  onBrowserLiveState: on("browser:live-state"),
  onBrowserContextMenu: on("browser:context-menu"),
  onBrowserGuestGone: on("browser:guest-gone"),

  // FRIDAY's own skills.
  listSkills: () => ipcRenderer.invoke("skills:list"),
  readSkill: (id) => ipcRenderer.invoke("skills:read", id),
  writeSkill: (skill) => ipcRenderer.invoke("skills:write", skill),
  removeSkill: (id) => ipcRenderer.invoke("skills:remove", id),
  rollbackSkill: (id) => ipcRenderer.invoke("skills:rollback", id),
  setSkillEnabled: (id, enabled) => ipcRenderer.invoke("skills:set-enabled", id, enabled),
  verifySkill: (candidate) => ipcRenderer.invoke("skills:verify", candidate),
  invokeSkill: (id, input, options) =>
    ipcRenderer.invoke("skills:invoke", id, input || {}, options || {}),

  listToolPacks: () => ipcRenderer.invoke("toolpacks:list"),
  writeToolPack: (pack) => ipcRenderer.invoke("toolpacks:write", pack),
  verifyToolPack: (candidate) => ipcRenderer.invoke("toolpacks:verify", candidate),
  invokeToolPack: (id, input, options) =>
    ipcRenderer.invoke("toolpacks:invoke", id, input || {}, options || {}),

  listAgents: () => ipcRenderer.invoke("agents:list"),
  planAgent: (id, input, options) =>
    ipcRenderer.invoke("agents:plan", id, input || {}, options || {}),
  runAgent: (id, input, options) =>
    ipcRenderer.invoke("agents:run", id, input || {}, options || {}),

  listModulePacks: () => ipcRenderer.invoke("modules:list"),
  invokeModulePack: (id, input, options) =>
    ipcRenderer.invoke("modules:invoke", id, input || {}, options || {}),

  // Sandbox + identity.
  runSandbox: (options) => ipcRenderer.invoke("sandbox:run", options || {}),
  writeIdentity: (prompt) => ipcRenderer.invoke("identity:write", prompt),

  // Sandbox Lab — isolated dev/test runtime under <workspace>/sandbox.
  sandboxSummary: () => ipcRenderer.invoke("sandbox-lab:summary"),
  sandboxDetectRuntime: () => ipcRenderer.invoke("sandbox-lab:detect"),
  sandboxInstallRuntime: (id) => ipcRenderer.invoke("sandbox-lab:install-runtime", id),
  sandboxCreateProject: (options) => ipcRenderer.invoke("sandbox-lab:create", options || {}),
  sandboxRemoveProject: (id, keepFiles) => ipcRenderer.invoke("sandbox-lab:remove", id, keepFiles),
  sandboxListFiles: (id) => ipcRenderer.invoke("sandbox-lab:files", id),
  sandboxPlanChecks: (id) => ipcRenderer.invoke("sandbox-lab:plan-checks", id),
  sandboxReadFile: (id, file) => ipcRenderer.invoke("sandbox-lab:read", id, file),
  sandboxWriteFile: (id, file, content) =>
    ipcRenderer.invoke("sandbox-lab:write", id, file, content),
  sandboxDeleteFile: (id, file) => ipcRenderer.invoke("sandbox-lab:delete", id, file),
  sandboxImportFolder: (id) => ipcRenderer.invoke("sandbox-lab:import-folder", id),
  sandboxExec: (options) => ipcRenderer.invoke("sandbox-lab:exec", options || {}),

  // Real workspace terminal (child process in the FRIDAY workspace root).
  terminalExec: (options) => ipcRenderer.invoke("terminal:exec", options || {}),
  terminalCancel: (runId) => ipcRenderer.invoke("terminal:cancel", runId),
  terminalWrite: (runId, data) => ipcRenderer.invoke("terminal:write", runId, data),
  terminalRuns: () => ipcRenderer.invoke("terminal:runs"),
  terminalShells: () => ipcRenderer.invoke("terminal:shells"),
  terminalCd: (cwd, target) => ipcRenderer.invoke("terminal:cd", cwd, target),
  terminalRoot: () => ipcRenderer.invoke("terminal:cwd"),
  onTerminalOutput: on("terminal:output"),

  sandboxCancel: (runId) => ipcRenderer.invoke("sandbox-lab:cancel", runId),
  sandboxEngines: () => ipcRenderer.invoke("sandbox-lab:engines"),
  sandboxInstallEngine: (id) => ipcRenderer.invoke("sandbox-lab:install-engine", id),
  sandboxSetEngine: (id, engine) => ipcRenderer.invoke("sandbox-lab:set-engine", id, engine),
  sandboxStartEngine: (id) => ipcRenderer.invoke("sandbox-lab:start-engine", id),
  sandboxLaunchEngine: (id, dir) => ipcRenderer.invoke("sandbox-lab:launch-engine", id, dir),
  sandboxLog: (id) => ipcRenderer.invoke("sandbox-lab:log", id),
  sandboxDiff: (id) => ipcRenderer.invoke("sandbox-lab:diff", id),
  sandboxApply: (options) => ipcRenderer.invoke("sandbox-lab:apply", options || {}),
  sandboxRollback: (applyId) => ipcRenderer.invoke("sandbox-lab:rollback", applyId),
  sandboxReveal: (target) => ipcRenderer.invoke("sandbox-lab:reveal", target),
  sandboxConfig: (patch) => ipcRenderer.invoke("sandbox-lab:config", patch),
  onSandboxOutput: on("sandbox-lab:output"),
  onSandboxRuntime: on("sandbox-lab:runtime"),
  onSandboxApplyProgress: on("sandbox-lab:apply-progress"),

  // Custom title strip controls. The window keeps the native Windows frame
  // behaviour (snap, resize, system menu) with the caption hidden.
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  toggleMaximizeWindow: () => ipcRenderer.send("window:toggle-maximize"),
  openWindowSystemMenu: () => ipcRenderer.send("window:system-menu"),
  getWindowState: () => ipcRenderer.invoke("window:state"),
  onWindowState: on("window:state"),

  // Windows integration.
  getStartWithWindows: () => ipcRenderer.invoke("startup:get"),
  setStartWithWindows: (enabled) => ipcRenderer.invoke("startup:set", enabled),
  encryptionStatus: () => ipcRenderer.invoke("security:encryption"),
  openDevTools: () => ipcRenderer.invoke("window:open-devtools"),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("window:set-always-on-top", enabled),
  reportBusy: (busy) => ipcRenderer.send("window:busy", busy),

  onKernelLog: on("kernel:log"),
  onTelemetryLog: on("telemetry:log"),
  onTelemetryIpc: on("telemetry:ipc"),
  onTelemetryCleared: on("telemetry:cleared"),
  onKernelExit: on("kernel:exit"),
  onKernelRecover: on("kernel:recover"),
  onWorkspaceChange: on("workspace:changed"),
  onSenseEvent: on("senses:event"),
  onWorkspaceScan: on("workspace:scanned"),
  onWorkspaceMigrate: on("workspace:migrate"),
  onProvidersDetected: on("providers:detected"),
  onModelRegistryChanged: on("models:registry-changed"),
  onModelHealthChanged: on("models:health-changed"),
  onModelPolicy: on("models:policy"),
  onNetworkStatus: on("system:network"),

  // ---- 2D desktop companion (transparent overlay window) ----------------
  characterGet: () => ipcRenderer.invoke("character:get"),
  characterSet: (patch) => ipcRenderer.invoke("character:set", patch || {}),
  characterStart: () => ipcRenderer.invoke("character:start"),
  characterStop: () => ipcRenderer.invoke("character:stop"),
  characterRestart: () => ipcRenderer.invoke("character:restart"),
  characterResetPosition: () => ipcRenderer.invoke("character:reset-position"),
  characterModel: () => ipcRenderer.invoke("character:model"),
  characterTexture: () => ipcRenderer.invoke("character:texture"),
  characterHealth: () => ipcRenderer.invoke("character:health"),
  characterInstall: () => ipcRenderer.invoke("character:install"),
  characterRepair: () => ipcRenderer.invoke("character:repair"),
  characterUpdate: () => ipcRenderer.invoke("character:update"),
  characterRemove: () => ipcRenderer.invoke("character:remove"),
  characterProbe: (probe) => ipcRenderer.invoke("character:probe", probe || {}),
  characterPublish: (state) => ipcRenderer.invoke("character:publish", state || {}),
  characterAsk: (payload) => ipcRenderer.invoke("character:ask", payload || {}),
  characterCommand: (payload) => ipcRenderer.invoke("character:command", payload || {}),
  characterDrag: (delta) => ipcRenderer.invoke("character:drag", delta || {}),
  characterInteractive: (on) => ipcRenderer.invoke("character:interactive", on),
  characterShowApp: () => ipcRenderer.invoke("character:show-app"),
  onCharacterState: on("character:state"),
  onCharacterSettings: on("character:settings"),
  onCharacterGaze: on("character:gaze"),
  onCharacterContext: on("character:context"),
  onCharacterAsk: on("character:ask"),
  onCharacterCommand: on("character:command"),

  onModelPullProgress: on("models:pull-progress"),
  onModelPullDone: on("models:pull-done"),
});
