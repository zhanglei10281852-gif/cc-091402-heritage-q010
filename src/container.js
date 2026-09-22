import { JsonStore } from "./store/jsonStore.js";
import { createInitialState } from "./data/seed.js";
import { NotificationService } from "./services/notificationService.js";
import { AuditService } from "./services/auditService.js";
import { ReservationService } from "./services/reservationService.js";

export function createContainer({ stateFile, clock, now } = {}) {
  const store = new JsonStore(stateFile ?? null, () => createInitialState(now ? new Date(now) : undefined));
  const audit = new AuditService(store, clock);
  const notifications = new NotificationService(store, clock, audit);
  const reservations = new ReservationService(store, notifications, audit, clock);
  return { store, notifications, audit, reservations };
}
