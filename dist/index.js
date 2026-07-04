// @bun
// opencode.ts
import { appendFileSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { Database } from "bun:sqlite";

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
        upsertSession.run(data.sessionId, data.project, data.agentName, data.startedAt, data.endedAt, data.durationMs, data.turns, data.tokensInput, data.tokensOutput, data.tokensCached, data.summary, data.summarySource, data.transcriptPath, data.fileSize, ingestedAt, data.model);
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

// opencode.ts
var LOG_FILE = path.join(os.tmpdir(), "timeline-plugin.log");
function log(level, message, extra) {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}
`;
  try {
    appendFileSync(LOG_FILE, entry);
  } catch {
    console.log(entry);
  }
}
function getDbPath() {
  const home = process.env.OHMYC_HOME || path.join(os.homedir(), ".config", "ohmyc");
  return path.join(home, "timeline.db");
}
function ensureDb() {
  const dbPath = getDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  return db;
}
function ensureSchema(db) {
  const hasSessions = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (hasSessions) {
    const hasAgentName = db.query("PRAGMA table_info(sessions)").all().some((col) => col.name === "agent_name");
    if (!hasAgentName) {
      db.exec("ALTER TABLE sessions ADD COLUMN agent_name TEXT;");
    }
    return;
  }
  db.exec(SCHEMA_SQL);
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(CURRENT_SCHEMA_VERSION));
}
function createAccumulator(sessionId, project) {
  return {
    sessionId,
    project: project ?? "unknown",
    startedAt: Date.now(),
    endedAt: Date.now(),
    turns: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCached: 0,
    tools: new Map,
    skills: new Set,
    firstUserMessage: null,
    summary: null,
    model: null
  };
}
function getProjectName(input) {
  if (input.project?.worktree) {
    return path.basename(input.project.worktree);
  }
  if (input.directory) {
    return path.basename(input.directory);
  }
  return "unknown";
}
function toParsedSessionData(acc) {
  return {
    sessionId: acc.sessionId,
    project: acc.project,
    agentName: "opencode",
    startedAt: acc.startedAt,
    endedAt: acc.endedAt,
    durationMs: acc.endedAt - acc.startedAt,
    turns: acc.turns,
    tokensInput: acc.tokensInput,
    tokensOutput: acc.tokensOutput,
    tokensCached: acc.tokensCached,
    summary: acc.summary ?? acc.firstUserMessage ?? "(untitled session)",
    summarySource: acc.firstUserMessage ? "first_message" : "auto",
    transcriptPath: `opencode://${acc.sessionId}`,
    fileSize: 0,
    tools: [...acc.tools.entries()].map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...acc.skills],
    model: acc.model
  };
}
function getEventSessionID(event) {
  if (event.properties?.sessionID) {
    return event.properties.sessionID;
  }
  if (event.properties?.info?.id) {
    return event.properties.info.id;
  }
  return;
}
function createEventHandler(deps) {
  const sessions = new Map;
  const childToParent = new Map;
  function getAccumulator(sessionId) {
    const parentId = childToParent.get(sessionId);
    const targetId = parentId ?? sessionId;
    let acc = sessions.get(targetId);
    if (!acc) {
      acc = createAccumulator(targetId, deps.project);
      sessions.set(targetId, acc);
    }
    return acc;
  }
  function isChild(sessionId) {
    return childToParent.has(sessionId);
  }
  return {
    sessions,
    childToParent,
    handler: async ({ event }) => {
      try {
        switch (event.type) {
          case "session.created": {
            const sessionID = getEventSessionID(event);
            if (sessionID) {
              const parentID = event.properties?.info?.parentID;
              if (parentID) {
                childToParent.set(sessionID, parentID);
                deps.log("debug", "Subagent session detected", { sessionID, parentID });
              }
              const acc = getAccumulator(sessionID);
              acc.startedAt = Math.min(acc.startedAt, Date.now());
            }
            break;
          }
          case "session.idle": {
            const sessionID = getEventSessionID(event);
            if (sessionID) {
              if (isChild(sessionID)) {
                childToParent.delete(sessionID);
                return;
              }
              const acc = sessions.get(sessionID);
              if (!acc) {
                return;
              }
              acc.endedAt = Date.now();
              const data = toParsedSessionData(acc);
              try {
                deps.writer.writeSession(data);
                sessions.delete(sessionID);
              } catch (writeError) {
                deps.log("error", "Failed to write session on idle", {
                  sessionID,
                  error: writeError instanceof Error ? writeError.message : String(writeError)
                });
              }
            }
            break;
          }
          case "session.deleted": {
            const sessionID = getEventSessionID(event);
            if (sessionID) {
              if (isChild(sessionID)) {
                childToParent.delete(sessionID);
                return;
              }
              const acc = sessions.get(sessionID);
              if (acc) {
                acc.endedAt = Date.now();
                deps.writer.writeSession(toParsedSessionData(acc));
                sessions.delete(sessionID);
              }
            }
            break;
          }
          case "session.error": {
            const sessionID = getEventSessionID(event);
            if (sessionID) {
              if (isChild(sessionID)) {
                childToParent.delete(sessionID);
                return;
              }
              const acc = sessions.get(sessionID);
              if (acc) {
                acc.endedAt = Date.now();
                deps.writer.writeSession(toParsedSessionData(acc));
              }
            }
            break;
          }
          case "message.updated": {
            const info = event.properties?.info || event.properties?.message;
            if (info) {
              const sessionID = info.sessionID || info.session_id;
              if (sessionID) {
                const acc = getAccumulator(sessionID);
                if (info.role === "user") {
                  acc.turns += 1;
                }
                if (info.role === "assistant" && info.tokens) {
                  acc.tokensInput += info.tokens.input || 0;
                  acc.tokensOutput += info.tokens.output || 0;
                  if (info.tokens.cache) {
                    acc.tokensCached += (info.tokens.cache.read || 0) + (info.tokens.cache.write || 0);
                  }
                }
                if (info.modelID) {
                  acc.model = info.modelID;
                }
              }
            }
            break;
          }
          case "message.part.updated": {
            const part = event.properties?.part;
            if (part && part.type === "text" && !part.synthetic && !part.ignored) {
              const sessionID = part.sessionID || part.session_id;
              if (sessionID && part.text?.trim()) {
                const acc = getAccumulator(sessionID);
                if (!acc.firstUserMessage) {
                  acc.firstUserMessage = part.text.trim();
                }
              }
            }
            break;
          }
        }
      } catch (error) {
        deps.log("error", "Event handler error", { error: error instanceof Error ? error.message : String(error) });
      }
    },
    toolExecuteBefore: async (hookInput) => {
      try {
        const acc = getAccumulator(hookInput.sessionID);
        acc.tools.set(hookInput.tool, (acc.tools.get(hookInput.tool) || 0) + 1);
      } catch (error) {
        deps.log("error", "Tool execute error", { error: error instanceof Error ? error.message : String(error) });
      }
    },
    toolExecuteAfter: async (hookInput) => {
      try {
        if (hookInput.tool === "Skill" || hookInput.tool === "skill") {
          const acc = getAccumulator(hookInput.sessionID);
          const args = hookInput.args;
          if (args && typeof args === "object" && typeof args.name === "string") {
            acc.skills.add(args.name);
          }
        }
      } catch (error) {
        deps.log("error", "Tool execute error", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}
var TimelinePlugin = async (input) => {
  const project = getProjectName(input);
  let db;
  let writer;
  try {
    db = ensureDb();
    writer = createWriter(db);
  } catch (error) {
    log("error", "Database init failed", { error: error instanceof Error ? error.message : String(error) });
    return {};
  }
  const { handler, toolExecuteBefore, toolExecuteAfter } = createEventHandler({ project, writer, log });
  return {
    event: handler,
    "tool.execute.before": toolExecuteBefore,
    "tool.execute.after": toolExecuteAfter
  };
};
var opencode_default = TimelinePlugin;
export {
  opencode_default as default,
  createEventHandler,
  createAccumulator,
  TimelinePlugin
};
