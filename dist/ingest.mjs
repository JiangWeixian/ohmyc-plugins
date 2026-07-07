#!/usr/bin/env node

// node_modules/@ohmyc/timeline/dist/chunk-KNZ4ZVYP.js
function createWriter(db) {
  const checkExisting = db.prepare("SELECT 1 FROM sessions WHERE session_id = ?");
  const upsertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      session_id, project, agent_name, started_at, ended_at, duration_ms,
      turns, tokens_input, tokens_output, tokens_cached,
      summary, summary_source, transcript_path, last_offset, ingested_at, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          data.model
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

// node_modules/@ohmyc/timeline/dist/chunk-J2QLCXDJ.js
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
    const timestamp = parsed.timestamp;
    if (typeof timestamp === "string") {
      const ts = new Date(timestamp).getTime();
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
  const project = extractProjectFromPath(transcriptPath);
  const startedAt = firstTimestamp ?? Date.now();
  const endedAt = lastTimestamp ?? Date.now();
  const durationMs = endedAt - startedAt;
  return {
    sessionId,
    project,
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
  let project = "unknown";
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
    const timestamp = parsed.timestamp;
    if (typeof timestamp === "string") {
      const ts = new Date(timestamp).getTime();
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
      project = payload.cwd;
    }
    if (parsed.type === "turn_context") {
      if (typeof payload.cwd === "string") {
        project = payload.cwd;
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
      const text = extractCodexMessageText(payload.content);
      if (text) {
        for (const skillName of extractCodexSkillNames(text)) {
          skills.add(skillName);
        }
        if (!isCodexSkillInjection(text)) {
          turns++;
          firstUserMessage ??= text;
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
    project: displayProject(project),
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
  const text = content.map((part) => {
    if (!part || typeof part !== "object") {
      return "";
    }
    const record = part;
    if (typeof record.text === "string") {
      return record.text;
    }
    return "";
  }).filter(Boolean).join("\n").trim();
  return text || null;
}
function extractCodexSkillNames(text) {
  return [...text.matchAll(/<skill\b[^>]*>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/skill>/g)].map((match) => match[1]?.trim()).filter(Boolean);
}
function isCodexSkillInjection(text) {
  const trimmed = text.trim();
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
function displayProject(project) {
  const homeDir = os.homedir();
  if (project.startsWith(homeDir)) {
    return `~${project.slice(homeDir.length)}`;
  }
  return project;
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

// node_modules/@ohmyc/timeline/dist/chunk-VIS7HKQB.js
var CURRENT_SCHEMA_VERSION = 3;
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
  model             TEXT
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
  3: "ALTER TABLE sessions ADD COLUMN agent_name TEXT;"
};

// node_modules/@ohmyc/timeline/dist/chunk-NKLR4VCN.js
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

// node_modules/@ohmyc/timeline/dist/chunk-3K3NWBLL.js
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

// node_modules/@ohmyc/timeline/dist/index.js
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

// node_modules/cac/dist/index.mjs
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
  usage(text) {
    this.usageText = text;
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
  usage(text) {
    this.globalCommand.usage(text);
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
var cli = cac("ohmyc-timeline-ingest");
cli.command("", "Ingest a single session into the timeline DB").option("--session-id <id>", "Session UUID (disk-path mode)").option("--transcript-path <path>", "Path to JSONL transcript (disk-path mode)").option("--agent-name <name>", "Agent name for disk-path mode", { default: "claude" }).option("--raw", "Read pre-parsed ParsedSessionData JSON from stdin").action(async (options) => {
  if (options.raw) {
    await runRawMode();
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
    createWriter(db).writeSession(data);
  } finally {
    closeDatabase(db);
  }
}
async function runRawMode() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    console.error("error: --raw expects JSON on stdin");
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (parseError) {
    console.error(`error: invalid JSON on stdin: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    process.exit(1);
  }
  const db = openDatabase();
  try {
    createWriter(db).writeSession(data);
  } finally {
    closeDatabase(db);
  }
}
