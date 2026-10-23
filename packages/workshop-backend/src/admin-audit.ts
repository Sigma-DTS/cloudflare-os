import {
  MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminAuditPage, type AdminAuditQuery, type AdminAuditRecord, type AdminAuditStats,
  type AdminAuditStatsQuery, type AdminVia,
} from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";
import {
  adminAuditStatsDays, adminListLimit, cutAdminAuditText, minAdminAuditRetentionDays,
} from "./admin-access.js";
import { utcDayKey } from "./ai-gateway-billing/limits/config.js";

const DAY_MS = 24 * 60 * 60_000;
// Rows older than the retention that one call deletes at most, so that a log left unused for long
// is trimmed over several calls rather than in one long write.
const PRUNE_BATCH = 1000;
// The longest admin or workspace filter list() takes; workspace ids are 64 characters.
const MAX_FILTER_LENGTH = 1000;
const TOP_LIMIT = 10;
// Every AdminVia, which list()'s via filter takes; typed to cover AdminVia exactly.
const ADMIN_VIAS: ReadonlySet<string> = new Set(Object.keys(
    { api: true, cli: true, gatekeeper: true } satisfies Record<AdminVia, true>));

type AuditRow = {
  seq: number;
  at: number;
  kind: string;
  admin: string;
  workspace_id: string | null;
  workspace_title: string | null;
  exposed: string | null;
  record: string;
};

/**
 * The deployment-wide admin audit log behind AdminApi.listAdminAudit() and getAdminAuditStats():
 * one row per AdminAuditRecord. An AdminAccessRecord is appended by the inspected workspace's
 * Overseer, once its call has read what it answers with and before that answer leaves, or by
 * AdminApiImpl before it refuses an open that never reached the workspace. An AdminSettingRecord is
 * appended by AdminSettings before its change takes effect. Always addressed as getByName("").
 * Callers pass the retention they read for the call; whatever they pass, a record is kept at least
 * minAdminAuditRetentionDays() days. Each method first deletes up to 1000 rows older than the
 * retention, and never lists or counts one.
 *
 * Schema (the integration suite installs a trigger on the table by this name). Each field of a
 * record is stored once: kind, at (epoch ms), admin and, for an access record, workspace_id,
 * workspace_title and exposed are columns; the rest of the record is JSON in `record`.
 *   admin_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
 *     kind TEXT NOT NULL CHECK (kind IN ('workspace', 'setting')), admin TEXT NOT NULL,
 *     workspace_id TEXT, workspace_title TEXT,
 *     exposed TEXT CHECK (exposed IN ('metadata', 'content')),
 *     record TEXT NOT NULL CHECK (json_valid(record)),
 *     CHECK ((kind = 'workspace') = (workspace_id IS NOT NULL AND workspace_title IS NOT NULL)),
 *     CHECK ((kind = 'workspace') = (exposed IS NOT NULL))) STRICT;
 *   indexes (at), (admin, seq), (workspace_id, seq), (kind, seq), (exposed, seq)
 */
