// Hemingway Bench Watcher
// 每天抓取 surgehq.ai 榜单，与 D1 中最近一次快照对比；
// 有变化则写入新快照并通过 Resend 发邮件，无变化则跳过。

const BENCH_URL = "https://surgehq.ai/benchmarks/hemingway-bench";

// ---------- 最小类型声明（避免引入额外依赖） ----------
interface D1Result<T> {
  results?: T[];
  success: boolean;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}
interface Env {
  hemingway_db: D1Database;
  RESEND_API_KEY: string;
  TRIGGER_SECRET: string;
  NOTIFY_EMAIL: string;
  FROM_EMAIL: string;
}

interface Row {
  rank: number;
  brand: string;
  model: string;
  score: number;
  low: number;
  high: number;
}

interface Snapshot {
  id: number;
  captured_at: string;
}

interface Entry {
  rank: number;
  brand: string;
  model: string;
  score: number;
  score_low: number;
  score_high: number;
}

interface Diff {
  added: Row[];
  removed: Entry[];
  changed: { model: string; field: string; oldV: string; newV: string }[];
}

interface CheckResult {
  status: "changed" | "unchanged" | "error";
  message: string;
  snapshotId?: number;
  emailSent?: boolean;
}

// ---------- 抓取与解析 ----------
async function fetchLeaderboard(): Promise<Row[]> {
  const res = await fetch(BENCH_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`抓取失败: HTTP ${res.status}`);

  const rows: Row[] = [];
  let cur: Row | null = null;
  let textBuf = "";
  let target: "rank" | "brand" | "model" | "score" | null = null;

  const finalizeText = () => {
    if (cur && target) {
      const v = textBuf.trim();
      if (target === "rank") cur.rank = parseInt(v, 10) || 0;
      else if (target === "score") cur.score = parseInt(v, 10) || 0;
      else if (target === "brand") cur.brand = v;
      else if (target === "model") cur.model = v;
    }
    target = null;
    textBuf = "";
  };

  const fieldHandler = (field: "rank" | "brand" | "model" | "score") => ({
    element() {
      finalizeText();
      target = field;
    },
    text(t: { text: string; lastInTextNode: boolean }) {
      textBuf += t.text;
      if (t.lastInTextNode) finalizeText();
    },
  });

  const rewriter = new HTMLRewriter()
    .on("div.lead-rank-table-list-row-wrap", {
      element() {
        finalizeText();
        cur = { rank: 0, brand: "", model: "", score: 0, low: 0, high: 0 };
        rows.push(cur);
      },
    })
    .on(".lead-rank-table-list-row-wrap div[fs-list-field=rank]", fieldHandler("rank"))
    .on(".lead-rank-table-list-row-wrap .head-rank-table-brand .txt", fieldHandler("brand"))
    .on(".lead-rank-table-list-row-wrap .head-rank-table-name .txt", fieldHandler("model"))
    .on(".lead-rank-table-list-row-wrap div[data-score]", fieldHandler("score"))
    .on(".lead-rank-table-list-row-wrap div[data-leaderboard-ci-lower]", {
      element(el: { getAttribute(n: string): string | null }) {
        if (cur) cur.low = parseInt(el.getAttribute("data-leaderboard-ci-lower") ?? "0", 10) || 0;
      },
    })
    .on(".lead-rank-table-list-row-wrap div[data-leaderboard-ci-upper]", {
      element(el: { getAttribute(n: string): string | null }) {
        if (cur) cur.high = parseInt(el.getAttribute("data-leaderboard-ci-upper") ?? "0", 10) || 0;
      },
    });

  // 消费响应流以驱动 HTMLRewriter 回调
  await rewriter.transform(res).arrayBuffer();

  const valid = rows.filter((r) => r.model && r.score > 0);
  if (valid.length < 40) {
    throw new Error(`解析结果异常：仅解析出 ${valid.length} 条有效条目（页面结构可能已改版）`);
  }
  return valid;
}

