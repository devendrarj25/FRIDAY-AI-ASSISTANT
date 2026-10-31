import { describe, expect, it } from "vitest";
import { pickControl } from "../../src/lib/friday/self/ui-target";
import type { DeskControl } from "../../src/lib/friday/self/computer-use";

const c = (
  name: string,
  role: DeskControl["role"] = "button",
  more: Partial<DeskControl> = {},
): DeskControl => ({
  id: name,
  role,
  name,
  value: "",
  bounds: { x: 0, y: 0, w: 10, h: 10 },
  ...more,
});

// Recorded shapes of common windows, reduced to names and roles.
const settings = [
  c("Search settings", "edit"),
  c("Network & internet"),
  c("Bluetooth & devices"),
  c("Personalisation"),
  c("Apps"),
];
const browser = [
  c("Address and search bar", "edit"),
  c("Back"),
  c("Forward"),
  c("Reload"),
  c("Bookmarks"),
  c("Bookmark this tab"),
];
const dialog = [c("OK"), c("Cancel"), c("Apply"), c("Help")];

describe("control picking on recorded trees", () => {
  it("takes an exact name", () => {
    expect(pickControl(dialog, "cancel").control?.name).toBe("Cancel");
  });

  it("takes a clear partial match", () => {
    expect(pickControl(settings, "bluetooth").control?.name).toBe("Bluetooth & devices");
    expect(pickControl(browser, "address bar").control?.name).toBe("Address and search bar");
  });

  it("reads a plural as the same word", () => {
    expect(pickControl(browser, "bookmark").control?.name).toBe("Bookmarks");
  });

  it("refuses a near tie instead of guessing", () => {
    const pick = pickControl([c("Open file"), c("Open folder"), c("Close")], "open");
    expect(pick.control).toBeNull();
    expect(pick.reason).toBe("ambiguous");
    expect(pick.alternatives).toContain("Open folder");
  });

  it("never offers a credential, payment, captcha or secure-desktop control", () => {
    for (const role of ["password", "payment", "captcha", "uac"] as const) {
      expect(pickControl([c("Confirm", role)], "Confirm").control).toBeNull();
    }
  });

  it("skips a disabled control and finds nothing for an unrelated name", () => {
    expect(pickControl([c("Apply", "button", { enabled: false })], "Apply").control).toBeNull();
    expect(pickControl(dialog, "format the disk").reason).toBe("no-match");
  });

  it("looks inside nested controls", () => {
    const tree = [c("Toolbar", "text", { children: [c("Reload")] })];
    expect(pickControl(tree, "reload").control?.name).toBe("Reload");
  });

  it("prefers the requested role when two controls share a name", () => {
    const both = [c("Search", "edit"), c("Search", "button")];
    expect(pickControl(both, "Search", "button").control?.role).toBe("button");
  });
});
