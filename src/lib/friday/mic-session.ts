/** Capture decisions for real Windows audio events. The events are injected. */

export function negotiateRate(offered: readonly number[], want = 16000): number {
  const rates = offered.filter((rate) => Number.isFinite(rate) && rate > 0);
  if (!rates.length) return want;
  if (rates.includes(want)) return want;
  const above = rates.filter((rate) => rate > want).sort((a, b) => a - b);
  return above[0] || rates.slice().sort((a, b) => b - a)[0] || want;
}

export function onProfileSwitch(profile: string): {
  reopen: boolean;
  rate: number;
  reason: string;
} {
  if (profile === "hfp") return { reopen: true, rate: 16000, reason: "headset call profile" };
  if (profile === "a2dp") return { reopen: true, rate: 48000, reason: "headset media profile" };
  return { reopen: false, rate: 16000, reason: "profile unchanged" };
}

export function onSessionEvent(kind: string): { reopen: boolean; reason: string } {
  switch (kind) {
    case "hotplug":
    case "default-device":
    case "sleep":
    case "resume":
    case "lock":
    case "unlock":
    case "fast-user-switch":
      return { reopen: true, reason: kind };
    case "exclusive":
      return { reopen: true, reason: "exclusive mode" };
    default:
      return { reopen: false, reason: "ignored" };
  }
}

export function trackWatch(input: {
  frames: number;
  sameEnergy: number;
  handles: number;
  crashes: number;
}): { stuck: boolean; leak: boolean; restart: boolean } {
  const stuck = input.frames > 50 && input.sameEnergy > 40;
  const leak = input.handles > 8;
  const restart = stuck || leak || input.crashes > 0;
  return { stuck, leak, restart };
}

let offered: number[] = [16000, 48000];

/** Remember the rate a headset or a hot-plug asked for, then pick one rate. */
export function applySession(
  kind: string,
  profile = "unchanged",
): { reopen: boolean; rate: number } {
  const session = onSessionEvent(kind);
  const headset = onProfileSwitch(profile);
  if (headset.reopen) offered = [headset.rate, 16000];
  return { reopen: session.reopen || headset.reopen, rate: negotiateRate(offered) };
}

export function captureRate(): number {
  return negotiateRate(offered);
}
