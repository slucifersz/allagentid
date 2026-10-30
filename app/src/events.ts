// In-memory event feed that the dashboard streams over SSE.
import { EventEmitter } from "node:events";

export type EventKind = "a2a" | "mandate" | "check" | "sign" | "hsp" | "chain" | "deliver" | "reject" | "approval" | "passport" | "card" | "info";

export interface FeedEvent {
  id: number;
  at: string;
  kind: EventKind;
  jobId?: string;
  title: string;
  detail?: string;
  data?: unknown;
  txHash?: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);
const history: FeedEvent[] = [];
let seq = 0;

export function emit(e: Omit<FeedEvent, "id" | "at">) {
  const ev: FeedEvent = { id: ++seq, at: new Date().toISOString(), ...e };
  history.push(ev);
  if (history.length > 500) history.shift();
  bus.emit("event", ev);
  return ev;
}

export const recentEvents = () => history.slice(-200);
export const onEvent = (fn: (e: FeedEvent) => void) => {
  bus.on("event", fn);
  return () => bus.off("event", fn);
};