// ---------- 对比 ----------
function computeDiff(oldEntries: Entry[], newRows: Row[]): Diff {
  const key = (brand: string, model: string) => `${brand}||${model}`;
  const oldMap = new Map(oldEntries.map((e) => [key(e.brand, e.model), e]));
  const newMap = new Map(newRows.map((r) => [key(r.brand, r.model), r]));

  const diff: Diff = { added: [], removed: [], changed: [] };

  for (const row of newRows) {
    const k = key(row.brand, row.model);
    const old = oldMap.get(k);
    if (!old) {
      diff.added.push(row);
      continue;
    }
    if (old.rank !== row.rank) {
      diff.changed.push({ model: `${row.brand} ${row.model}`, field: "排名", oldV: `#${old.rank}`, newV: `#${row.rank}` });
    }
    if (old.score !== row.score) {
      diff.changed.push({ model: `${row.brand} ${row.model}`, field: "分数", oldV: String(old.score), newV: String(row.score) });
    }
    if (old.score_low !== row.low || old.score_high !== row.high) {
      diff.changed.push({
        model: `${row.brand} ${row.model}`,
        field: "置信区间",
        oldV: `${old.score_low}–${old.score_high}`,
        newV: `${row.low}–${row.high}`,
      });
    }
  }
  for (const e of oldEntries) {
    if (!newMap.has(key(e.brand, e.model))) diff.removed.push(e);
  }
  return diff;
}

function hasChanges(diff: Diff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

// ---------- 存储 ----------
async function saveSnapshot(db: D1Database, rows: Row[], capturedAt: string): Promise<number> {
  await db.prepare("INSERT INTO snapshots (captured_at) VALUES (?1)").bind(capturedAt).run();
  // D1 run() 不返回 last_row_id，改用查最大 id（单 Worker 串行写入场景下安全）
  const snap = await db.prepare("SELECT id FROM snapshots ORDER BY id DESC LIMIT 1").first<{ id: number }>();
  if (!snap) throw new Error("写入快照后无法取回 id");
  const snapshotId = snap.id;

  const stmt = db.prepare(
    "INSERT INTO entries (snapshot_id, rank, brand, model, score, score_low, score_high) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
  );
  const batch = rows.map((r) =>
    stmt.bind(snapshotId, r.rank, r.brand, r.model, r.score, r.low, r.high)
  );
  await db.batch(batch);
  return snapshotId;
}

async function getLatestSnapshot(db: D1Database): Promise<{ snapshot: Snapshot; entries: Entry[] } | null> {
  const snapshot = await db
    .prepare("SELECT id, captured_at FROM snapshots ORDER BY id DESC LIMIT 1")
    .first<Snapshot>();
  if (!snapshot) return null;
  const { results } = await db
    .prepare("SELECT rank, brand, model, score, score_low, score_high FROM entries WHERE snapshot_id = ?1")
    .bind(snapshot.id)
    .all<Entry>();
  return { snapshot, entries: results ?? [] };
}

// ---------- 邮件 ----------
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildEmailHtml(rows: Row[], diff: Diff, capturedAt: string, isBaseline: boolean): string {
  const th = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:13px;color:#555"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';

  function table(title: string, headers: string[], bodyRows: string[][]): string {
    if (bodyRows.length === 0) return "";
    return `
      <h3 style="margin:20px 0 8px;font-size:15px">${title}（${bodyRows.length}）</h3>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
        <tr>${headers.map((h) => `<th ${th}>${h}</th>`).join("")}</tr>
        ${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td ${td}>${escapeHtml(c)}</td>`).join("")}</tr>`)
          .join("")}
      </table>`;
  }

  const topTable = `
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
      <tr><th ${th}>排名</th><th ${th}>厂商</th><th ${th}>模型</th><th ${th}>分数</th><th ${th}>区间</th></tr>
      ${rows
        .slice(0, 10)
        .map(
          (r) =>
            `<tr><td ${td}>${r.rank}</td><td ${td}>${escapeHtml(r.brand)}</td><td ${td}>${escapeHtml(
              r.model
            )}</td><td ${td}>${r.score}</td><td ${td}>${r.low}–${r.high}</td></tr>`
        )
        .join("")}
    </table>`;

  const body = isBaseline
    ? `<p>已存储首份基线快照。当前榜单 Top 10：</p>${topTable}
       <p style="color:#888;font-size:12px">共 ${rows.length} 个模型。此后榜单有任何变化都会发邮件提醒你。</p>`
    : `<p>检测到榜单变化：</p>${topTable}
       ${table("🆕 新增模型", ["排名", "厂商", "模型", "分数"], diff.added.map((r) => [String(r.rank), r.brand, r.model, String(r.score)]))}
       ${table("❌ 移除模型", ["排名", "厂商", "模型", "分数"], diff.removed.map((e) => [String(e.rank), e.brand, e.model, String(e.score)]))}
       ${table("🔄 变动明细", ["模型", "字段", "旧值", "新值"], diff.changed.map((c) => [c.model, c.field, c.oldV, c.newV]))}`;

  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
    <h2 style="margin-bottom:4px">Hemingway Bench 榜单${isBaseline ? "基线已建立" : "变化提醒"}</h2>
    <p style="color:#888;font-size:12px;margin-top:0">抓取时间：${capturedAt}（UTC） ·
      <a href="https://surgehq.ai/benchmarks/hemingway-bench">查看原页面</a></p>
    ${body}
  </div>`;
}

async function sendEmail(env: Env, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [env.NOTIFY_EMAIL],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend 发信失败: HTTP ${res.status} ${detail}`);
  }
}

