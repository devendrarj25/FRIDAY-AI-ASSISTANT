/**
 * FRIDAY · read-only Setup & Doctor observation
 *
 * Core Brain only reads the live Doctor session the owner (or FRIDAY) already
 * produced. It never opens a second probe. The store stays `doctor-engine.ts`.
 * Bare “what's wrong” stays inspectSelf — this LOOK is the Doctor page.
 */

import { formatDoctorExtra, doctorSnapshot, type DoctorSession } from "../doctor-awareness";
import { isProblem, isWarning } from "../doctor-engine";

const LOOK =
  /\b(look at (the |my )?(setup( and)? )?doctor|setup (and |& )?doctor|what(?:'s| is) on (the |my )?doctor|doctor (page|scan|report|log|checks?|session)|run (a )?(quick |deep )?doctor|quick doctor|deep doctor|auto diagnose|fix all safe|what did the doctor find|show (me )?(the )?doctor|scan now)\b/i;

export function doctorLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

export function shouldAttachDoctorExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return doctorLookRequested(text);
}

export type DoctorObservation = {
  readOnly: true;
  spawned: false;
  scanning: boolean;
  summary: string;
  extra: string;
};

export function observationFromDoctor(snap: DoctorSession): DoctorObservation {
  const problems = snap.checks.filter((check) => isProblem(check.status)).length;
  const warnings = snap.checks.filter((check) => isWarning(check.status)).length;
  let summary: string;
  if (snap.scanning) {
    summary = `doctor ${snap.mode} scan in flight · ${snap.checks.length} checks`;
  } else if (!snap.checks.length) {
    summary = "doctor idle — no scan has run yet";
  } else {
    summary = `doctor ${snap.checks.length} checks · ${problems} problem(s) · ${warnings} warning(s)`;
  }
  return {
    readOnly: true,
    spawned: false,
    scanning: snap.scanning,
    summary,
    extra: formatDoctorExtra(),
  };
}

export function observeDoctorState(): DoctorObservation {
  return observationFromDoctor(doctorSnapshot());
}
