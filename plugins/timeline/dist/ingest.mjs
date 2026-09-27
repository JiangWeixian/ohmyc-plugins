#!/usr/bin/env node

// ../../node_modules/.bun/@ohmyc+timeline@+Users+bytedance+Projects+oss+ohmyc-plugins+.superpowers+sdd+2026-09-12-cursor-grok-timeline+artifacts+contention-4948865+ohmyc-timeline-0.1.0.tgz/node_modules/@ohmyc/timeline/dist/chunk-4KVEEB7P.js
var CURRENT_SCHEMA_VERSION = 4;
var SCHEMA_SQL = `
CREATE TABLE sessions (
  session_id        TEXT PRIMARY KEY,
  project           TEXT NOT NULL,
  agent_name        TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  turns             INTEGER NOT NULL,
  tokens_input      INTEGER NOT NULL DEFAULT 0,
  tokens_output     INTEGER NOT NULL DEFAULT 0,
  tokens_cached     INTEGER NOT NULL DEFAULT 0,
  summary           TEXT,
  summary_source    TEXT NOT NULL,
  transcript_path   TEXT NOT NULL,
  last_offset       INTEGER NOT NULL,
  ingested_at       INTEGER NOT NULL,
  model             TEXT,
  token_status      TEXT NOT NULL DEFAULT 'legacy'
                    CHECK (token_status IN ('legacy', 'complete', 'partial', 'unavailable'))
);

CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX idx_sessions_project    ON sessions(project, started_at DESC);

CREATE TABLE session_tools (
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,
  call_count  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, tool_name)
);

CREATE TABLE session_skills (
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  skill_name  TEXT NOT NULL,
  PRIMARY KEY (session_id, skill_name)
);

CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;
var MIGRATIONS = {
  1: "",
  2: "ALTER TABLE sessions ADD COLUMN model TEXT;",
  3: "ALTER TABLE sessions ADD COLUMN agent_name TEXT;",
  4: `ALTER TABLE sessions ADD COLUMN token_status TEXT NOT NULL DEFAULT 'legacy'
    CHECK (token_status IN ('legacy', 'complete', 'partial', 'unavailable'));`
};

// ../../node_modules/.bun/@ohmyc+timeline@+Users+bytedance+Projects+oss+ohmyc-plugins+.superpowers+sdd+2026-09-12-cursor-grok-timeline+artifacts+contention-4948865+ohmyc-timeline-0.1.0.tgz/node_modules/@ohmyc/timeline/dist/chunk-AQLGXPYT.js
function ensureTokenStatus(db) {
  const hasColumn = () => db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "token_status");
  if (hasColumn()) {
    return;
  }
  const { timeout } = db.prepare("PRAGMA busy_timeout").get();
  db.exec("PRAGMA busy_timeout = 1000");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasColumn()) {
        db.exec(MIGRATIONS[4]);
      }
      db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version' AND value = '3'").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
  }
}
function createWriter(db) {
  ensureTokenStatus(db);
  const checkExisting = db.prepare("SELECT 1 FROM sessions WHERE session_id = ?");
  const upsertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      session_id, project, agent_name, started_at, ended_at, duration_ms,
      turns, tokens_input, tokens_output, tokens_cached,
      summary, summary_source, transcript_path, last_offset, ingested_at, model,
      token_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteTools = db.prepare("DELETE FROM session_tools WHERE session_id = ?");
  const insertTool = db.prepare("INSERT OR REPLACE INTO session_tools (session_id, tool_name, call_count) VALUES (?, ?, ?)");
  const deleteSkills = db.prepare("DELETE FROM session_skills WHERE session_id = ?");
  const insertSkill = db.prepare("INSERT OR REPLACE INTO session_skills (session_id, skill_name) VALUES (?, ?)");
  return {
    writeSession(data) {
      const existingRow = checkExisting.get(data.sessionId);
      const sessionsInserted = existingRow ? 0 : 1;
      const sessionsUpdated = existingRow ? 1 : 0;
      const ingestedAt = Date.now();
      const transaction = db.transaction(() => {
        upsertSession.run(
          data.sessionId,
          data.project,
          data.agentName,
          data.startedAt,
          data.endedAt,
          data.durationMs,
          data.turns,
          data.tokensInput,
          data.tokensOutput,
          data.tokensCached,
          data.summary,
          data.summarySource,
          data.transcriptPath,
          data.fileSize,
          ingestedAt,
          data.model,
          data.tokenStatus ?? "legacy"
        );
        deleteTools.run(data.sessionId);
        for (const tool of data.tools) {
          insertTool.run(data.sessionId, tool.toolName, tool.callCount);
        }
        deleteSkills.run(data.sessionId);
        for (const skillName of data.skills) {
          insertSkill.run(data.sessionId, skillName);
        }
      });
      transaction();
      return {
        sessionId: data.sessionId,
        project: data.project,
        sessionsInserted,
        sessionsUpdated
      };
    }
  };
}

// ../../node_modules/.bun/@ohmyc+timeline@+Users+bytedance+Projects+oss+ohmyc-plugins+.superpowers+sdd+2026-09-12-cursor-grok-timeline+artifacts+contention-4948865+ohmyc-timeline-0.1.0.tgz/node_modules/@ohmyc/timeline/dist/chunk-GUF2QBYS.js
import { readFileSync, statSync } from "fs";
import os from "os";
import path from "path";
function parseTranscript(sessionId, transcriptPath, options) {
  const agentName = options?.agentName ?? "claude";
  if (agentName === "codex") {
    return parseCodexTranscript(sessionId, transcriptPath);
  }
  const fileStat = statSync(transcriptPath);
  const fileSize = fileStat.size;
  const buffer = readFileSync(transcriptPath);
  const content = buffer.toString("utf8");
  const lines = content.split("\n");
  let firstTimestamp = null;
  let lastTimestamp = null;
  let turns = 0;
  let firstUserMessage = null;
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCached = 0;
  const toolCounts = /* @__PURE__ */ new Map();
  const skills = /* @__PURE__ */ new Set();
  let summary = null;
  let summarySource = "first_message";
  let model = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error(`Malformed JSON line in ${transcriptPath}: ${trimmed.slice(0, 200)}`);
      continue;
    }
    const timestamp2 = parsed.timestamp;
    if (typeof timestamp2 === "string") {
      const ts = new Date(timestamp2).getTime();
      if (!Number.isNaN(ts)) {
        if (firstTimestamp === null || ts < firstTimestamp) {
          firstTimestamp = ts;
        }
        if (lastTimestamp === null || ts > lastTimestamp) {
          lastTimestamp = ts;
        }
      }
    }
    const type = parsed.type;
    if (type === "user") {
      const message = parsed.message;
      if (message?.role === "user") {
        const content2 = message.content;
        if (typeof content2 === "string") {
          turns++;
          if (firstUserMessage === null) {
            firstUserMessage = content2;
          }
        }
      }
    }
    if (type === "assistant") {
      const message = parsed.message;
      if (message?.role === "assistant") {
        if (typeof message.model === "string") {
          model = message.model;
        }
        const usage = message.usage;
        if (usage) {
          const iterations = usage.iterations;
          if (iterations && iterations.length > 0) {
            for (const iter of iterations) {
              tokensInput += Number(iter.input_tokens) || 0;
              tokensOutput += Number(iter.output_tokens) || 0;
            }
            const lastIter = iterations.at(-1);
            if (lastIter) {
              tokensCached = Number(lastIter.cache_read_input_tokens) || 0;
              tokensCached += Number(lastIter.cache_creation_input_tokens) || 0;
            }
          } else {
            tokensInput += Number(usage.input_tokens) || 0;
            tokensOutput += Number(usage.output_tokens) || 0;
            tokensCached = Number(usage.cache_read_input_tokens) || 0;
            tokensCached += Number(usage.cache_creation_input_tokens) || 0;
          }
        }
        const content2 = message.content;
        if (Array.isArray(content2)) {
          for (const block of content2) {
            if (block.type === "tool_use" && typeof block.name === "string") {
              const toolName = block.name;
              toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
              if (toolName === "Skill") {
                const input = block.input;
                if (typeof input?.skill === "string") {
                  skills.add(input.skill);
                }
              }
            }
          }
        }
      }
    }
    if (type === "system") {
      const subtype = parsed.subtype;
      if (subtype === "away_summary" && typeof parsed.content === "string") {
        summary = parsed.content;
        summarySource = "auto";
      }
    }
  }
  if (summary === null && firstUserMessage !== null) {
    summary = truncateSummary(firstUserMessage);
  }
  if (summary === null) {
    summary = "(untitled session)";
  }
  const project2 = extractProjectFromPath(transcriptPath);
  const startedAt = firstTimestamp ?? Date.now();
  const endedAt = lastTimestamp ?? Date.now();
  const durationMs = endedAt - startedAt;
  return {
    sessionId,
    project: project2,
    agentName,
    startedAt,
    endedAt,
    durationMs,
    turns,
    tokensInput,
    tokensOutput,
    tokensCached,
    summary,
    summarySource,
    transcriptPath,
    fileSize,
    tools: [...toolCounts.entries()].map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...skills],
    model
  };
}
function parseCodexTranscript(sessionId, transcriptPath) {
  const fileStat = statSync(transcriptPath);
  const fileSize = fileStat.size;
  const lines = readFileSync(transcriptPath, "utf8").split("\n");
  let firstTimestamp = null;
  let lastTimestamp = null;
  let project2 = "unknown";
  let model = null;
  let firstUserMessage = null;
  let turns = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCached = 0;
  const toolCounts = /* @__PURE__ */ new Map();
  const skills = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error(`Malformed JSON line in ${transcriptPath}: ${trimmed.slice(0, 200)}`);
      continue;
    }
    const timestamp2 = parsed.timestamp;
    if (typeof timestamp2 === "string") {
      const ts = new Date(timestamp2).getTime();
      if (!Number.isNaN(ts)) {
        firstTimestamp = firstTimestamp === null ? ts : Math.min(firstTimestamp, ts);
        lastTimestamp = lastTimestamp === null ? ts : Math.max(lastTimestamp, ts);
      }
    }
    if (parsed.type === "turn.completed") {
      const usage = extractCodexTokenUsage(parsed.usage);
      if (usage) {
        tokensInput = usage.input ?? tokensInput;
        tokensOutput = usage.output ?? tokensOutput;
        tokensCached = usage.cached ?? tokensCached;
      }
    }
    const payload = parsed.payload;
    if (!payload) {
      continue;
    }
    if (parsed.type === "session_meta" && typeof payload.cwd === "string") {
      project2 = payload.cwd;
    }
    if (parsed.type === "turn_context") {
      if (typeof payload.cwd === "string") {
        project2 = payload.cwd;
      }
      if (typeof payload.model === "string") {
        model = payload.model;
      }
    }
    if (parsed.type === "event_msg" && payload.type === "token_count") {
      const usage = extractCodexTokenUsage(payload.info);
      if (usage) {
        tokensInput = usage.input ?? tokensInput;
        tokensOutput = usage.output ?? tokensOutput;
        tokensCached = usage.cached ?? tokensCached;
      }
    }
    if (parsed.type !== "response_item") {
      continue;
    }
    if (payload.type === "message" && payload.role === "user") {
      const text4 = extractCodexMessageText(payload.content);
      if (text4) {
        for (const skillName of extractCodexSkillNames(text4)) {
          skills.add(skillName);
        }
        if (!isCodexSkillInjection(text4)) {
          turns++;
          firstUserMessage ??= text4;
        }
      }
    }
    if (payload.type === "function_call" && typeof payload.name === "string") {
      const toolName = payload.name;
      toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
      if (toolName === "exec_command" || toolName === "functions.exec_command") {
        const skillName = extractCodexSkillNameFromCommandArguments(payload.arguments);
        if (skillName) {
          skills.add(skillName);
        }
      }
    }
  }
  const summary = firstUserMessage ? truncateSummary(firstUserMessage) : "(untitled session)";
  const startedAt = firstTimestamp ?? Date.now();
  const endedAt = lastTimestamp ?? Date.now();
  return {
    sessionId,
    project: displayProject(project2),
    agentName: "codex",
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    turns,
    tokensInput,
    tokensOutput,
    tokensCached,
    summary,
    summarySource: firstUserMessage ? "first_message" : "auto",
    transcriptPath,
    fileSize,
    tools: [...toolCounts.entries()].map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...skills],
    model
  };
}
function extractCodexTokenUsage(value) {
  if (!isRecord(value)) {
    return null;
  }
  let candidate = null;
  if (isRecord(value.total_token_usage)) {
    candidate = value.total_token_usage;
  } else if (hasCodexTokenFields(value)) {
    candidate = value;
  } else if (isRecord(value.last_token_usage)) {
    candidate = value.last_token_usage;
  }
  if (!candidate) {
    return null;
  }
  const usage = {};
  const input = numberValue(candidate.input_tokens);
  const output = numberValue(candidate.output_tokens);
  const cached = numberValue(candidate.cached_input_tokens);
  if (input !== null) {
    usage.input = input;
  }
  if (output !== null) {
    usage.output = output;
  }
  if (cached !== null) {
    usage.cached = cached;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}
function hasCodexTokenFields(value) {
  return "input_tokens" in value || "output_tokens" in value || "cached_input_tokens" in value;
}
function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function extractCodexMessageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text4 = content.map((part) => {
    if (!part || typeof part !== "object") {
      return "";
    }
    const record = part;
    if (typeof record.text === "string") {
      return record.text;
    }
    return "";
  }).filter(Boolean).join("\n").trim();
  return text4 || null;
}
function extractCodexSkillNames(text4) {
  return [...text4.matchAll(/<skill\b[^>]*>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/skill>/g)].map((match) => match[1]?.trim()).filter(Boolean);
}
function isCodexSkillInjection(text4) {
  const trimmed = text4.trim();
  return trimmed.startsWith("<skill>") && trimmed.endsWith("</skill>") && extractCodexSkillNames(trimmed).length > 0;
}
function extractCodexSkillNameFromCommandArguments(argumentsValue) {
  if (typeof argumentsValue !== "string") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(argumentsValue);
  } catch {
    return null;
  }
  if (typeof parsed.cmd !== "string") {
    return null;
  }
  const match = parsed.cmd.match(/(?:^|[\s"'])\S*\/skills\/([^/\s"']+)\/SKILL\.md(?:[\s"']|$)/);
  return match?.[1] ?? null;
}
function truncateSummary(value) {
  return value.length > 140 ? value.slice(0, 140) : value;
}
function displayProject(project2) {
  const homeDir = os.homedir();
  if (project2.startsWith(homeDir)) {
    return `~${project2.slice(homeDir.length)}`;
  }
  return project2;
}
function decodeProjectName(encodedName) {
  if (encodedName.startsWith("-")) {
    return `/${encodedName.slice(1).replaceAll("-", "/")}`;
  }
  return encodedName.replaceAll("-", "/");
}
function extractProjectFromPath(transcriptPath) {
  const parts = transcriptPath.split(path.sep);
  const projectsIndex = parts.indexOf("projects");
  if (projectsIndex !== -1 && projectsIndex + 1 < parts.length) {
    const encodedName = parts[projectsIndex + 1];
    const absolutePath = decodeProjectName(encodedName);
    const homeDir = os.homedir();
    if (absolutePath.startsWith(homeDir)) {
      return `~${absolutePath.slice(homeDir.length)}`;
    }
    return absolutePath;
  }
  return "unknown";
}

// ../../node_modules/.bun/@ohmyc+timeline@+Users+bytedance+Projects+oss+ohmyc-plugins+.superpowers+sdd+2026-09-12-cursor-grok-timeline+artifacts+contention-4948865+ohmyc-timeline-0.1.0.tgz/node_modules/@ohmyc/timeline/dist/chunk-WK4NZMZ4.js
function migrate(db, options) {
  const targetVersion = options?.currentSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  const migrations = options?.migrations ?? MIGRATIONS;
  const metaTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!metaTable) {
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(targetVersion));
    return;
  }
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let currentVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 0;
  if (Number.isNaN(currentVersion)) {
    currentVersion = 0;
  }
  if (currentVersion === 0) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(targetVersion));
    return;
  }
  const applyMigrations = db.transaction(() => {
    while (currentVersion < targetVersion) {
      const nextVersion = currentVersion + 1;
      const migrationSql = migrations[nextVersion];
      if (migrationSql === void 0) {
        throw new Error(`Missing migration for version ${nextVersion}`);
      }
      if (migrationSql) {
        try {
          db.exec(migrationSql);
        } catch (error) {
          if (!/duplicate column name/i.test(error?.message ?? "")) {
            throw error;
          }
        }
      }
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(nextVersion));
      currentVersion = nextVersion;
    }
  });
  applyMigrations();
}

// ../../node_modules/.bun/@ohmyc+timeline@+Users+bytedance+Projects+oss+ohmyc-plugins+.superpowers+sdd+2026-09-12-cursor-grok-timeline+artifacts+contention-4948865+ohmyc-timeline-0.1.0.tgz/node_modules/@ohmyc/timeline/dist/chunk-3K3NWBLL.js
function openNodeSqliteDatabase(dbPath) {
  let nativeDb;
  try {
    const { DatabaseSync } = loadNodeSqliteModule();
    nativeDb = new DatabaseSync(dbPath);
  } catch (error) {
    if (isMissingNodeSqlite(error)) {
      throw new Error("Timeline requires Node 22+ because it uses node:sqlite");
    }
    throw error;
  }
  return wrapNodeSqlite(nativeDb);
}
function loadNodeSqliteModule() {
  const module = process.getBuiltinModule?.(`node:${"sqlite"}`);
  if (!module) {
    throw new Error("Timeline requires Node 22+ because it uses node:sqlite");
  }
  return module;
}
function wrapNodeSqlite(nativeDb) {
  return {
    exec: (sql) => nativeDb.exec(sql),
    prepare: (sql) => {
      const statement = nativeDb.prepare(sql);
      return {
        run: (...params) => {
          statement.run(...params);
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params)
      };
    },
    transaction: (fn) => () => {
      nativeDb.exec("BEGIN IMMEDIATE");
      try {
        fn();
        nativeDb.exec("COMMIT");
      } catch (error) {
        nativeDb.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => nativeDb.close()
  };
}
function isMissingNodeSqlite(error) {
  return error instanceof Error && (error.message.includes("node:sqlite") || error.message.includes("No such built-in module") || error.message.includes("Unknown built-in module"));
}

// ../../node_modules/.bun/@ohmyc+timeline@+Users+bytedance+Projects+oss+ohmyc-plugins+.superpowers+sdd+2026-09-12-cursor-grok-timeline+artifacts+contention-4948865+ohmyc-timeline-0.1.0.tgz/node_modules/@ohmyc/timeline/dist/index.js
import { mkdirSync } from "fs";
import os2 from "os";
import path2 from "path";
function getDefaultDbPath() {
  const home = process.env.OHMYC_HOME || path2.join(os2.homedir(), ".config", "ohmyc");
  return path2.join(home, "timeline.db");
}
function openDatabase(options) {
  const dbPath = options?.dbPath ?? getDefaultDbPath();
  const dbDir = path2.dirname(dbPath);
  mkdirSync(dbDir, { recursive: true });
  const db = openNodeSqliteDatabase(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
function closeDatabase(db) {
  db.close();
}

// ../../node_modules/.bun/cac@6.7.14/node_modules/cac/dist/index.mjs
import { EventEmitter } from "events";
function toArr(any) {
  return any == null ? [] : Array.isArray(any) ? any : [any];
}
function toVal(out, key, val, opts) {
  var x, old = out[key], nxt = !!~opts.string.indexOf(key) ? val == null || val === true ? "" : String(val) : typeof val === "boolean" ? val : !!~opts.boolean.indexOf(key) ? val === "false" ? false : val === "true" || (out._.push((x = +val, x * 0 === 0) ? x : val), !!val) : (x = +val, x * 0 === 0) ? x : val;
  out[key] = old == null ? nxt : Array.isArray(old) ? old.concat(nxt) : [old, nxt];
}
function mri2(args, opts) {
  args = args || [];
  opts = opts || {};
  var k, arr, arg, name, val, out = { _: [] };
  var i = 0, j = 0, idx = 0, len = args.length;
  const alibi = opts.alias !== void 0;
  const strict = opts.unknown !== void 0;
  const defaults = opts.default !== void 0;
  opts.alias = opts.alias || {};
  opts.string = toArr(opts.string);
  opts.boolean = toArr(opts.boolean);
  if (alibi) {
    for (k in opts.alias) {
      arr = opts.alias[k] = toArr(opts.alias[k]);
      for (i = 0; i < arr.length; i++) {
        (opts.alias[arr[i]] = arr.concat(k)).splice(i, 1);
      }
    }
  }
  for (i = opts.boolean.length; i-- > 0; ) {
    arr = opts.alias[opts.boolean[i]] || [];
    for (j = arr.length; j-- > 0; ) opts.boolean.push(arr[j]);
  }
  for (i = opts.string.length; i-- > 0; ) {
    arr = opts.alias[opts.string[i]] || [];
    for (j = arr.length; j-- > 0; ) opts.string.push(arr[j]);
  }
  if (defaults) {
    for (k in opts.default) {
      name = typeof opts.default[k];
      arr = opts.alias[k] = opts.alias[k] || [];
      if (opts[name] !== void 0) {
        opts[name].push(k);
        for (i = 0; i < arr.length; i++) {
          opts[name].push(arr[i]);
        }
      }
    }
  }
  const keys = strict ? Object.keys(opts.alias) : [];
  for (i = 0; i < len; i++) {
    arg = args[i];
    if (arg === "--") {
      out._ = out._.concat(args.slice(++i));
      break;
    }
    for (j = 0; j < arg.length; j++) {
      if (arg.charCodeAt(j) !== 45) break;
    }
    if (j === 0) {
      out._.push(arg);
    } else if (arg.substring(j, j + 3) === "no-") {
      name = arg.substring(j + 3);
      if (strict && !~keys.indexOf(name)) {
        return opts.unknown(arg);
      }
      out[name] = false;
    } else {
      for (idx = j + 1; idx < arg.length; idx++) {
        if (arg.charCodeAt(idx) === 61) break;
      }
      name = arg.substring(j, idx);
      val = arg.substring(++idx) || (i + 1 === len || ("" + args[i + 1]).charCodeAt(0) === 45 || args[++i]);
      arr = j === 2 ? [name] : name;
      for (idx = 0; idx < arr.length; idx++) {
        name = arr[idx];
        if (strict && !~keys.indexOf(name)) return opts.unknown("-".repeat(j) + name);
        toVal(out, name, idx + 1 < arr.length || val, opts);
      }
    }
  }
  if (defaults) {
    for (k in opts.default) {
      if (out[k] === void 0) {
        out[k] = opts.default[k];
      }
    }
  }
  if (alibi) {
    for (k in out) {
      arr = opts.alias[k] || [];
      while (arr.length > 0) {
        out[arr.shift()] = out[k];
      }
    }
  }
  return out;
}
var removeBrackets = (v) => v.replace(/[<[].+/, "").trim();
var findAllBrackets = (v) => {
  const ANGLED_BRACKET_RE_GLOBAL = /<([^>]+)>/g;
  const SQUARE_BRACKET_RE_GLOBAL = /\[([^\]]+)\]/g;
  const res = [];
  const parse = (match) => {
    let variadic = false;
    let value = match[1];
    if (value.startsWith("...")) {
      value = value.slice(3);
      variadic = true;
    }
    return {
      required: match[0].startsWith("<"),
      value,
      variadic
    };
  };
  let angledMatch;
  while (angledMatch = ANGLED_BRACKET_RE_GLOBAL.exec(v)) {
    res.push(parse(angledMatch));
  }
  let squareMatch;
  while (squareMatch = SQUARE_BRACKET_RE_GLOBAL.exec(v)) {
    res.push(parse(squareMatch));
  }
  return res;
};
var getMriOptions = (options) => {
  const result = { alias: {}, boolean: [] };
  for (const [index, option] of options.entries()) {
    if (option.names.length > 1) {
      result.alias[option.names[0]] = option.names.slice(1);
    }
    if (option.isBoolean) {
      if (option.negated) {
        const hasStringTypeOption = options.some((o, i) => {
          return i !== index && o.names.some((name) => option.names.includes(name)) && typeof o.required === "boolean";
        });
        if (!hasStringTypeOption) {
          result.boolean.push(option.names[0]);
        }
      } else {
        result.boolean.push(option.names[0]);
      }
    }
  }
  return result;
};
var findLongest = (arr) => {
  return arr.sort((a, b) => {
    return a.length > b.length ? -1 : 1;
  })[0];
};
var padRight = (str, length) => {
  return str.length >= length ? str : `${str}${" ".repeat(length - str.length)}`;
};
var camelcase = (input) => {
  return input.replace(/([a-z])-([a-z])/g, (_, p1, p2) => {
    return p1 + p2.toUpperCase();
  });
};
var setDotProp = (obj, keys, val) => {
  let i = 0;
  let length = keys.length;
  let t = obj;
  let x;
  for (; i < length; ++i) {
    x = t[keys[i]];
    t = t[keys[i]] = i === length - 1 ? val : x != null ? x : !!~keys[i + 1].indexOf(".") || !(+keys[i + 1] > -1) ? {} : [];
  }
};
var setByType = (obj, transforms) => {
  for (const key of Object.keys(transforms)) {
    const transform = transforms[key];
    if (transform.shouldTransform) {
      obj[key] = Array.prototype.concat.call([], obj[key]);
      if (typeof transform.transformFunction === "function") {
        obj[key] = obj[key].map(transform.transformFunction);
      }
    }
  }
};
var getFileName = (input) => {
  const m = /([^\\\/]+)$/.exec(input);
  return m ? m[1] : "";
};
var camelcaseOptionName = (name) => {
  return name.split(".").map((v, i) => {
    return i === 0 ? camelcase(v) : v;
  }).join(".");
};
var CACError = class extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error(message).stack;
    }
  }
};
var Option = class {
  constructor(rawName, description, config) {
    this.rawName = rawName;
    this.description = description;
    this.config = Object.assign({}, config);
    rawName = rawName.replace(/\.\*/g, "");
    this.negated = false;
    this.names = removeBrackets(rawName).split(",").map((v) => {
      let name = v.trim().replace(/^-{1,2}/, "");
      if (name.startsWith("no-")) {
        this.negated = true;
        name = name.replace(/^no-/, "");
      }
      return camelcaseOptionName(name);
    }).sort((a, b) => a.length > b.length ? 1 : -1);
    this.name = this.names[this.names.length - 1];
    if (this.negated && this.config.default == null) {
      this.config.default = true;
    }
    if (rawName.includes("<")) {
      this.required = true;
    } else if (rawName.includes("[")) {
      this.required = false;
    } else {
      this.isBoolean = true;
    }
  }
};
var processArgs = process.argv;
var platformInfo = `${process.platform}-${process.arch} node-${process.version}`;
var Command = class {
  constructor(rawName, description, config = {}, cli2) {
    this.rawName = rawName;
    this.description = description;
    this.config = config;
    this.cli = cli2;
    this.options = [];
    this.aliasNames = [];
    this.name = removeBrackets(rawName);
    this.args = findAllBrackets(rawName);
    this.examples = [];
  }
  usage(text4) {
    this.usageText = text4;
    return this;
  }
  allowUnknownOptions() {
    this.config.allowUnknownOptions = true;
    return this;
  }
  ignoreOptionDefaultValue() {
    this.config.ignoreOptionDefaultValue = true;
    return this;
  }
  version(version, customFlags = "-v, --version") {
    this.versionNumber = version;
    this.option(customFlags, "Display version number");
    return this;
  }
  example(example) {
    this.examples.push(example);
    return this;
  }
  option(rawName, description, config) {
    const option = new Option(rawName, description, config);
    this.options.push(option);
    return this;
  }
  alias(name) {
    this.aliasNames.push(name);
    return this;
  }
  action(callback) {
    this.commandAction = callback;
    return this;
  }
  isMatched(name) {
    return this.name === name || this.aliasNames.includes(name);
  }
  get isDefaultCommand() {
    return this.name === "" || this.aliasNames.includes("!");
  }
  get isGlobalCommand() {
    return this instanceof GlobalCommand;
  }
  hasOption(name) {
    name = name.split(".")[0];
    return this.options.find((option) => {
      return option.names.includes(name);
    });
  }
  outputHelp() {
    const { name, commands } = this.cli;
    const {
      versionNumber,
      options: globalOptions,
      helpCallback
    } = this.cli.globalCommand;
    let sections = [
      {
        body: `${name}${versionNumber ? `/${versionNumber}` : ""}`
      }
    ];
    sections.push({
      title: "Usage",
      body: `  $ ${name} ${this.usageText || this.rawName}`
    });
    const showCommands = (this.isGlobalCommand || this.isDefaultCommand) && commands.length > 0;
    if (showCommands) {
      const longestCommandName = findLongest(commands.map((command) => command.rawName));
      sections.push({
        title: "Commands",
        body: commands.map((command) => {
          return `  ${padRight(command.rawName, longestCommandName.length)}  ${command.description}`;
        }).join("\n")
      });
      sections.push({
        title: `For more info, run any command with the \`--help\` flag`,
        body: commands.map((command) => `  $ ${name}${command.name === "" ? "" : ` ${command.name}`} --help`).join("\n")
      });
    }
    let options = this.isGlobalCommand ? globalOptions : [...this.options, ...globalOptions || []];
    if (!this.isGlobalCommand && !this.isDefaultCommand) {
      options = options.filter((option) => option.name !== "version");
    }
    if (options.length > 0) {
      const longestOptionName = findLongest(options.map((option) => option.rawName));
      sections.push({
        title: "Options",
        body: options.map((option) => {
          return `  ${padRight(option.rawName, longestOptionName.length)}  ${option.description} ${option.config.default === void 0 ? "" : `(default: ${option.config.default})`}`;
        }).join("\n")
      });
    }
    if (this.examples.length > 0) {
      sections.push({
        title: "Examples",
        body: this.examples.map((example) => {
          if (typeof example === "function") {
            return example(name);
          }
          return example;
        }).join("\n")
      });
    }
    if (helpCallback) {
      sections = helpCallback(sections) || sections;
    }
    console.log(sections.map((section) => {
      return section.title ? `${section.title}:
${section.body}` : section.body;
    }).join("\n\n"));
  }
  outputVersion() {
    const { name } = this.cli;
    const { versionNumber } = this.cli.globalCommand;
    if (versionNumber) {
      console.log(`${name}/${versionNumber} ${platformInfo}`);
    }
  }
  checkRequiredArgs() {
    const minimalArgsCount = this.args.filter((arg) => arg.required).length;
    if (this.cli.args.length < minimalArgsCount) {
      throw new CACError(`missing required args for command \`${this.rawName}\``);
    }
  }
  checkUnknownOptions() {
    const { options, globalCommand } = this.cli;
    if (!this.config.allowUnknownOptions) {
      for (const name of Object.keys(options)) {
        if (name !== "--" && !this.hasOption(name) && !globalCommand.hasOption(name)) {
          throw new CACError(`Unknown option \`${name.length > 1 ? `--${name}` : `-${name}`}\``);
        }
      }
    }
  }
  checkOptionValue() {
    const { options: parsedOptions, globalCommand } = this.cli;
    const options = [...globalCommand.options, ...this.options];
    for (const option of options) {
      const value = parsedOptions[option.name.split(".")[0]];
      if (option.required) {
        const hasNegated = options.some((o) => o.negated && o.names.includes(option.name));
        if (value === true || value === false && !hasNegated) {
          throw new CACError(`option \`${option.rawName}\` value is missing`);
        }
      }
    }
  }
};
var GlobalCommand = class extends Command {
  constructor(cli2) {
    super("@@global@@", "", {}, cli2);
  }
};
var __assign = Object.assign;
var CAC = class extends EventEmitter {
  constructor(name = "") {
    super();
    this.name = name;
    this.commands = [];
    this.rawArgs = [];
    this.args = [];
    this.options = {};
    this.globalCommand = new GlobalCommand(this);
    this.globalCommand.usage("<command> [options]");
  }
  usage(text4) {
    this.globalCommand.usage(text4);
    return this;
  }
  command(rawName, description, config) {
    const command = new Command(rawName, description || "", config, this);
    command.globalCommand = this.globalCommand;
    this.commands.push(command);
    return command;
  }
  option(rawName, description, config) {
    this.globalCommand.option(rawName, description, config);
    return this;
  }
  help(callback) {
    this.globalCommand.option("-h, --help", "Display this message");
    this.globalCommand.helpCallback = callback;
    this.showHelpOnExit = true;
    return this;
  }
  version(version, customFlags = "-v, --version") {
    this.globalCommand.version(version, customFlags);
    this.showVersionOnExit = true;
    return this;
  }
  example(example) {
    this.globalCommand.example(example);
    return this;
  }
  outputHelp() {
    if (this.matchedCommand) {
      this.matchedCommand.outputHelp();
    } else {
      this.globalCommand.outputHelp();
    }
  }
  outputVersion() {
    this.globalCommand.outputVersion();
  }
  setParsedInfo({ args, options }, matchedCommand, matchedCommandName) {
    this.args = args;
    this.options = options;
    if (matchedCommand) {
      this.matchedCommand = matchedCommand;
    }
    if (matchedCommandName) {
      this.matchedCommandName = matchedCommandName;
    }
    return this;
  }
  unsetMatchedCommand() {
    this.matchedCommand = void 0;
    this.matchedCommandName = void 0;
  }
  parse(argv = processArgs, {
    run = true
  } = {}) {
    this.rawArgs = argv;
    if (!this.name) {
      this.name = argv[1] ? getFileName(argv[1]) : "cli";
    }
    let shouldParse = true;
    for (const command of this.commands) {
      const parsed = this.mri(argv.slice(2), command);
      const commandName = parsed.args[0];
      if (command.isMatched(commandName)) {
        shouldParse = false;
        const parsedInfo = __assign(__assign({}, parsed), {
          args: parsed.args.slice(1)
        });
        this.setParsedInfo(parsedInfo, command, commandName);
        this.emit(`command:${commandName}`, command);
      }
    }
    if (shouldParse) {
      for (const command of this.commands) {
        if (command.name === "") {
          shouldParse = false;
          const parsed = this.mri(argv.slice(2), command);
          this.setParsedInfo(parsed, command);
          this.emit(`command:!`, command);
        }
      }
    }
    if (shouldParse) {
      const parsed = this.mri(argv.slice(2));
      this.setParsedInfo(parsed);
    }
    if (this.options.help && this.showHelpOnExit) {
      this.outputHelp();
      run = false;
      this.unsetMatchedCommand();
    }
    if (this.options.version && this.showVersionOnExit && this.matchedCommandName == null) {
      this.outputVersion();
      run = false;
      this.unsetMatchedCommand();
    }
    const parsedArgv = { args: this.args, options: this.options };
    if (run) {
      this.runMatchedCommand();
    }
    if (!this.matchedCommand && this.args[0]) {
      this.emit("command:*");
    }
    return parsedArgv;
  }
  mri(argv, command) {
    const cliOptions = [
      ...this.globalCommand.options,
      ...command ? command.options : []
    ];
    const mriOptions = getMriOptions(cliOptions);
    let argsAfterDoubleDashes = [];
    const doubleDashesIndex = argv.indexOf("--");
    if (doubleDashesIndex > -1) {
      argsAfterDoubleDashes = argv.slice(doubleDashesIndex + 1);
      argv = argv.slice(0, doubleDashesIndex);
    }
    let parsed = mri2(argv, mriOptions);
    parsed = Object.keys(parsed).reduce((res, name) => {
      return __assign(__assign({}, res), {
        [camelcaseOptionName(name)]: parsed[name]
      });
    }, { _: [] });
    const args = parsed._;
    const options = {
      "--": argsAfterDoubleDashes
    };
    const ignoreDefault = command && command.config.ignoreOptionDefaultValue ? command.config.ignoreOptionDefaultValue : this.globalCommand.config.ignoreOptionDefaultValue;
    let transforms = /* @__PURE__ */ Object.create(null);
    for (const cliOption of cliOptions) {
      if (!ignoreDefault && cliOption.config.default !== void 0) {
        for (const name of cliOption.names) {
          options[name] = cliOption.config.default;
        }
      }
      if (Array.isArray(cliOption.config.type)) {
        if (transforms[cliOption.name] === void 0) {
          transforms[cliOption.name] = /* @__PURE__ */ Object.create(null);
          transforms[cliOption.name]["shouldTransform"] = true;
          transforms[cliOption.name]["transformFunction"] = cliOption.config.type[0];
        }
      }
    }
    for (const key of Object.keys(parsed)) {
      if (key !== "_") {
        const keys = key.split(".");
        setDotProp(options, keys, parsed[key]);
        setByType(options, transforms);
      }
    }
    return {
      args,
      options
    };
  }
  runMatchedCommand() {
    const { args, options, matchedCommand: command } = this;
    if (!command || !command.commandAction)
      return;
    command.checkUnknownOptions();
    command.checkOptionValue();
    command.checkRequiredArgs();
    const actionArgs = [];
    command.args.forEach((arg, index) => {
      if (arg.variadic) {
        actionArgs.push(args.slice(index));
      } else {
        actionArgs.push(args[index]);
      }
    });
    actionArgs.push(options);
    return command.commandAction.apply(this, actionArgs);
  }
};
var cac = (name = "") => new CAC(name);

