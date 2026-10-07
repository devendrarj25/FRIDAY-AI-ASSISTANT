/**
 * FRIDAY · tools/devices
 *
 * Real capability source for the device-control tools (cable / Bluetooth /
 * same-WiFi). Each category is its own manifest folder on disk, so the UI and
 * the Core Brain see exactly what is installed — no hardcoded entries.
 */
import {
  capabilities,
  createTreeSource,
  type CapabilityEntry,
  type TreeSourceModule,
} from "../../core/discovery";
import type { ModuleContext } from "../../core/types";

export const androidDevicesModule: TreeSourceModule = createTreeSource("tools", "devices/android");
export const bluetoothDevicesModule: TreeSourceModule = createTreeSource(
  "tools",
  "devices/bluetooth",
);
export const networkDevicesModule: TreeSourceModule = createTreeSource("tools", "devices/network");

/** Current on-disk entries for every device category. */
export const listToolsDevices = (): CapabilityEntry[] => [
  ...androidDevicesModule.scan(),
  ...bluetoothDevicesModule.scan(),
  ...networkDevicesModule.scan(),
];

/** Re-scan after a manifest was added or removed. */
export const refreshToolsDevices = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  for (const segment of ["devices/android", "devices/bluetooth", "devices/network"]) {
    capabilities.refresh(`tools/${segment}`);
  }
  return listToolsDevices();
};

export default androidDevicesModule;
