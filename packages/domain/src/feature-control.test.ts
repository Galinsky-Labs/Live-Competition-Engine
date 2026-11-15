import { describe, expect, it } from "vitest";
import { assertTenantWriteAllowed, effectiveFeatureView } from "./feature-control";

describe("feature control view", () => {
  it("requires platform enablement, honours ceilings and tenant vetoes", () => {
    const view = effectiveFeatureView(
      ["chat", "voting", "polls", "cms"],
      [{ feature: "chat", enabled: true, revision: 2 }, { feature: "voting", enabled: true, revision: 1 }, { feature: "polls", enabled: true, revision: 1 }],
      [{ feature: "voting", enabled: false, revision: 3 }, { feature: "polls", enabled: true, revision: 1 }],
      [{ feature: "polls", locked: true, revision: 1, reason: "abuse" }]
    );
    expect(view.map(row => [row.feature, row.enabled, row.controlledBy])).toEqual([
      ["chat", true, "platform"],
      ["voting", false, "tenant"],
      ["polls", false, "ceiling"],
      ["cms", false, "platform"]
    ]);
    expect(view[2]!.tenantMayEnable).toBe(false);
    expect(view[1]!.tenant.revision).toBe(3);
  });

  it("refuses tenant enablement under a lock but allows disabling", () => {
    expect(() => assertTenantWriteAllowed(true, true)).toThrow("feature_locked_by_platform");
    expect(() => assertTenantWriteAllowed(false, true)).not.toThrow();
    expect(() => assertTenantWriteAllowed(true, false)).not.toThrow();
  });
});