export class AdminAuditDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    let sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('workspace', 'setting')),
      admin TEXT NOT NULL,
      workspace_id TEXT,
      workspace_title TEXT,
      exposed TEXT CHECK (exposed IN ('metadata', 'content')),
      record TEXT NOT NULL CHECK (json_valid(record)),
      CHECK ((kind = 'workspace') = (workspace_id IS NOT NULL AND workspace_title IS NOT NULL)),
      CHECK ((kind = 'workspace') = (exposed IS NOT NULL))
    ) STRICT`);
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at)");
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_admin ON admin_audit (admin, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_workspace ON admin_audit (workspace_id, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_kind ON admin_audit (kind, seq)");
    // Content reads are expected to be rare, so listing them reads only their rows.
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_exposed ON admin_audit (exposed, seq)");
  }

  /** Store one record. Throws when it cannot be stored, which fails the call or change it records.
   * An access record's workspaceTitle is stored cut by cutAdminAuditText() to
   * MAX_ADMIN_AUDIT_ARG_LENGTH whatever the caller sent: the one field a workspace member writes.
   * An access record without `exposed` fails the table's CHECK, so its append throws. */
  append(record: AdminAuditRecord, retentionDays: number): void {
    this.#prune(retentionDays);
    // Each field is stored once, in its column or in the JSON, never both: a title stored twice let
    // an over-long one overflow the row (the platform caps one at 8 MiB) and fail every append.
    let workspaceId: string | null = null;
    let workspaceTitle: string | null = null;
    let exposed: string | null = null;
    let rest: Record<string, unknown>;
    if (record.kind === "workspace") {
      let {
        kind: _kind, at: _at, admin: _admin, workspaceId: id, workspaceTitle: title,
        exposed: shown, ...fields
      } = record;
      workspaceId = id ?? null;
      exposed = shown ?? null;
      // Its callers cut it already, but a title has no length limit of its own and is the one field
      // of a record a workspace member writes, so the store holds the bound itself.
      workspaceTitle = typeof title === "string"
          ? cutAdminAuditText(title, MAX_ADMIN_AUDIT_ARG_LENGTH) : null;
      rest = fields;
    } else {
      let { kind: _kind, at: _at, admin: _admin, ...fields } = record;
      rest = fields;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO admin_audit (at, kind, admin, workspace_id, workspace_title, exposed, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.at.getTime(), record.kind, record.admin, workspaceId, workspaceTitle, exposed,
      JSON.stringify(rest));
  }

  /** One page, newest first (see AdminApi.listAdminAudit()), each record rebuilt from its columns
   * and JSON; `limit` is validated by the caller. Throws for a malformed cursor, a filter over 1000
   * characters, or a `via` other than "api", "cli" or "gatekeeper" (Durable Object RPC validates
   * nothing). */
  list(query: Omit<AdminAuditQuery, "limit"> & { limit: number }, retentionDays: number)
      : AdminAuditPage {
    let limit = adminListLimit(query.limit);
    let cutoff = this.#prune(retentionDays);
    for (let filter of [query.admin, query.workspace]) {
      if (filter !== undefined && filter.length > MAX_FILTER_LENGTH) {
        throw new TypeError(`Audit filters must be at most ${MAX_FILTER_LENGTH} characters.`);
      }
    }
    if (query.via !== undefined && !ADMIN_VIAS.has(query.via)) {
      throw new TypeError("The via filter must be \"api\", \"cli\" or \"gatekeeper\".");
    }

    let where = ["at >= ?"];
    let params: (string | number)[] = [cutoff];
    if (query.kind !== undefined) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.admin !== undefined) {
      where.push("admin = ?");
      params.push(query.admin);
    }
    if (query.workspace !== undefined) {
      where.push("workspace_id = ?");
      params.push(query.workspace);
    }
    if (query.exposed !== undefined) {
      where.push("exposed = ?");
      params.push(query.exposed);
    }
    if (query.via !== undefined) {
      // `via` lives in the JSON column (as does `origin`), read by SQLite's JSON functions.
      where.push("json_extract(record, '$.via') = ?");
      params.push(query.via);
    }
    if (query.since !== undefined) {
      let since = query.since.getTime();
      if (Number.isNaN(since)) throw new TypeError("Invalid since.");
      where.push("at >= ?");
      params.push(since);
    }
    if (query.cursor !== undefined) {
      let before = /^[0-9]+$/.test(query.cursor) ? Number(query.cursor) : NaN;
      if (!Number.isSafeInteger(before)) throw new TypeError("Invalid cursor.");
      where.push("seq < ?");
      params.push(before);
    }

    let rows = this.ctx.storage.sql.exec<AuditRow>(
      `SELECT seq, at, kind, admin, workspace_id, workspace_title, exposed, record FROM admin_audit
       WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      ...params, limit + 1).toArray();
    let page: AdminAuditPage = { records: rows.slice(0, limit).map(recordFromRow) };
    if (rows.length > limit) page.nextCursor = String(rows[limit - 1].seq);
    return page;
  }

  /** The counts getAdminAuditStats() reports for the last `days` UTC days of this object's clock.
   * The content reads are the access records whose `exposed` is "content", ranked by admin and by
   * workspace as the top lists are; each workspace in either list is titled with the newest
   * non-empty title any of its rows in the window carries. */
  stats(query: Pick<AdminAuditStatsQuery, "kind"> & { days: number }, retentionDays: number)
      : AdminAuditStats {
    let days = adminAuditStatsDays(query.days);
    let cutoff = this.#prune(retentionDays);
    let now = new Date();
    let start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        (days - 1) * DAY_MS;
    let from = Math.max(start, cutoff);
    let sql = this.ctx.storage.sql;

    let where = "at >= ?";
    let params: (string | number)[] = [from];
    if (query.kind !== undefined) {
      where += " AND kind = ?";
      params.push(query.kind);
    }

    let counts = new Map<number, number>();
    let totalEvents = 0;
    let contentReads = 0;
    // FILTER rather than SUM(exposed = 'content'), which a day of setting rows (exposed NULL) would
    // make NULL.
    type DayRow = { day: number; count: number; contentCount: number };
    for (let { day, count, contentCount } of sql.exec<DayRow>(
        `SELECT at / ${DAY_MS} AS day, COUNT(*) AS count,
           COUNT(*) FILTER (WHERE exposed = 'content') AS contentCount
         FROM admin_audit WHERE ${where} GROUP BY day`, ...params)) {
      counts.set(day, count);
      totalEvents += count;
      contentReads += contentCount;
    }
    let firstDay = start / DAY_MS;
    let byDay = Array.from({ length: days }, (_, i) => ({
      day: utcDayKey(new Date((firstDay + i) * DAY_MS)),
      count: counts.get(firstDay + i) ?? 0,
    }));

    // Only access records can be content reads or name a workspace, so the "setting" kind has none.
    let settings = query.kind === "setting";
    let content = "exposed = 'content'";
    return {
      days, totalEvents, byDay,
      topAdmins: this.#topAdmins(where, params),
      topWorkspaces: settings ? [] : this.#topWorkspaces(from),
      contentReads,
      topAdminsByContentReads: settings ? [] : this.#topAdmins(where, params, content),
      topWorkspacesByContentReads: settings ? [] : this.#topWorkspaces(from, content),
    };
  }

  // The admins with the most rows matching `where` (and `extra`, when given), most first.
  #topAdmins(where: string, params: (string | number)[], extra?: string)
      : { admin: string; count: number }[] {
    return this.ctx.storage.sql.exec<{ admin: string; count: number }>(
      `SELECT admin, COUNT(*) AS count FROM admin_audit
       WHERE ${where}${extra ? ` AND ${extra}` : ""}
       GROUP BY admin ORDER BY count DESC, admin ASC LIMIT ${TOP_LIMIT}`, ...params).toArray();
  }

  // The workspaces with the most access records since `from` (matching `extra`, when given), most
  // first, each titled from all of its rows since `from`, so that a title is found even when the
  // rows counted carry none.
  #topWorkspaces(from: number, extra?: string)
      : { workspaceId: string; title: string; count: number }[] {
    return this.ctx.storage.sql.exec<
        { workspaceId: string; title: string | null; count: number }>(
      `SELECT workspace_id AS workspaceId, COUNT(*) AS count,
         (SELECT newest.workspace_title FROM admin_audit AS newest
          WHERE newest.workspace_id = a.workspace_id AND newest.at >= ?
            AND newest.workspace_title != ''
          ORDER BY newest.at DESC, newest.seq DESC LIMIT 1) AS title
       FROM admin_audit AS a WHERE kind = 'workspace' AND at >= ?${extra ? ` AND ${extra}` : ""}
       GROUP BY workspace_id ORDER BY count DESC, workspace_id ASC LIMIT ${TOP_LIMIT}`,
      from, from).toArray().map(({ workspaceId, title, count }) =>
          ({ workspaceId, title: title ?? "", count }));
  }

  // Delete up to PRUNE_BATCH rows older than the retention and return the cutoff every read
  // filters on, so a row past it is never listed or counted even before it is deleted. The batch is
  // chosen in `at` order, which the admin_audit_at index (holding each row's seq) answers without
  // reading the table: ordered by seq it would scan every row on each call while none has expired,
  // the usual case. Rows are appended in about time order, so either order deletes the oldest.
  #prune(retentionDays: number): number {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
      throw new TypeError("The audit retention must be a whole number of days of at least 1.");
    }
    let effective = Math.max(retentionDays, minAdminAuditRetentionDays(this.env));
    let cutoff = Date.now() - effective * DAY_MS;
    this.ctx.storage.sql.exec(
      `DELETE FROM admin_audit WHERE seq IN
         (SELECT seq FROM admin_audit WHERE at < ? ORDER BY at, seq LIMIT ${PRUNE_BATCH})`,
      cutoff);
    return cutoff;
  }
}

function recordFromRow(row: AuditRow): AdminAuditRecord {
  let rest = JSON.parse(row.record) as Record<string, unknown>;
  let columns = row.kind === "workspace"
      ? { workspaceId: row.workspace_id, workspaceTitle: row.workspace_title, exposed: row.exposed }
      : {};
  return { ...rest, kind: row.kind, at: new Date(row.at), admin: row.admin, ...columns } as
      AdminAuditRecord;
}