// src/ingest.ts
import { readFileSync as readFileSync2 } from "fs";

// src/compat/claude-usage.ts
function collectClaudeUsage(records) {
  const messages = /* @__PURE__ */ new Map();
  let anonymous = 0;
  for (const value of records) {
    const row = object(value);
    const message = object(row?.message);
    const usage = object(message?.usage);
    if (row?.type !== "assistant" || message?.role !== "assistant" || !usage) continue;
    const id = typeof message.id === "string" && message.id ? `id:${message.id}` : `row:${anonymous++}`;
    messages.set(id, usage);
  }
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCached = 0;
  for (const usage of messages.values()) {
    const parts = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : [usage];
    for (const part of parts) {
      const item = object(part);
      tokensInput += count(item?.input_tokens);
      tokensOutput += count(item?.output_tokens);
      tokensCached += count(item?.cache_read_input_tokens) + count(item?.cache_creation_input_tokens);
    }
  }
  return { tokensInput, tokensOutput, tokensCached };
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// src/ingest.ts
import os3 from "os";
import path8 from "path";

// src/shared/collectors/skill.ts
import path3 from "path";
function skillFromReadPaths(input, output, cwd) {
  if (typeof input !== "string" || !input.trim() || typeof output !== "string" || !path3.isAbsolute(output)) return void 0;
  if (!path3.isAbsolute(input) && (!cwd || !path3.isAbsolute(cwd))) return void 0;
  const requested = path3.resolve(cwd ?? "/", input);
  if (requested !== path3.normalize(output) || path3.basename(requested) !== "SKILL.md") return void 0;
  const skill = path3.basename(path3.dirname(requested));
  return skill || void 0;
}

// src/agents/cursor/skill.ts
function object2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function cursorReadSkill(name, input, output, succeeded, cwd) {
  if (!succeeded || name !== "Read") return void 0;
  let result = output;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return void 0;
    }
  }
  const read = object2(result);
  if (!read || read.is_error === true || read.isError === true) return void 0;
  if (typeof read.content_length !== "number" || !Number.isInteger(read.content_length) || read.content_length < 0) return void 0;
  return skillFromReadPaths(object2(input)?.file_path, read.file_path, cwd);
}

