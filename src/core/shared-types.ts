/** Types shared by the server and the UI. No imports, so the UI project can read this file without Node types. */

export interface PublicConnection {
  id: string;
  name: string;
  baseUrl: string;
  path: string;
  hasToken: boolean;
  createdAt: number;
}

export interface Employee {
  id: string;
  name: string;
  department: string | null;
  paused: boolean;
  /** false = the job has no queue to count yet ("chưa nối"). */
  queueKnown: boolean;
  counts: { pending: number; processing: number; failed: number; done: number } | null;
  waitingLock: boolean;
  lastFinishedAt: string | null;
  avgSeconds: number | null;
  failedRate: number | null;
}

export interface StaffSnapshot {
  generatedAt: string | null;
  employees: Employee[];
}

export type StaffResult = ({ ok: true; fetchedAt: number } & StaffSnapshot) | { ok: false; error: string; status?: number };

export interface TemplateInfo {
  id: "web" | "api" | "script" | "blank";
  title: string;
  summary: string;
  /** When to choose it (Vietnamese, shown in the form). */
  whenToUse: string;
}

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  /** This machine's tailnet name without the trailing dot, e.g. desktop-x.tail1234.ts.net. */
  dnsName: string | null;
}

export interface PhoneInfo extends TailscaleInfo {
  port: number;
  /** `https://<dnsName>` or null. */
  origin: string | null;
  /** `tailscale serve` already maps this app port. */
  serving: boolean;
  /** The origin is accepted by the server (Origin/Host checks). */
  allowed: boolean;
  /** Address to open on the phone, token included in the fragment (never sent to a server by the browser). */
  link: string | null;
}
