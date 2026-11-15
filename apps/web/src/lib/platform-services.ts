import * as admin from "@live-competition-engine/db/platform-admin";
import type { PlatformAdminDeps } from "../app/api/platform/tenants/handler";
import { authService } from "./services";

/** Postgres-backed wiring for LC-53 platform super-admin handlers. */
export const platformAdminDeps: PlatformAdminDeps = {
  stepUpWithRecoveryCode: admin.stepUpWithRecoveryCode,
  stepUpWithFreshSession: admin.stepUpWithFreshSession,
  revokeStepUp: admin.revokeStepUp,
  listTenants: admin.listTenants,
  getTenantDetail: admin.getTenantDetail,
  changeTenantLifecycle: admin.changeTenantLifecycle,
  addSupportNote: admin.addSupportNote,
  listSupportNotes: admin.listSupportNotes,
  raiseFraudFlag: admin.raiseFraudFlag,
  resolveFraudFlag: admin.resolveFraudFlag,
  listFraudFlags: admin.listFraudFlags,
  createAnnouncement: admin.createAnnouncement,
  addAnnouncementVersion: admin.addAnnouncementVersion,
  publishAnnouncementVersion: admin.publishAnnouncementVersion,
  withdrawAnnouncement: admin.withdrawAnnouncement,
  listAnnouncements: admin.listAnnouncements,
  listTenantAnnouncements: admin.listTenantAnnouncements,
  platformAudit: admin.platformAudit
};

export { authService };