// src/agents/cursor/hooks.ts
import path4 from "path";

// src/shared/collectors/identity.ts
import { createHash } from "crypto";
function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function fields(input) {
  return input !== null && typeof input === "object" ? input : {};
}
function sessionKey(agent, nativeSessionId) {
  if (!nativeSessionId.trim()) throw new Error("empty session id");
  return `${agent}:${nativeSessionId}`;
}
function eventKey(event3) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])
    );
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(event3))).digest("hex");
}
function detectHost(input, env) {
  const payload = fields(input);
  const nativeGrok = hasText(payload.sessionId) && hasText(payload.hookEventName);
  const nativeCursor = hasText(payload.conversation_id) && (hasText(payload.hook_event_name) || hasText(payload.cursor_version));
  if (nativeGrok && nativeCursor) {
    console.warn("[timeline] conflicting native host evidence: grok,cursor");
    return null;
  }
  if (nativeGrok) return "grok";
  if (nativeCursor) return "cursor";
  if (hasText(env.GROK_SESSION_ID) || hasText(env.GROK_HOOK_EVENT)) return "grok";
  if (hasText(payload.conversation_id) && hasText(env.CURSOR_VERSION)) return "cursor";
  return null;
}

// src/agents/cursor/hooks.ts
function object3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => text(item) !== void 0) : [];
}
function project(payload) {
  const cwd = text(payload.cwd);
  const roots = strings(payload.workspace_roots);
  if (!cwd) return roots[0];
  const containing = roots.filter((root) => {
    const relative = path4.relative(root, cwd);
    return relative === "" || !relative.startsWith("..") && !path4.isAbsolute(relative);
  });
  if (containing.length === 1) return containing[0];
  return cwd;
}
function createEvent(semantic, observedAt, identity) {
  return {
    ...semantic,
    eventId: eventKey({ ...semantic, ...identity }),
    observedAt
  };
}
function parseCursorHook(input, observedAt) {
  const payload = object3(input);
  if (!payload || !Number.isFinite(observedAt)) return [];
  const nativeSessionId = text(payload.conversation_id);
  const hook = text(payload.hook_event_name);
  if (!nativeSessionId || !hook) return [];
  const generationId = text(payload.generation_id);
  const reliableTurnId = generationId && generationId !== nativeSessionId ? generationId : void 0;
  const transcriptPath = text(payload.transcript_path);
  const rootSession = (hook === "sessionStart" || hook === "sessionEnd") && payload.is_background_agent === false ? true : void 0;
  const base = {
    version: 1,
    agent: "cursor",
    nativeSessionId,
    turnId: reliableTurnId,
    project: project(payload),
    model: text(payload.model_id) ?? text(payload.model),
    transcriptPath,
    rootSession
  };
  const identity = {
    cursorHook: hook,
    nativeStatus: text(payload.final_status) ?? text(payload.reason),
    nativeDuration: typeof payload.duration_ms === "number" ? payload.duration_ms : void 0
  };
  if (hook === "beforeSubmitPrompt") {
    const prompt = text(payload.prompt);
    if (!prompt || !reliableTurnId) return [];
    return [createEvent(
      { ...base, prompt: prompt.slice(0, 140) },
      observedAt,
      { ...identity, fullPrompt: prompt }
    )];
  }
  if (hook === "postToolUse" || hook === "postToolUseFailure") {
    const id = text(payload.tool_use_id);
    const name = text(payload.tool_name);
    if (!id || !name) return [];
    const skill = cursorReadSkill(
      name,
      payload.tool_input,
      payload.tool_output,
      hook === "postToolUse" && payload.is_error !== true && payload.isError !== true && !payload.error_message && !payload.failure_type,
      text(payload.cwd) ?? project(payload)
    );
    const unresolvedParent = reliableTurnId === void 0 && rootSession !== true ? true : void 0;
    return [createEvent({
      ...base,
      confirmsTurn: true,
      tool: { id, name, ...skill ? { skill } : {} },
      unresolvedParent,
      needsHydration: unresolvedParent && transcriptPath ? true : void 0
    }, observedAt, { ...identity, cursorHook: "tool" })];
  }
  if (hook === "afterAgentResponse") {
    return [createEvent({ ...base, confirmsTurn: true }, observedAt, identity)];
  }
  if (hook === "stop") {
    return [createEvent({ ...base, confirmsTurn: true, needsHydration: true }, observedAt, identity)];
  }
  if (hook === "sessionStart") {
    return [createEvent(base, observedAt, identity)];
  }
  if (hook === "sessionEnd") {
    return [createEvent({ ...base, needsHydration: true }, observedAt, identity)];
  }
  return [];
}

