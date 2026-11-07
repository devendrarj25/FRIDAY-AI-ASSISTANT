/**
 * When may a wait for the local AI service stop waiting?
 *
 * A wait that starts before the kernel process has been spawned (the window is up, the folder is being
 * rediscovered, the previous kernel is still being stopped) must keep waiting. It used to give up at once
 * because "no process and not ready" looked the same as "the process died", so a restart reported
 * "kernel did not answer /health" and the first remote call failed with "local AI service is unavailable"
 * although the kernel was about to start. Only a known failure, or a process that was spawned and then died,
 * ends the wait early.
 */

/**
 * @param {{ kernel: unknown, kernelReady: boolean, kernelStartPromise: unknown, kernelFailure: string, bootPending: boolean }} state
 * @returns {boolean} true when waiting is pointless
 */
function shouldStopWaiting(state) {
  const { kernel, kernelReady, kernelStartPromise, kernelFailure, bootPending } = state;
  if (kernelReady) return false;
  // A start is on its way: the process is not there yet, but it will be.
  if (bootPending) return false;
  if (kernel) return false;
  // Spawned earlier, now gone, and nothing is restarting it: waiting cannot help.
  if (kernelStartPromise) return false;
  return true;
}

/** True when a known spawn or configuration failure already explains why there is no kernel. */
function hasKnownFailure(state) {
  return !state.kernelReady && !state.kernel && !state.kernelStartPromise && !state.bootPending
    ? Boolean(state.kernelFailure)
    : false;
}

module.exports = { shouldStopWaiting, hasKnownFailure };
