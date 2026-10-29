import { useSyncExternalStore } from "react";
import { doctor, type DoctorState } from "./doctor-engine";

export function useDoctor(): DoctorState {
  return useSyncExternalStore(doctor.subscribe, doctor.getSnapshot, doctor.getSnapshot);
}