// src/agents/cursor/transcript.ts
import { createHash as createHash2 } from "crypto";
import { readFile, stat } from "fs/promises";
function object4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    const value = object4(block);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
}
function nativeUserQuery(value) {
  const match = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  const query = match?.[1]?.trim();
  return query ? query : void 0;
}
function event(semantic, observedAt) {
  return { ...semantic, eventId: eventKey(semantic), observedAt };
}
async function readTranscript(transcriptPath) {
  let info;
  try {
    info = await stat(transcriptPath);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  let raw;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const hasTrailingNewline = raw.endsWith("\n");
  if (hasTrailingNewline) lines.pop();
  let complete = true;
  let warned = false;
  const parsed = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const value = object4(JSON.parse(line));
      if (value) parsed.push(value);
    } catch {
      if (index === lines.length - 1 && !hasTrailingNewline) {
        complete = false;
      } else if (!warned) {
        console.warn("[timeline] Cursor transcript contains an invalid JSONL line");
        warned = true;
      }
    }
  }
  const occurrences = /* @__PURE__ */ new Map();
  const turns = [];
  const pendingTools = /* @__PURE__ */ new Map();
  let current;
  for (const row of parsed) {
    const role = typeof row.role === "string" ? row.role : void 0;
    const message = object4(row.message);
    const content = contentText(message?.content);
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      const result = object4(block);
      if (result?.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
      const pending = pendingTools.get(result.tool_use_id);
      if (!pending) continue;
      const skill = cursorReadSkill(
        pending.tool.name,
        pending.input,
        result.content,
        result.is_error !== true && result.isError !== true
      );
      if (skill) pending.tool.skill = skill;
      pendingTools.delete(result.tool_use_id);
    }
    if (role === "user" && blocks.some((block) => object4(block)?.type === "tool_result")) continue;
    if (role === "user") {
      const prompt = nativeUserQuery(content);
      if (!prompt) {
        current = void 0;
        continue;
      }
      const ordinal = occurrences.get(prompt) ?? 0;
      occurrences.set(prompt, ordinal + 1);
      current = { prompt, ordinal, hasAssistantActivity: false, tools: [] };
      turns.push(current);
    } else if (role === "assistant" && current) {
      const hasTool = blocks.some((block) => object4(block)?.type === "tool_use");
      if (content.trim() || hasTool) current.hasAssistantActivity = true;
      for (const block of blocks) {
        const tool = object4(block);
        if (tool?.type === "tool_use" && typeof tool.id === "string" && tool.id.trim() && typeof tool.name === "string" && tool.name.trim()) {
          const collected = { id: tool.id, name: tool.name };
          current.tools.push(collected);
          pendingTools.set(tool.id, { tool: collected, input: tool.input });
        }
      }
    }
  }
  return { turns, complete, fileSize: info.size };
}
function turnId(prompt, ordinal) {
  const hash = createHash2("sha256").update(prompt).digest("hex");
  return `transcript:${hash}:${ordinal}`;
}
function withoutIdentity(source) {
  const { eventId: _eventId, observedAt: _observedAt, ...semantic } = source;
  return semantic;
}
async function hydrateCursor(events) {
  const cursorEvents = events.filter((item) => item.agent === "cursor");
  if (cursorEvents.length === 0) return [];
  if (new Set(cursorEvents.map((item) => item.nativeSessionId)).size > 1) {
    throw new Error("mixed Cursor hydration sessions");
  }
  const output = [];
  const rootProven = cursorEvents.some((item) => item.rootSession === true);
  const reliableHookTurns = cursorEvents.some((item) => item.turnId?.startsWith("transcript:") === false);
  const requests = cursorEvents.filter((item) => item.needsHydration === true);
  const paths = [...new Set(requests.map((item) => item.transcriptPath).filter(
    (value) => typeof value === "string" && value.length > 0
  ))];
  const loaded = /* @__PURE__ */ new Map();
  for (const transcriptPath of paths) {
    const transcript = await readTranscript(transcriptPath);
    if (transcript) loaded.set(transcriptPath, transcript);
  }
  const unresolvedContext = cursorEvents.some((item) => item.unresolvedParent) && !rootProven;
  const observedAt = Math.min(...cursorEvents.map((item) => item.observedAt));
  const exemplar = cursorEvents[0];
  const hookToolIds = new Set(cursorEvents.flatMap((item) => item.tool ? [item.tool.id] : []));
  if (!reliableHookTurns) {
    const transcript = loaded.values().next().value;
    for (const turn of transcript?.turns ?? []) {
      if (!turn.hasAssistantActivity) continue;
      const id = turnId(turn.prompt, turn.ordinal);
      const base = {
        version: 1,
        agent: "cursor",
        nativeSessionId: exemplar.nativeSessionId,
        turnId: id,
        project: exemplar.project,
        model: exemplar.model,
        transcriptPath: exemplar.transcriptPath,
        unresolvedParent: unresolvedContext ? true : void 0
      };
      output.push(event({ ...base, prompt: turn.prompt.slice(0, 140) }, observedAt));
      output.push(event({ ...base, confirmsTurn: true }, observedAt));
      for (const tool of turn.tools) {
        if (!hookToolIds.has(tool.id)) output.push(event({ ...base, tool }, observedAt));
      }
    }
  }
  if (loaded.size > 0) {
    const transcript = loaded.values().next().value;
    output.push(event({
      version: 1,
      agent: "cursor",
      nativeSessionId: exemplar.nativeSessionId,
      project: exemplar.project,
      model: exemplar.model,
      transcriptPath: exemplar.transcriptPath,
      fileSize: transcript.fileSize,
      usage: { input: 0, output: 0, cached: 0, status: "unavailable" },
      unresolvedParent: unresolvedContext ? true : void 0
    }, observedAt));
  }
  for (const request of requests) {
    const transcript = request.transcriptPath ? loaded.get(request.transcriptPath) : void 0;
    if (request.transcriptPath && !transcript?.complete) continue;
    if (request.unresolvedParent && !rootProven) continue;
    output.push(event({
      ...withoutIdentity(request),
      unresolvedParent: false,
      rootSession: request.rootSession ?? (rootProven ? true : void 0),
      needsHydration: false,
      resolvesEventId: request.eventId
    }, request.observedAt));
  }
  for (const request of cursorEvents.filter((item) => item.unresolvedParent && !item.needsHydration)) {
    if (!rootProven) continue;
    output.push(event({
      ...withoutIdentity(request),
      unresolvedParent: false,
      rootSession: true,
      resolvesEventId: request.eventId
    }, request.observedAt));
  }
  return output;
}