// ---------- 主流程 ----------
async function runCheck(env: Env, forceEmail = false): Promise<CheckResult> {
  const rows = await fetchLeaderboard();
  const capturedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const latest = await getLatestSnapshot(env.hemingway_db);

  if (latest) {
    const diff = computeDiff(latest.entries, rows);
    if (!hasChanges(diff)) {
      if (forceEmail) {
        await sendEmail(
          env,
          "Hemingway Bench 榜单无变化",
          buildEmailHtml(rows, diff, capturedAt, false)
        );
        return { status: "unchanged", message: "榜单无变化（已按 force 要求发送确认邮件）", emailSent: true };
      }
      return { status: "unchanged", message: "榜单无变化，未存储、未发信" };
    }
    const snapshotId = await saveSnapshot(env.hemingway_db, rows, capturedAt);
    const parts: string[] = [];
    if (diff.added.length) parts.push(`新增 ${diff.added.length}`);
    if (diff.removed.length) parts.push(`移除 ${diff.removed.length}`);
    if (diff.changed.length) parts.push(`变动 ${diff.changed.length} 项`);
    try {
      await sendEmail(env, `Hemingway Bench 榜单变化：${parts.join("，")}（${capturedAt}）`, buildEmailHtml(rows, diff, capturedAt, false));
    } catch (e) {
      // 存储已成功，发信失败仅记录，不阻断
      console.error("邮件发送失败（快照已保存）:", e instanceof Error ? e.message : e);
      return { status: "changed", message: `快照已保存（id=${snapshotId}），但邮件发送失败，详见日志`, snapshotId, emailSent: false };
    }
    return { status: "changed", message: `检测到变化：${parts.join("，")}`, snapshotId, emailSent: true };
  }

  // 首次运行：存基线
  const snapshotId = await saveSnapshot(env.hemingway_db, rows, capturedAt);
  try {
    await sendEmail(env, "Hemingway Bench 基线快照已建立", buildEmailHtml(rows, computeDiff([], []), capturedAt, true));
  } catch (e) {
    console.error("基线确认邮件发送失败:", e instanceof Error ? e.message : e);
    return { status: "changed", message: `基线快照已保存（id=${snapshotId}），但确认邮件发送失败`, snapshotId, emailSent: false };
  }
  return { status: "changed", message: `首次运行，基线快照已保存（id=${snapshotId}）`, snapshotId, emailSent: true };
}

export default {
  async scheduled(_event: unknown, env: Env): Promise<void> {
    try {
      await runCheck(env);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("定时任务执行失败:", msg);
      try {
        await sendEmail(
          env,
          "⚠️ Hemingway Bench 抓取失败告警",
          `<p>定时抓取执行出错，请检查：</p><pre style="background:#f5f5f5;padding:10px;font-size:12px">${escapeHtml(msg)}</pre>`
        );
      } catch (mailErr) {
        console.error("告警邮件发送失败:", mailErr instanceof Error ? mailErr.message : mailErr);
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (url.searchParams.get("key") !== env.TRIGGER_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const result = await runCheck(env, url.searchParams.has("force"));
        return Response.json(result);
      } catch (e) {
        return Response.json({ status: "error", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    return new Response("hemingway-bench-watcher is running");
  },
};
