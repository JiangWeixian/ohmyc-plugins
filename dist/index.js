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
function responseData(label, response) {
  if (response.error || response.data === undefined) {
    throw new Error(`${label} failed: ${JSON.stringify(response.error ?? "missing data")}`);
  }
  return response.data;
}
function createSessionTreeLoader(client) {
  const session = client.session;
  return async (observedSessionId) => {
    const nodes = new Map;
    function loadNode(sessionId, knownInfo) {
      const existing = nodes.get(sessionId);
      if (existing)
        return existing;
      const node = Promise.all([
        knownInfo ? Promise.resolve({ data: knownInfo }) : session.get({ path: { id: sessionId }, url: "/session/{id}" }),
        session.messages({ path: { id: sessionId }, url: "/session/{id}/message" }),
        session.children({ path: { id: sessionId }, url: "/session/{id}/children" })
      ]).then(async ([infoResponse, messagesResponse, childrenResponse]) => {
        const info = responseData("session.get", infoResponse);
        const messages = responseData("session.messages", messagesResponse);
        const childInfos = responseData("session.children", childrenResponse);
        const children = await Promise.all(childInfos.map((child) => loadNode(String(child.id), child)));
        return { info, messages, children };
      });
      nodes.set(sessionId, node);
      node.catch(() => {
        if (nodes.get(sessionId) === node)
          nodes.delete(sessionId);
      });
      return node;
    }
    const observed = await loadNode(observedSessionId);
    if (!observed.info.parentID)
      return observed;
    let rootInfo = observed.info;
    while (rootInfo.parentID) {
      rootInfo = responseData("session.get", await session.get({ path: { id: String(rootInfo.parentID) }, url: "/session/{id}" }));
    }
    return loadNode(String(rootInfo.id), rootInfo);
  };
}
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
var defaultTitlePattern = /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isDefaultSessionTitle(title) {
  return !title?.trim() || defaultTitlePattern.test(title);
}
function keyed(sessionId, id) {
  return `${sessionId}:${id}`;
}
function createAccumulator(sessionId, project = "unknown") {
  const now = Date.now();
  return {
    sessionId,
    project,
    startedAt: now,
    endedAt: now,
    title: null,
    sessionModel: null,
    messages: new Map,
    textParts: new Map,
    toolCalls: new Map,
    toolPartIndex: new Map,
    taskHookAliases: new Map,
    liveMessageKeys: new Set,
    livePartKeys: new Set,
    liveToolCallKeys: new Set,
    messageTombstones: new Set,
    partTombstones: new Set,
    liveRootMetadataFields: new Set,
    legacySkills: new Set,
    dirty: false,
    persisted: false,
    hydrated: false
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
  const messages = [...acc.messages.values()];
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const rootUserMessages = userMessages.filter((message) => message.sessionId === acc.sessionId).sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
  const firstText = rootUserMessages.flatMap((message) => [...acc.textParts.values()].filter((part) => part.sessionId === acc.sessionId && part.messageId === message.messageId).filter((part) => !part.synthetic && !part.ignored && part.text.trim()).sort((a, b) => a.partId.localeCompare(b.partId)).map((part) => part.text.trim()))[0];
  const explicitTitle = isDefaultSessionTitle(acc.title) ? null : acc.title.trim();
  const summary = explicitTitle ?? firstText ?? "(untitled session)";
  const tokensInput = assistantMessages.reduce((sum, message) => sum + message.tokens.input, 0);
  const tokensOutput = assistantMessages.reduce((sum, message) => sum + message.tokens.output, 0);
  const tokensCached = assistantMessages.reduce((sum, message) => sum + message.tokens.cached, 0);
  const latestAssistant = assistantMessages.sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId)).at(-1);
  const toolCounts = new Map;
  const skills = new Set(acc.legacySkills);
  for (const call of acc.toolCalls.values()) {
    toolCounts.set(call.toolName, (toolCounts.get(call.toolName) ?? 0) + 1);
    if ((call.toolName === "Skill" || call.toolName === "skill") && typeof call.args.name === "string") {
      skills.add(call.args.name);
    }
  }
  return {
    sessionId: acc.sessionId,
    project: acc.project,
    agentName: "opencode",
    startedAt: acc.startedAt,
    endedAt: acc.endedAt,
    durationMs: acc.endedAt - acc.startedAt,
    turns: userMessages.length,
    tokensInput,
    tokensOutput,
    tokensCached,
    summary,
    summarySource: explicitTitle || !firstText ? "auto" : "first_message",
    transcriptPath: `opencode://${acc.sessionId}`,
    fileSize: 0,
    tools: [...toolCounts.entries()].map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...skills],
    model: latestAssistant?.model ?? acc.sessionModel
  };
}
function getEventSessionID(event) {
  const properties = event.properties;
  return properties?.sessionID ?? properties?.info?.sessionID ?? properties?.info?.session_id ?? properties?.part?.sessionID ?? properties?.part?.session_id ?? properties?.info?.id;
}
function createEventHandler(deps) {
  const sessions = new Map;
  const childToParent = new Map;
  const rootSessionIds = new Set;
  const queues = new Map;
  const hydrations = new Map;
  let routingTail = Promise.resolve();
  let legacyCallCount = 0;
  function enqueue(rootId, work) {
    const previous = queues.get(rootId) ?? Promise.resolve();
    const current = previous.catch(() => {
      return;
    }).then(work);
    queues.set(rootId, current);
    return current.finally(() => {
      if (queues.get(rootId) === current)
        queues.delete(rootId);
    });
  }
  function canCheckpoint(acc) {
    if (!rootSessionIds.has(acc.sessionId)) {
      deps.log("warn", "Skipped non-root OpenCode checkpoint", { sessionID: acc.sessionId });
      return false;
    }
    return true;
  }
  async function checkpoint(acc) {
    if (!canCheckpoint(acc))
      return false;
    acc.endedAt = Date.now();
    try {
      deps.writer.writeSession(toParsedSessionData(acc));
      acc.persisted = true;
      acc.dirty = false;
      return true;
    } catch (error) {
      acc.dirty = true;
      deps.log("error", "Failed to write OpenCode checkpoint", {
        sessionID: acc.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
  function getRootSessionID(sessionID) {
    let rootID = sessionID;
    const visited = new Set;
    while (childToParent.has(rootID) && !visited.has(rootID)) {
      visited.add(rootID);
      rootID = childToParent.get(rootID);
    }
    return rootID;
  }
  function getAccumulator(sessionId) {
    const targetId = getRootSessionID(sessionId);
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
  function putToolCall(acc, value, callKey = keyed(value.sessionId, value.callId), source = "live") {
    const partKey = value.partId ? keyed(value.sessionId, value.partId) : null;
    if (source === "hydrated" && (partKey !== null && (acc.livePartKeys.has(partKey) || acc.partTombstones.has(partKey)) || value.messageId !== null && acc.messageTombstones.has(keyed(value.sessionId, value.messageId))))
      return;
    const existing = acc.toolCalls.get(callKey);
    if (source === "hydrated" && acc.liveToolCallKeys.has(callKey) && existing) {
      const messageId = existing.messageId ?? value.messageId;
      const partId = existing.partId ?? value.partId;
      acc.toolCalls.set(callKey, { ...existing, messageId, partId });
      if (partId)
        acc.toolPartIndex.set(keyed(value.sessionId, partId), callKey);
      acc.dirty = true;
      return;
    }
    if (source === "live") {
      acc.liveToolCallKeys.add(callKey);
      if (partKey !== null)
        acc.partTombstones.delete(partKey);
    }
    acc.toolCalls.set(callKey, { ...existing, ...value });
    if (partKey !== null)
      acc.toolPartIndex.set(partKey, callKey);
    acc.dirty = true;
  }
  function isTaskTool(toolName) {
    return typeof toolName === "string" && toolName.toLowerCase() === "task";
  }
  function reconcileTaskHookAlias(acc, sessionID, part) {
    const partId = String(part.id);
    const callId = String(part.callID);
    const partKey = keyed(sessionID, partId);
    const callKey = keyed(sessionID, callId);
    const alias = acc.toolCalls.get(partKey);
    const canonical = acc.toolCalls.get(callKey);
    if (partKey === callKey || !isTaskTool(part.tool) || canonical && !isTaskTool(canonical.toolName) || alias && isTaskTool(alias.toolName) && alias.partId !== null)
      return;
    if (alias && isTaskTool(alias.toolName)) {
      acc.toolCalls.delete(partKey);
      acc.liveToolCallKeys.delete(partKey);
      acc.toolCalls.set(callKey, {
        ...canonical,
        ...alias,
        callId,
        messageId: part.messageID === undefined ? null : String(part.messageID),
        partId
      });
      acc.liveToolCallKeys.add(callKey);
    }
    acc.taskHookAliases.set(partKey, callKey);
    const existing = acc.toolCalls.get(callKey);
    return acc.liveToolCallKeys.has(callKey) ? existing?.args : undefined;
  }
  function getArgs(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function putMessageSnapshot(acc, sessionID, info, source = "live") {
    if (!info || info.role !== "user" && info.role !== "assistant" || info.id === undefined)
      return;
    const messageKey = keyed(sessionID, String(info.id));
    if (source === "hydrated" && (acc.liveMessageKeys.has(messageKey) || acc.messageTombstones.has(messageKey)))
      return;
    const cache = info.tokens?.cache;
    const snapshot = {
      sessionId: sessionID,
      messageId: String(info.id),
      role: info.role,
      createdAt: Number(info.time?.created ?? Date.now()),
      model: info.modelID ? String(info.modelID) : null,
      tokens: {
        input: Number(info.tokens?.input ?? 0),
        output: Number(info.tokens?.output ?? 0),
        cached: Number(cache?.read ?? 0) + Number(cache?.write ?? 0)
      }
    };
    if (source === "live") {
      acc.liveMessageKeys.add(messageKey);
      acc.messageTombstones.delete(messageKey);
    }
    acc.messages.set(messageKey, snapshot);
    acc.dirty = true;
  }
  function putPartSnapshot(acc, sessionID, part, source = "live") {
    if (part?.type === "text" && part.id !== undefined && part.messageID !== undefined) {
      const partKey = keyed(sessionID, String(part.id));
      const messageKey = keyed(sessionID, String(part.messageID));
      if (source === "hydrated" && (acc.livePartKeys.has(partKey) || acc.partTombstones.has(partKey) || acc.messageTombstones.has(messageKey)))
        return;
      const snapshot = {
        sessionId: sessionID,
        partId: String(part.id),
        messageId: String(part.messageID),
        text: String(part.text ?? ""),
        synthetic: Boolean(part.synthetic),
        ignored: Boolean(part.ignored)
      };
      if (source === "live") {
        acc.livePartKeys.add(partKey);
        acc.partTombstones.delete(partKey);
      }
      acc.textParts.set(partKey, snapshot);
      acc.dirty = true;
    } else if (part?.type === "tool" && part.id !== undefined && part.callID !== undefined && part.tool !== undefined) {
      const partKey = keyed(sessionID, String(part.id));
      const messageKey = part.messageID === undefined ? null : keyed(sessionID, String(part.messageID));
      if (source === "hydrated" && (acc.livePartKeys.has(partKey) || acc.partTombstones.has(partKey) || messageKey !== null && acc.messageTombstones.has(messageKey)))
        return;
      if (source === "live") {
        acc.livePartKeys.add(partKey);
        acc.partTombstones.delete(partKey);
      }
      const liveArgs = reconcileTaskHookAlias(acc, sessionID, part);
      putToolCall(acc, {
        sessionId: sessionID,
        callId: String(part.callID),
        toolName: String(part.tool),
        args: liveArgs ?? getArgs(part.state?.input),
        messageId: part.messageID === undefined ? null : String(part.messageID),
        partId: String(part.id)
      }, keyed(sessionID, String(part.callID)), source);
    }
  }
  function applyRootMetadata(acc, info, source) {
    function assign(field, value) {
      if (source === "hydrated" && acc.liveRootMetadataFields.has(field))
        return;
      if (field === "title")
        acc.title = value;
      else if (field === "startedAt")
        acc.startedAt = value;
      else if (field === "endedAt")
        acc.endedAt = value;
      else
        acc.sessionModel = value;
      if (source === "live")
        acc.liveRootMetadataFields.add(field);
    }
    if (info.title !== undefined)
      assign("title", String(info.title));
    if (info.time?.created !== undefined)
      assign("startedAt", Number(info.time.created));
    if (info.time?.updated !== undefined)
      assign("endedAt", Number(info.time.updated));
    if (info.model?.id)
      assign("sessionModel", String(info.model.id));
    else if (info.modelID)
      assign("sessionModel", String(info.modelID));
    acc.dirty = true;
  }
  function collectHydratedNodes(tree) {
    const nodes = [];
    function visit(node) {
      if (!node.info?.id)
        throw new Error("Hydrated OpenCode session is missing an ID");
      nodes.push({ sessionID: String(node.info.id), node });
      for (const child of node.children)
        visit(child);
    }
    visit(tree);
    return nodes;
  }
  function mergeAccumulator(target, source) {
    for (const [key, value] of source.messages) {
      if (!target.messages.has(key))
        target.messages.set(key, value);
    }
    for (const [key, value] of source.textParts) {
      if (!target.textParts.has(key))
        target.textParts.set(key, value);
    }
    for (const [key, value] of source.toolCalls) {
      if (!target.toolCalls.has(key))
        target.toolCalls.set(key, value);
    }
    for (const [key, value] of source.toolPartIndex) {
      if (!target.toolPartIndex.has(key))
        target.toolPartIndex.set(key, value);
    }
    for (const [key, value] of source.taskHookAliases) {
      target.taskHookAliases.set(key, value);
    }
    for (const key of source.liveMessageKeys)
      target.liveMessageKeys.add(key);
    for (const key of source.livePartKeys)
      target.livePartKeys.add(key);
    for (const key of source.liveToolCallKeys)
      target.liveToolCallKeys.add(key);
    for (const key of source.messageTombstones)
      target.messageTombstones.add(key);
    for (const key of source.partTombstones)
      target.partTombstones.add(key);
    for (const skill of source.legacySkills)
      target.legacySkills.add(skill);
    target.dirty ||= source.dirty;
    target.persisted ||= source.persisted;
  }
  function clearSessionTombstones(acc, sessionID) {
    const prefix = `${sessionID}:`;
    for (const key of acc.messageTombstones) {
      if (key.startsWith(prefix))
        acc.messageTombstones.delete(key);
    }
    for (const key of acc.partTombstones) {
      if (key.startsWith(prefix))
        acc.partTombstones.delete(key);
    }
  }
  function clearTaskHookAliases(acc, sessionID) {
    const prefix = `${sessionID}:`;
    for (const key of acc.taskHookAliases.keys()) {
      if (key.startsWith(prefix))
        acc.taskHookAliases.delete(key);
    }
  }
  function mergeHydratedTree(tree, observedSessionID) {
    const nodes = collectHydratedNodes(tree);
    const rootSessionID = nodes[0].sessionID;
    const acc = getAccumulator(rootSessionID);
    const migratedSessionIDs = new Set([...nodes.map(({ sessionID }) => sessionID), observedSessionID]);
    for (const sessionID of migratedSessionIDs) {
      const source = sessions.get(sessionID);
      if (source && source !== acc) {
        mergeAccumulator(acc, source);
        sessions.delete(sessionID);
      }
    }
    for (const { sessionID } of nodes.slice(1))
      childToParent.set(sessionID, rootSessionID);
    if (observedSessionID !== rootSessionID)
      childToParent.set(observedSessionID, rootSessionID);
    applyRootMetadata(acc, tree.info, "hydrated");
    for (const { sessionID, node } of nodes) {
      for (const message of node.messages)
        putMessageSnapshot(acc, sessionID, message.info, "hydrated");
    }
    for (const { sessionID, node } of nodes) {
      for (const message of node.messages) {
        for (const part of message.parts)
          putPartSnapshot(acc, sessionID, part, "hydrated");
      }
    }
    acc.hydrated = true;
    rootSessionIds.add(rootSessionID);
    return rootSessionID;
  }
  function ensureRootRoute(sessionID) {
    const knownRoot = getRootSessionID(sessionID);
    if (rootSessionIds.has(knownRoot) || sessions.get(knownRoot)?.hydrated) {
      return Promise.resolve(knownRoot);
    }
    const existing = hydrations.get(sessionID);
    if (existing)
      return existing;
    const hydration = deps.loadSessionTree(sessionID).then((tree) => mergeHydratedTree(tree, sessionID)).catch((error) => {
      deps.log("warn", "OpenCode session hydration failed", {
        sessionID,
        error: error instanceof Error ? error.message : String(error)
      });
      return getRootSessionID(sessionID);
    });
    hydrations.set(sessionID, hydration);
    hydration.finally(() => {
      if (hydrations.get(sessionID) === hydration)
        hydrations.delete(sessionID);
    });
    return hydration;
  }
  function routeAndEnqueue(sessionID, work) {
    let queued = Promise.resolve();
    const routed = routingTail.catch(() => {
      return;
    }).then(async () => {
      const rootID = await ensureRootRoute(sessionID);
      queued = enqueue(rootID, () => work(rootID));
    });
    routingTail = routed.catch(() => {
      return;
    });
    return routed.then(() => queued);
  }
  async function recordToolCall(hookInput, args) {
    await routeAndEnqueue(hookInput.sessionID, async () => {
      const acc = getAccumulator(hookInput.sessionID);
      const realCallID = typeof hookInput.callID === "string" && hookInput.callID ? hookInput.callID : null;
      const directCallID = realCallID ?? `legacy-${++legacyCallCount}`;
      const directCallKey = realCallID ? keyed(hookInput.sessionID, realCallID) : Symbol(`legacy-tool-call:${directCallID}`);
      const taskAlias = realCallID && isTaskTool(hookInput.tool) ? acc.taskHookAliases.get(keyed(hookInput.sessionID, realCallID)) : undefined;
      const callKey = taskAlias && acc.toolCalls.has(taskAlias) ? taskAlias : directCallKey;
      const existing = acc.toolCalls.get(callKey);
      putToolCall(acc, {
        sessionId: hookInput.sessionID,
        callId: existing?.callId ?? directCallID,
        toolName: hookInput.tool,
        args,
        messageId: existing?.messageId ?? null,
        partId: existing?.partId ?? null
      }, callKey);
    });
  }
  return {
    sessions,
    childToParent,
    handler: ({ event }) => {
      const sessionID = getEventSessionID(event);
      if (!sessionID)
        return Promise.resolve();
      const parentID = event.type === "session.created" ? event.properties?.info?.parentID : undefined;
      if (parentID) {
        const rootParentID = getRootSessionID(parentID);
        childToParent.set(sessionID, rootParentID);
        deps.log("debug", "Subagent session detected", { sessionID, parentID: rootParentID });
      }
      const isNewRoot = event.type === "session.created" && !parentID;
      if (isNewRoot)
        rootSessionIds.add(sessionID);
      return routeAndEnqueue(sessionID, async () => {
        try {
          const acc = getAccumulator(sessionID);
          if (isNewRoot) {
            acc.hydrated = true;
          }
          switch (event.type) {
            case "session.created":
            case "session.updated": {
              const info = event.properties?.info;
              if (isChild(sessionID))
                break;
              const titleChanged = info?.title !== undefined && String(info.title) !== acc.title && !isDefaultSessionTitle(String(info.title));
              if (info)
                applyRootMetadata(acc, info, "live");
              if (event.type === "session.updated" && acc.persisted && titleChanged) {
                await checkpoint(acc);
              }
              break;
            }
            case "session.idle": {
              if (isChild(sessionID)) {
                return;
              }
              await checkpoint(acc);
              break;
            }
            case "session.deleted": {
              if (isChild(sessionID)) {
                clearSessionTombstones(acc, sessionID);
                clearTaskHookAliases(acc, sessionID);
                childToParent.delete(sessionID);
                return;
              }
              const checkpointed = await checkpoint(acc);
              if (checkpointed) {
                clearTaskHookAliases(acc, sessionID);
                sessions.delete(sessionID);
                for (const [childID, rootID] of childToParent) {
                  if (rootID === sessionID)
                    childToParent.delete(childID);
                }
                rootSessionIds.delete(sessionID);
              }
              break;
            }
            case "session.error": {
              if (isChild(sessionID)) {
                return;
              }
              await checkpoint(acc);
              break;
            }
            case "message.updated": {
              const info = event.properties?.info || event.properties?.message;
              putMessageSnapshot(acc, sessionID, info);
              break;
            }
            case "message.part.updated": {
              const part = event.properties?.part;
              putPartSnapshot(acc, sessionID, part);
              break;
            }
            case "message.part.removed": {
              const partID = event.properties?.partID;
              if (partID === undefined)
                break;
              const partKey = keyed(sessionID, String(partID));
              const callKey = acc.toolPartIndex.get(partKey);
              if (callKey) {
                acc.toolCalls.delete(callKey);
                acc.liveToolCallKeys.delete(callKey);
              }
              acc.taskHookAliases.delete(partKey);
              acc.toolPartIndex.delete(partKey);
              acc.textParts.delete(partKey);
              acc.livePartKeys.delete(partKey);
              acc.partTombstones.add(partKey);
              acc.dirty = true;
              break;
            }
            case "message.removed": {
              const messageID = event.properties?.messageID;
              if (messageID === undefined)
                break;
              const normalizedMessageID = String(messageID);
              const messageKey = keyed(sessionID, normalizedMessageID);
              let removed = acc.messages.delete(messageKey);
              acc.liveMessageKeys.delete(messageKey);
              acc.messageTombstones.add(messageKey);
              for (const [partKey, part] of acc.textParts) {
                if (part.sessionId === sessionID && part.messageId === normalizedMessageID) {
                  acc.textParts.delete(partKey);
                  acc.livePartKeys.delete(partKey);
                  acc.partTombstones.add(partKey);
                  removed = true;
                }
              }
              for (const [callKey, call] of acc.toolCalls) {
                if (call.sessionId === sessionID && call.messageId === normalizedMessageID) {
                  acc.toolCalls.delete(callKey);
                  acc.liveToolCallKeys.delete(callKey);
                  if (call.partId) {
                    const partKey = keyed(sessionID, call.partId);
                    acc.taskHookAliases.delete(partKey);
                    acc.toolPartIndex.delete(partKey);
                    acc.livePartKeys.delete(partKey);
                    acc.partTombstones.add(partKey);
                  }
                  removed = true;
                }
              }
              acc.dirty = removed || acc.messageTombstones.has(messageKey);
              break;
            }
          }
        } catch (error) {
          deps.log("error", "Event handler error", { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
    toolExecuteBefore: async (hookInput, hookOutput) => {
      try {
        await recordToolCall(hookInput, getArgs(hookOutput?.args));
      } catch (error) {
        deps.log("error", "Tool execute error", { error: error instanceof Error ? error.message : String(error) });
      }
    },
    toolExecuteAfter: async (hookInput, _hookOutput) => {
      try {
        const args = getArgs(hookInput.args);
        if (typeof hookInput.callID === "string" && hookInput.callID) {
          await recordToolCall(hookInput, args);
        } else if (hookInput.tool === "Skill" || hookInput.tool === "skill") {
          await routeAndEnqueue(hookInput.sessionID, async () => {
            const acc = getAccumulator(hookInput.sessionID);
            if (typeof args.name === "string") {
              acc.legacySkills.add(args.name);
              acc.dirty = true;
            }
          });
        }
      } catch (error) {
        deps.log("error", "Tool execute error", { error: error instanceof Error ? error.message : String(error) });
      }
    },
    dispose: async () => {
      await routingTail.catch(() => {
        return;
      });
      const pendingQueues = [...new Set(queues.values())];
      await Promise.allSettled(pendingQueues);
      const dirtyRoots = [...sessions.values()].filter((acc) => acc.dirty);
      await Promise.all(dirtyRoots.map((acc) => checkpoint(acc)));
      for (const acc of sessions.values())
        acc.taskHookAliases.clear();
      queues.clear();
      sessions.clear();
      childToParent.clear();
      rootSessionIds.clear();
      hydrations.clear();
    }
  };
}
async function disposeTimelineRuntime(disposeRuntime, close) {
  try {
    await disposeRuntime();
  } finally {
    close();
  }
}
function createTimelineHooks(input) {
  const runtime = createEventHandler({
    project: input.project,
    writer: input.writer,
    log,
    loadSessionTree: createSessionTreeLoader(input.client)
  });
  return {
    event: runtime.handler,
    "tool.execute.before": runtime.toolExecuteBefore,
    "tool.execute.after": runtime.toolExecuteAfter,
    dispose: () => disposeTimelineRuntime(runtime.dispose, input.close)
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
  return createTimelineHooks({
    project,
    writer,
    client: input.client,
    close: () => db?.close()
  });
};
var opencode_default = TimelinePlugin;
export {
  isDefaultSessionTitle,
  disposeTimelineRuntime,
  opencode_default as default,
  createTimelineHooks,
  createSessionTreeLoader,
  createEventHandler,
  createAccumulator,
  TimelinePlugin
};