// src/agents/grok/skill.ts
function object5(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function grokReadSkill(name, input, output, succeeded, cwd) {
  if (!succeeded || name !== "read_file") return void 0;
  const result = object5(output);
  const content = object5(result?.FileContent);
  if (result?.type !== "ReadFile" || "FileNotFound" in result || result.is_error === true || result.isError === true || typeof content?.content !== "string") return void 0;
  return skillFromReadPaths(object5(input)?.target_file, content.absolute_path, cwd);
}

// src/agents/grok/hooks.ts
var compatibilityEvents = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PostToolUse: "post_tool_use",
  PostToolUseFailure: "post_tool_use_failure",
  Stop: "stop",
  StopFailure: "stop_failure",
  StopCancelled: "stop_cancelled",
  SessionEnd: "session_end",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop"
};
var lifecycle = /* @__PURE__ */ new Set(["stop", "stop_failure", "stop_cancelled", "session_end"]);
var confirms = /* @__PURE__ */ new Set([
  "post_tool_use",
  "post_tool_use_failure",
  "stop",
  "stop_failure",
  "stop_cancelled"
]);
function object6(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text2(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function sourceTime(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function createEvent2(semantic, observedAt, identity = {}) {
  return {
    ...semantic,
    eventId: eventKey({ ...semantic, ...identity }),
    observedAt
  };
}
function parseGrokHook(input, observedAt) {
  const payload = object6(input);
  if (!payload || !Number.isFinite(observedAt)) return [];
  const nativeSessionId = text2(payload.sessionId);
  const nativeHook = text2(payload.hookEventName);
  const hook = nativeHook ?? compatibilityEvents[text2(payload.hook_event_name) ?? ""];
  if (!nativeSessionId || !hook) return [];
  const promptId = text2(payload.promptId);
  const subagentType = text2(payload.subagentType);
  const isSubagentStart = hook === "subagent_start";
  const child = subagentType !== void 0 && !isSubagentStart;
  const base = {
    version: 1,
    agent: "grok",
    nativeSessionId,
    turnId: promptId,
    sourceAt: sourceTime(payload.timestamp),
    project: text2(payload.workspaceRoot) ?? text2(payload.cwd),
    transcriptPath: text2(payload.transcriptPath),
    rootSession: isSubagentStart || !child && (hook === "session_start" || hook === "session_end") ? true : void 0,
    unresolvedParent: child ? true : void 0
  };
  const identity = {
    grokHook: hook,
    nativeReason: text2(payload.reason) ?? text2(payload.phase),
    subagentId: text2(payload.subagentId),
    subagentType
  };
  if (hook === "user_prompt_submit") {
    const prompt = text2(payload.prompt);
    if (!prompt || !promptId || child) return [];
    return [createEvent2(
      { ...base, prompt: prompt.slice(0, 140) },
      observedAt,
      { ...identity, fullPrompt: prompt }
    )];
  }
  if (hook === "post_tool_use" || hook === "post_tool_use_failure") {
    const id = text2(payload.toolUseId);
    const name = text2(payload.toolName);
    if (!id || !name) return [];
    const skill = grokReadSkill(
      name,
      payload.toolInput,
      payload.toolResult,
      hook === "post_tool_use" && payload.is_error !== true && payload.isError !== true && payload.toolInputTruncated !== true && payload.toolResultTruncated !== true,
      text2(payload.cwd) ?? text2(payload.workspaceRoot)
    );
    return [createEvent2({
      ...base,
      confirmsTurn: true,
      tool: { id, name, ...skill ? { skill } : {} },
      needsHydration: child ? true : void 0
    }, observedAt, { ...identity, grokHook: "tool" })];
  }
  if (hook === "subagent_start") {
    const subagentId = text2(payload.subagentId);
    if (!subagentId) return [];
    return [createEvent2(base, observedAt, identity)];
  }
  if (hook === "subagent_stop") {
    return [createEvent2({
      ...base,
      confirmsTurn: promptId ? true : void 0,
      needsHydration: true
    }, observedAt, identity)];
  }
  if (hook === "session_start") return [createEvent2(base, observedAt, identity)];
  if (lifecycle.has(hook)) {
    return [createEvent2({
      ...base,
      confirmsTurn: confirms.has(hook) && promptId ? true : void 0,
      needsHydration: true
    }, observedAt, identity)];
  }
  return [];
}

// src/agents/grok/session.ts
import { readdir, readFile as readFile2, stat as stat2 } from "fs/promises";
import path5 from "path";
function object7(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text3(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function nonnegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
function timestamp(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function event2(semantic, observedAt) {
  return { ...semantic, eventId: eventKey(semantic), observedAt };
}
function withoutIdentity2(source) {
  const { eventId: _eventId, observedAt: _observedAt, ...semantic } = source;
  return semantic;
}
function parseGrokUsage(input, nativeSessionId) {
  const payload = object7(input);
  const session = object7(payload?.session);
  if (text3(payload?.sessionId) !== nativeSessionId || !session) return null;
  const inputTokens = session.inputTokens;
  const outputTokens = session.outputTokens;
  const cachedReadTokens = session.cachedReadTokens;
  const incomplete = session.usageIsIncomplete;
  if (!nonnegativeInteger(inputTokens) || !nonnegativeInteger(outputTokens) || !nonnegativeInteger(cachedReadTokens) || incomplete !== void 0 && incomplete !== true && incomplete !== false || cachedReadTokens > inputTokens) return null;
  return {
    input: inputTokens - cachedReadTokens,
    output: outputTokens,
    cached: cachedReadTokens,
    status: incomplete === true ? "partial" : "complete"
  };
}
async function stableRead(filePath) {
  try {
    const before = await stat2(filePath);
    if (!before.isFile()) return null;
    const raw = await readFile2(filePath, "utf8");
    const after = await stat2(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    return { path: filePath, raw, size: after.size, mtimeMs: after.mtimeMs };
  } catch {
    return null;
  }
}
function parseSummary(file, expectedId) {
  let payload;
  try {
    payload = object7(JSON.parse(file.raw));
  } catch {
    return null;
  }
  const info = object7(payload?.info);
  if (text3(info?.id) !== expectedId) return null;
  if (payload?.chat_format_version !== 1) {
    console.warn("[timeline] unsupported Grok chat format");
    return null;
  }
  return {
    id: expectedId,
    project: text3(info?.cwd),
    title: text3(payload?.generated_title) ?? text3(payload?.session_summary),
    model: text3(payload?.current_model_id),
    updatedAt: timestamp(payload?.updated_at),
    kind: text3(payload?.session_kind) ?? "",
    directory: path5.dirname(file.path),
    fileSize: file.size,
    mtimeMs: file.mtimeMs,
    parentId: text3(payload?.parent_session_id)
  };
}
async function directoriesNamed(root, expectedId) {
  const found = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project2 of projects) {
    if (!project2.isDirectory()) continue;
    const projectPath = path5.join(root, project2.name);
    if (project2.name === expectedId) found.push(projectPath);
    let sessions;
    try {
      sessions = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (session.isDirectory() && session.name === expectedId) {
        found.push(path5.join(projectPath, session.name));
      }
    }
  }
  return [...new Set(found)];
}
async function locateSummary(events, grokHome2, expectedId) {
  const candidates = [];
  for (const transcriptPath of events.map((item) => item.transcriptPath)) {
    if (transcriptPath) candidates.push(path5.dirname(transcriptPath));
  }
  candidates.push(...await directoriesNamed(path5.join(grokHome2, "sessions"), expectedId));
  for (const directory of [...new Set(candidates)]) {
    const file = await stableRead(path5.join(directory, "summary.json"));
    if (!file) continue;
    const summary = parseSummary(file, expectedId);
    if (summary) return summary;
  }
  return null;
}
async function readUsage(summary) {
  const file = await stableRead(path5.join(summary.directory, "usage.json"));
  if (!file) return null;
  let payload;
  try {
    payload = JSON.parse(file.raw);
  } catch {
    return null;
  }
  const usage = parseGrokUsage(payload, summary.id);
  if (!usage) return null;
  const summaryAfter = await stat2(path5.join(summary.directory, "summary.json")).catch(() => null);
  if (!summaryAfter || summaryAfter.size !== summary.fileSize || summaryAfter.mtimeMs !== summary.mtimeMs) return null;
  return {
    usage,
    sourceAt: timestamp(object7(payload)?.updatedAt),
    fileSize: file.size
  };
}
async function findParent(child, grokHome2) {
  if (child.kind !== "subagent" && child.kind !== "subagent_fork") return null;
  const sessionsRoot = path5.join(grokHome2, "sessions");
  if (child.parentId) {
    for (const directory of await directoriesNamed(sessionsRoot, child.parentId)) {
      const summaryFile = await stableRead(path5.join(directory, "summary.json"));
      if (!summaryFile) continue;
      const parent = parseSummary(summaryFile, child.parentId);
      if (parent) return parent;
    }
  }
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project2 of projects) {
    if (!project2.isDirectory()) continue;
    const projectPath = path5.join(sessionsRoot, project2.name);
    let parents;
    try {
      parents = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const parent of parents) {
      if (!parent.isDirectory()) continue;
      const parentDirectory = path5.join(projectPath, parent.name);
      const metaFile = await stableRead(path5.join(
        parentDirectory,
        "subagents",
        child.id,
        "meta.json"
      ));
      if (!metaFile) continue;
      let meta;
      try {
        meta = object7(JSON.parse(metaFile.raw));
      } catch {
        continue;
      }
      const parentId = text3(meta?.parent_session_id);
      if (!parentId || text3(meta?.child_session_id) !== child.id || text3(meta?.subagent_id) !== child.id) continue;
      const summaryFile = await stableRead(path5.join(parentDirectory, "summary.json"));
      if (!summaryFile) continue;
      const parentSummary = parseSummary(summaryFile, parentId);
      if (parentSummary && parentSummary.directory === parentDirectory) return parentSummary;
    }
  }
  return null;
}
function metadataEvent(summary, usage, exemplar) {
  return event2({
    version: 1,
    agent: "grok",
    nativeSessionId: summary.id,
    rootSession: true,
    project: summary.project,
    title: summary.title,
    model: summary.model,
    transcriptPath: path5.join(summary.directory, "chat_history.jsonl"),
    fileSize: summary.fileSize + (usage?.fileSize ?? 0),
    sourceAt: usage?.sourceAt ?? summary.updatedAt,
    usage: usage?.usage
  }, exemplar.observedAt);
}
function uniqueRequests(events) {
  const requests = /* @__PURE__ */ new Map();
  for (const item of events) {
    if (item.needsHydration === true && !item.resolvesEventId) requests.set(item.eventId, item);
  }
  return [...requests.values()];
}
async function hydrateGrok(events, grokHome2) {
  const grokEvents = events.filter((item) => item.agent === "grok");
  if (grokEvents.length === 0) return [];
  if (new Set(grokEvents.map((item) => item.nativeSessionId)).size > 1) {
    throw new Error("mixed Grok hydration sessions");
  }
  const exemplar = grokEvents[0];
  const requests = uniqueRequests(grokEvents);
  if (requests.length === 0) return [];
  const summary = await locateSummary(grokEvents, grokHome2, exemplar.nativeSessionId);
  if (!summary) return [];
  if (requests.some((item) => item.unresolvedParent)) {
    const parent = await findParent(summary, grokHome2);
    if (!parent) return [];
    return requests.map((request) => event2({
      ...withoutIdentity2(request),
      nativeSessionId: parent.id,
      sourceSessionId: request.nativeSessionId,
      project: parent.project,
      model: parent.model,
      title: parent.title,
      rootSession: void 0,
      unresolvedParent: false,
      needsHydration: false,
      resolvesEventId: request.eventId,
      usage: void 0,
      prompt: void 0
    }, request.observedAt));
  }
  const usage = await readUsage(summary);
  if (!usage) return [];
  const output = [metadataEvent(summary, usage, exemplar)];
  if (usage.usage.status === "partial") return output;
  for (const request of requests) {
    if (request.turnId && request.sourceAt !== void 0 && usage.sourceAt !== void 0 && usage.sourceAt < request.sourceAt) continue;
    output.push(event2({
      ...withoutIdentity2(request),
      project: summary.project,
      model: summary.model,
      title: summary.title,
      transcriptPath: path5.join(summary.directory, "chat_history.jsonl"),
      rootSession: true,
      unresolvedParent: false,
      needsHydration: false,
      resolvesEventId: request.eventId
    }, request.observedAt));
  }
  return output;
}

// src/shared/collectors/journal.ts
import { createHash as createHash3, randomUUID } from "crypto";
import { link, mkdir, open, readdir as readdir2, readFile as readFile3, rename, unlink } from "fs/promises";
import path6 from "path";
var HEX_HASH = /^[a-f0-9]{64}$/;
function collectorDirectory(home, key) {
  const hash = createHash3("sha256").update(key).digest("hex");
  return path6.join(home, "collectors", hash);
}
async function ensureDirectory(home, key) {
  const directory = collectorDirectory(home, key);
  await mkdir(path6.join(directory, "outbox"), { recursive: true, mode: 448 });
  return directory;
}
async function durableWrite(filePath, value) {
  const tempPath = path6.join(path6.dirname(filePath), `.tmp-${randomUUID()}`);
  const file = await open(tempPath, "wx", 384);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(tempPath, filePath);
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function writeOnce(filePath, value) {
  const tempPath = path6.join(path6.dirname(filePath), `.tmp-${randomUUID()}`);
  const file = await open(tempPath, "wx", 384);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(tempPath, filePath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await unlink(tempPath);
  }
}
var CorruptCollectorStateError = class extends Error {
  constructor(corruptPath) {
    super(`corrupt collector state moved to ${corruptPath}; host hydration required`);
    this.corruptPath = corruptPath;
  }
  corruptPath;
};
function createJournal(home) {
  return {
    async enqueue(event3) {
      if (!HEX_HASH.test(event3.eventId)) throw new Error("invalid collector event id");
      const key = sessionKey(event3.agent, event3.nativeSessionId);
      const directory = await ensureDirectory(home, key);
      await writeOnce(path6.join(directory, "identity.json"), { key });
      await writeOnce(path6.join(directory, "outbox", `${event3.eventId}.json`), event3);
    },
    async pending(key) {
      const outbox = path6.join(collectorDirectory(home, key), "outbox");
      let names;
      try {
        names = await readdir2(outbox);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const events = [];
      for (const name of names.filter((name2) => HEX_HASH.test(name2.slice(0, -5)) && name2.endsWith(".json")).sort()) {
        try {
          events.push(JSON.parse(await readFile3(path6.join(outbox, name), "utf8")));
        } catch (error) {
          console.warn(`[timeline] unreadable outbox event ${name}: ${String(error)}`);
        }
      }
      return events;
    },
    async load(key) {
      const statePath = path6.join(collectorDirectory(home, key), "state.json");
      try {
        const state = JSON.parse(await readFile3(statePath, "utf8"));
        if (state.version !== 1 || state.agent !== "cursor" && state.agent !== "grok" || typeof state.nativeSessionId !== "string" || !state.events || typeof state.events !== "object" || sessionKey(state.agent, state.nativeSessionId) !== key) {
          throw new Error("invalid collector state");
        }
        return state;
      } catch (error) {
        if (error.code === "ENOENT") {
          const names = await readdir2(path6.dirname(statePath)).catch(() => []);
          const corrupt = names.find((name) => name.startsWith("state.json.") && name.endsWith(".corrupt"));
          if (corrupt) throw new CorruptCollectorStateError(path6.join(path6.dirname(statePath), corrupt));
          return null;
        }
        const corruptPath = `${statePath}.${Date.now()}-${randomUUID()}.corrupt`;
        await rename(statePath, corruptPath).catch(() => void 0);
        throw new CorruptCollectorStateError(corruptPath);
      }
    },
    async save(key, state) {
      const directory = await ensureDirectory(home, key);
      await durableWrite(path6.join(directory, "state.json"), state);
    },
    async ack(key, eventIds) {
      const outbox = path6.join(collectorDirectory(home, key), "outbox");
      await Promise.all(eventIds.filter((id) => HEX_HASH.test(id)).map(async (id) => {
        await unlink(path6.join(outbox, `${id}.json`)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }));
    },
    async keys() {
      const root = path6.join(home, "collectors");
      let directories;
      try {
        directories = await readdir2(root);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const keys = [];
      for (const directory of directories) {
        const base = path6.join(root, directory);
        try {
          const identity = JSON.parse(await readFile3(path6.join(base, "identity.json"), "utf8"));
          if (typeof identity.key !== "string") continue;
          if ((await this.pending(identity.key)).length > 0) keys.push(identity.key);
        } catch (error) {
          console.warn(`[timeline] unreadable collector identity ${directory}: ${String(error)}`);
        }
      }
      return keys.sort();
    }
  };
}

// src/shared/collectors/lock.ts
import { createHash as createHash4, randomUUID as randomUUID2 } from "crypto";
import { mkdir as mkdir2, open as open2, readFile as readFile4, unlink as unlink2 } from "fs/promises";
import path7 from "path";
import { setTimeout as delay } from "timers/promises";
function lockPath(home, key) {
  return path7.join(home, "collectors", createHash4("sha256").update(key).digest("hex"), "lock");
}
async function readLock(filePath) {
  try {
    const value = JSON.parse(await readFile4(filePath, "utf8"));
    return Number.isInteger(value.pid) && value.pid > 0 && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}
function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
async function releaseLock(filePath, token) {
  const current = await readLock(filePath);
  if (current?.token === token && current.pid === process.pid) {
    await unlink2(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function acquireLock(filePath, deadline, depth = 0) {
  if (depth > 16) return null;
  const token = randomUUID2();
  while (true) {
    let file;
    try {
      file = await open2(filePath, "wx", 384);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (file) {
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, token }));
        await file.sync();
      } finally {
        await file.close();
      }
      const current = await readLock(filePath);
      return current?.token === token && current.pid === process.pid ? token : null;
    }
    const existing = await readLock(filePath);
    if (!existing) {
      console.warn(`[timeline] preserving malformed session lock ${filePath}`);
      return null;
    }
    if (isDead(existing.pid)) {
      const guardPath = `${filePath}.reclaim`;
      const guardToken = await acquireLock(guardPath, deadline, depth + 1);
      if (guardToken) {
        try {
          const guard = await readLock(guardPath);
          const current = await readLock(filePath);
          if (guard?.token === guardToken && guard.pid === process.pid && current?.token === existing.token && current.pid === existing.pid && isDead(current.pid)) {
            await unlink2(filePath).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        } finally {
          await releaseLock(guardPath, guardToken);
        }
        continue;
      }
    }
    if (Date.now() >= deadline) return null;
    await delay(20);
  }
}
async function withSessionLock(home, key, action) {
  const filePath = lockPath(home, key);
  await mkdir2(path7.dirname(filePath), { recursive: true, mode: 448 });
  const token = await acquireLock(filePath, Date.now() + 300);
  if (!token) return { acquired: false };
  try {
    return { acquired: true, value: await action() };
  } finally {
    await releaseLock(filePath, token);
  }
}

// src/shared/collectors/reduce.ts
function eventTime(event3) {
  return event3.sourceAt ?? event3.observedAt;
}
function hasText2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function validUsage(usage) {
  return usage !== void 0 && [usage.input, usage.output, usage.cached].every((value) => Number.isFinite(value) && value >= 0);
}
function rootEvent(event3) {
  return event3.sourceSessionId === void 0;
}
function reduceEvents(state, events) {
  if (!state && events.length === 0) throw new Error("empty collector batch");
  const first = state ?? events[0];
  const next = {
    version: 1,
    agent: first.agent,
    nativeSessionId: first.nativeSessionId,
    events: { ...state?.events ?? {} }
  };
  for (const event3 of events) {
    if (event3.agent !== next.agent || event3.nativeSessionId !== next.nativeSessionId) {
      throw new Error("mixed collector sessions");
    }
    const prior = next.events[event3.eventId];
    if (!prior || event3.observedAt < prior.observedAt) next.events[event3.eventId] = event3;
  }
  return next;
}
function toSnapshot(state) {
  const events = Object.values(state.events).filter((event3) => !event3.unresolvedParent).sort((a, b) => eventTime(a) - eventTime(b) || a.eventId.localeCompare(b.eventId));
  if (events.length === 0) return null;
  const prompts = /* @__PURE__ */ new Map();
  const confirmed = /* @__PURE__ */ new Set();
  const toolCalls = /* @__PURE__ */ new Map();
  const skills = /* @__PURE__ */ new Set();
  let hasActivity = false;
  for (const event3 of events) {
    if (rootEvent(event3) && event3.turnId && hasText2(event3.prompt)) {
      prompts.set(event3.turnId, event3.prompt);
    }
    if (rootEvent(event3) && event3.turnId && event3.confirmsTurn) confirmed.add(event3.turnId);
    if (event3.tool || rootEvent(event3) && (event3.confirmsTurn || event3.usage)) {
      hasActivity = true;
    }
    if (event3.tool) {
      const source = event3.sourceSessionId ?? event3.nativeSessionId;
      const key = JSON.stringify([source, event3.turnId ?? "", event3.tool.id]);
      if (!toolCalls.has(key)) toolCalls.set(key, event3.tool);
      if (hasText2(event3.tool.skill)) skills.add(event3.tool.skill);
    }
  }
  const confirmedPrompts = [...prompts].filter(([turnId2]) => confirmed.has(turnId2)).map(([, prompt]) => prompt);
  if (!hasActivity && confirmedPrompts.length === 0) return null;
  const rootEvents = events.filter(rootEvent);
  const rootEventsById = new Map(rootEvents.map((event3) => [event3.eventId, event3]));
  const exactResolutions = /* @__PURE__ */ new Map();
  for (const event3 of rootEvents) {
    if (event3.needsHydration !== false || !event3.resolvesEventId) continue;
    const original = rootEventsById.get(event3.resolvesEventId);
    if (!original || original.needsHydration !== true || eventTime(original) !== eventTime(event3)) continue;
    const resolutions = exactResolutions.get(original.eventId) ?? [];
    resolutions.push(event3);
    exactResolutions.set(original.eventId, resolutions);
  }
  const latestValue = (select, usable) => {
    let value;
    for (const event3 of rootEvents) {
      const candidate = select(event3);
      if (!usable(candidate)) continue;
      const superseded = exactResolutions.get(event3.eventId)?.some((resolution) => usable(select(resolution))) ?? false;
      if (!superseded) value = candidate;
    }
    return value;
  };
  const latestText = (select) => latestValue(select, hasText2);
  let usage;
  for (const event3 of rootEvents) {
    if (validUsage(event3.usage)) usage = event3.usage;
  }
  const toolCounts = /* @__PURE__ */ new Map();
  for (const tool of toolCalls.values()) {
    if (!tool) continue;
    toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1);
  }
  const title = latestText((event3) => event3.title);
  const firstPrompt = confirmedPrompts[0]?.slice(0, 140);
  const summary = title ?? firstPrompt ?? "(untitled session)";
  const firstTime = eventTime(events[0]);
  const lastTime = eventTime(events.at(-1));
  return {
    sessionId: sessionKey(state.agent, state.nativeSessionId),
    project: latestText((event3) => event3.project) ?? "",
    agentName: state.agent,
    startedAt: firstTime,
    endedAt: lastTime,
    durationMs: Math.max(0, lastTime - firstTime),
    turns: confirmedPrompts.length,
    tokensInput: usage?.input ?? 0,
    tokensOutput: usage?.output ?? 0,
    tokensCached: usage?.cached ?? 0,
    tokenStatus: usage?.status ?? "unavailable",
    summary,
    summarySource: title || !firstPrompt ? "auto" : "first_message",
    transcriptPath: latestText((event3) => event3.transcriptPath) ?? `${state.agent}://${state.nativeSessionId}`,
    fileSize: latestValue((event3) => event3.fileSize, (value) => value !== void 0) ?? 0,
    tools: [...toolCounts].sort(([a], [b]) => a.localeCompare(b)).map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...skills].sort((a, b) => a.localeCompare(b)),
    model: latestText((event3) => event3.model) ?? null
  };
}

// src/shared/collectors/ingest-event.ts
var SOFT_BUDGET_MS = 1e3;
function keyOf(event3) {
  return sessionKey(event3.agent, event3.nativeSessionId);
}
function sqliteBusy(error) {
  const value = error;
  return value.code === "SQLITE_BUSY" || value.code === "SQLITE_LOCKED" || typeof value.message === "string" && /database is (?:busy|locked)/i.test(value.message);
}
async function writeWithRetry(write, snapshot) {
  const waits = [25, 75, 150];
  for (let attempt = 0; ; attempt += 1) {
    try {
      write(snapshot);
      return;
    } catch (error) {
      if (!sqliteBusy(error) || attempt === waits.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  }
}
async function hydrateWithinBudget(hydrate2, events, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("collector soft budget exhausted");
  let timer;
  try {
    return await Promise.race([
      hydrate2(events),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("collector hydration exceeded soft budget")), remaining);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function forwardedEvent(event3) {
  const { eventId: _eventId, observedAt, ...semantic } = event3;
  return { ...semantic, observedAt, eventId: eventKey(semantic) };
}
function resolves(original, candidate) {
  if (candidate.resolvesEventId !== original.eventId || candidate.agent !== original.agent) return false;
  return candidate.nativeSessionId === original.nativeSessionId || candidate.sourceSessionId === original.nativeSessionId;
}
async function processKey(key, deps, deadline) {
  if (Date.now() >= deadline) return { status: "queued", forwarded: [] };
  const journal = createJournal(deps.home);
  const locked = await withSessionLock(deps.home, key, async () => {
    const pending = await journal.pending(key);
    if (pending.length === 0) return { status: "ignored", forwarded: [] };
    let previous;
    try {
      previous = await journal.load(key);
    } catch (error) {
      if (error instanceof CorruptCollectorStateError) console.warn(`[timeline] ${error.message}`);
      else console.warn(`[timeline] failed to load collector state: ${String(error)}`);
      return { status: "queued", forwarded: [] };
    }
    let hydrated;
    try {
      hydrated = await hydrateWithinBudget(deps.hydrate, [
        ...Object.values(previous?.events ?? {}),
        ...pending
      ], deadline);
    } catch (error) {
      console.warn(`[timeline] collector hydration failed: ${String(error)}`);
      return { status: "queued", forwarded: [] };
    }
    const local = hydrated.filter((event3) => keyOf(event3) === key);
    const crossSession = hydrated.filter((event3) => keyOf(event3) !== key).map(forwardedEvent);
    const forwarded = /* @__PURE__ */ new Set();
    try {
      for (const event3 of crossSession) {
        await journal.enqueue(event3);
        forwarded.add(keyOf(event3));
      }
    } catch (error) {
      console.warn(`[timeline] collector forwarding failed: ${String(error)}`);
      return { status: "queued", forwarded: [] };
    }
    const unresolved = pending.filter((event3) => event3.unresolvedParent);
    const unresolvedAck = unresolved.filter((event3) => crossSession.some((forwarded2) => resolves(event3, forwarded2)) || local.some((resolved) => !resolved.unresolvedParent && resolves(event3, resolved))).map((event3) => event3.eventId);
    const hydrationAck = pending.filter((event3) => event3.needsHydration && !event3.resolvesEventId && [...local, ...crossSession].some((completed) => completed.needsHydration === false && resolves(event3, completed))).map((event3) => event3.eventId);
    const retained = new Set(pending.filter((event3) => event3.unresolvedParent && !unresolvedAck.includes(event3.eventId) || event3.needsHydration && !event3.resolvesEventId && !hydrationAck.includes(event3.eventId)).map((event3) => event3.eventId));
    const reduciblePending = pending.filter((event3) => !event3.unresolvedParent);
    if (!previous && reduciblePending.length === 0 && local.length === 0) {
      await journal.ack(key, pending.filter((event3) => !retained.has(event3.eventId)).map((event3) => event3.eventId));
      return {
        status: retained.size > 0 ? "queued" : "ignored",
        forwarded: [...forwarded]
      };
    }
    const state = reduceEvents(previous, [...reduciblePending, ...local]);
    const snapshot = toSnapshot(state);
    try {
      if (snapshot) await writeWithRetry(deps.write, snapshot);
      await journal.save(key, state);
      await journal.ack(key, pending.filter((event3) => !retained.has(event3.eventId)).map((event3) => event3.eventId));
    } catch (error) {
      console.warn(`[timeline] collector snapshot queued: ${String(error)}`);
      return { status: "queued", forwarded: [...forwarded] };
    }
    return {
      status: retained.size > 0 ? "queued" : snapshot ? "written" : "ignored",
      forwarded: [...forwarded]
    };
  });
  return locked.acquired ? locked.value : { status: "queued", forwarded: [] };
}
async function ingestEvents(events, deps) {
  if (events.length === 0) return "ignored";
  const deadline = Date.now() + SOFT_BUDGET_MS;
  const journal = createJournal(deps.home);
  const grouped = /* @__PURE__ */ new Map();
  for (const event3 of events) {
    await journal.enqueue(event3);
    const key = keyOf(event3);
    grouped.set(key, [...grouped.get(key) ?? [], event3]);
  }
  let aggregate = "ignored";
  const followups = /* @__PURE__ */ new Set();
  for (const key of grouped.keys()) {
    const result = await processKey(key, deps, deadline);
    if (result.status === "queued") aggregate = "queued";
    else if (result.status === "written" && aggregate === "ignored") aggregate = "written";
    result.forwarded.forEach((forwarded) => followups.add(forwarded));
  }
  for (const key of followups) {
    const result = await processKey(key, deps, deadline);
    if (result.status === "queued") aggregate = "queued";
    else if (result.status === "written" && aggregate === "ignored") aggregate = "written";
  }
  return aggregate;
}
async function replayPending(deps) {
  const journal = createJournal(deps.home);
  const deadline = Date.now() + SOFT_BUDGET_MS;
  let written = 0;
  let queued = 0;
  const queue = await journal.keys();
  const seen = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await processKey(key, deps, deadline);
    if (result.status === "written") written += 1;
    if (result.status === "queued") queued += 1;
    queue.push(...result.forwarded);
  }
  return { written, queued };
}

// src/ingest.ts
var cli = cac("ohmyc-timeline-ingest");
cli.command("", "Ingest a single session into the timeline DB").option("--session-id <id>", "Session UUID (disk-path mode)").option("--transcript-path <path>", "Path to JSONL transcript (disk-path mode)").option("--agent-name <name>", "Agent name for disk-path mode", { default: "claude" }).option("--raw", "Read pre-parsed ParsedSessionData JSON from stdin").option("--hook <host>", "Read native cursor, grok, or auto hook JSON from stdin").option("--replay-pending", "Replay durable collector events").option("--detect-host", "Print cursor, grok, or legacy for hook JSON on stdin").action(async (options) => {
  if (options.detectHost) {
    if (options.raw || options.hook || options.replayPending || options.sessionId || options.transcriptPath) {
      fail("--detect-host cannot be combined with a write mode");
    }
    const input = await readJsonStdin("--detect-host");
    process.stdout.write(`${detectHost(input, process.env) ?? "legacy"}
`);
    return;
  }
  const diskMode = options.sessionId !== void 0 || options.transcriptPath !== void 0;
  const writeModes = [options.raw, options.hook !== void 0, options.replayPending, diskMode].filter(Boolean).length;
  if (writeModes > 1) {
    fail("--hook, --raw, --replay-pending, and disk mode are mutually exclusive");
  }
  if (options.raw) {
    await runRawMode();
    return;
  }
  if (options.hook !== void 0) {
    await runHookMode(options.hook);
    return;
  }
  if (options.replayPending) {
    await runReplayMode();
    return;
  }
  if (!options.sessionId || !options.transcriptPath) {
    console.error("error: --session-id and --transcript-path are required when --raw is not set");
    process.exit(1);
  }
  await runDiskMode(options.sessionId, options.transcriptPath, options.agentName ?? "claude");
});
cli.help();
cli.parse();
async function runDiskMode(sessionId, transcriptPath, agentName) {
  const db = openDatabase();
  try {
    const data = parseTranscript(sessionId, transcriptPath, { agentName });
    if (agentName === "claude") {
      const records = readFileSync2(transcriptPath, "utf8").split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      Object.assign(data, collectClaudeUsage(records));
    }
    createWriter(db).writeSession(data);
  } finally {
    closeDatabase(db);
  }
}
async function runRawMode() {
  const data = await readJsonStdin("--raw");
  const db = openDatabase();
  try {
    createWriter(db).writeSession(data);
  } finally {
    closeDatabase(db);
  }
}
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
async function readJsonStdin(mode) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) fail(`${mode} expects JSON on stdin`);
  try {
    return JSON.parse(raw);
  } catch (parseError) {
    fail(`invalid JSON on stdin: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }
}
function collectorHome() {
  return process.env.OHMYC_HOME ?? path8.join(os3.homedir(), ".config", "ohmyc");
}
function grokHome() {
  return process.env.GROK_HOME ?? path8.join(os3.homedir(), ".grok");
}
function hydrate(events) {
  const agent = events[0]?.agent;
  if (agent === "cursor") return hydrateCursor(events);
  if (agent === "grok") return hydrateGrok(events, grokHome());
  return Promise.resolve([]);
}
function parseHook(host, input) {
  const observedAt = Date.now();
  return host === "cursor" ? parseCursorHook(input, observedAt) : parseGrokHook(input, observedAt);
}
async function withCollectorWriter(action) {
  let db;
  let writer;
  try {
    await action((data) => {
      db ??= openDatabase();
      writer ??= createWriter(db);
      return writer.writeSession(data);
    });
  } finally {
    if (db) closeDatabase(db);
  }
}
async function runHookMode(requestedHost) {
  if (!["cursor", "grok", "auto"].includes(requestedHost)) {
    fail("--hook must be cursor, grok, or auto");
  }
  const input = await readJsonStdin("--hook");
  const host = requestedHost === "auto" ? detectHost(input, process.env) : requestedHost;
  if (!host) fail("unable to detect native hook host");
  const events = parseHook(host, input);
  if (events.length === 0) fail(`invalid ${host} hook payload`);
  await withCollectorWriter(async (write) => {
    await ingestEvents(events, { home: collectorHome(), hydrate, write });
  });
}
async function runReplayMode() {
  await withCollectorWriter(async (write) => {
    await replayPending({ home: collectorHome(), hydrate, write });
  });
}
