import fs from "node:fs";
import path from "node:path";
import { normalizePolicy } from "./domain.js";
import {
  appendJsonl,
  atomicWriteJson,
  ensureDir,
  nowIso,
  readJson,
  uid
} from "./util.js";

const SCHEMA_VERSION = 1;

export function createState(project, policyInput = {}) {
  const timestamp = nowIso();
  return {
    schema: SCHEMA_VERSION,
    project: String(project ?? "orchestra-project"),
    projectDescription: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0,
    seq: 0,
    policy: normalizePolicy(policyInput),
    tasks: {},
    order: [],
    attempts: [],
    events: [],
    notes: [],
    locks: {},
    modelStats: {},
    budget: {
      apiSpentCny: 0,
      reservedCny: 0,
      subscriptionTokens: 0,
      freeRuns: 0,
      paidRuns: 0,
      unknownCostRuns: 0
    },
    mainModelQuota: {
      status: "unknown",
      reason: "Provider subscription quota is not exposed to AgentOrchestra. Do not infer a remaining value."
    },
    run: {
      status: "idle",
      stopReason: null,
      startedAt: null,
      finishedAt: null,
      lastSummary: null
    }
  };
}

export class Store {
  constructor(root, { project = "orchestra-project", policy = {} } = {}) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, ".orchestra");
    this.stateFile = path.join(this.dir, "state.json");
    this.journalFile = path.join(this.dir, "journal.jsonl");
    ensureDir(this.dir);
    this.state = this.load() ?? createState(project, policy);
    if (!fs.existsSync(this.stateFile)) this.save();
  }

  load() {
    if (!fs.existsSync(this.stateFile)) return null;
    const state = readJson(this.stateFile);
    if (state.schema !== SCHEMA_VERSION) {
      throw new Error(`Unsupported state schema ${state.schema}; expected ${SCHEMA_VERSION}. Back up .orchestra/state.json before migrating.`);
    }
    state.tasks ??= {};
    state.order ??= Object.keys(state.tasks);
    state.attempts ??= [];
    state.events ??= [];
    state.notes ??= [];
    state.locks ??= {};
    state.modelStats ??= {};
    state.budget ??= {};
    state.budget.apiSpentCny ??= 0;
    state.budget.reservedCny ??= 0;
    state.budget.subscriptionTokens ??= 0;
    state.budget.freeRuns ??= 0;
    state.budget.paidRuns ??= 0;
    state.budget.unknownCostRuns ??= 0;
    state.policy = normalizePolicy(state.policy);
    return state;
  }

  save() {
    this.state.updatedAt = nowIso();
    this.state.revision = Number(this.state.revision ?? 0) + 1;
    atomicWriteJson(this.stateFile, this.state);
    return this;
  }

  recordEvent(level, kind, message, data = {}) {
    this.state.seq = Number(this.state.seq ?? 0) + 1;
    const event = {
      id: uid("evt"),
      seq: this.state.seq,
      ts: nowIso(),
      level,
      kind,
      message,
      data
    };
    this.state.events.push(event);
    if (this.state.events.length > 800) this.state.events.splice(0, this.state.events.length - 800);
    try {
      appendJsonl(this.journalFile, event);
    } catch (error) {
      process.stderr.write(`[agentorchestra] journal append failed: ${error.message}\n`);
    }
    this.save();
    return event;
  }

  getState() {
    return this.state;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  installPlan(plan, { replace = true } = {}) {
    if (replace) {
      this.state.project = plan.project;
      this.state.projectDescription = plan.description ?? "";
      this.state.policy = normalizePolicy(plan.policy);
      this.state.tasks = {};
      this.state.order = [];
      this.state.attempts = [];
      this.state.locks = {};
      this.state.modelStats = {};
      this.state.budget = {
        apiSpentCny: 0,
        reservedCny: 0,
        subscriptionTokens: 0,
        freeRuns: 0,
        paidRuns: 0,
        unknownCostRuns: 0
      };
      this.state.run = { status: "idle", stopReason: null, startedAt: null, finishedAt: null, lastSummary: null };
    } else {
      this.state.policy = normalizePolicy({ ...this.state.policy, ...plan.policy });
      if (plan.description) this.state.projectDescription = plan.description;
    }
    for (const task of plan.tasks) {
      if (!this.state.tasks[task.id]) this.state.order.push(task.id);
      this.state.tasks[task.id] = task;
    }
    this.state.seq = Number(this.state.seq ?? 0) + 1;
    this.recordEvent("info", "plan.installed", `${plan.tasks.length} tasks installed for ${plan.project}`, {
      replace,
      project: plan.project,
      taskCount: plan.tasks.length
    });
    return this.state;
  }

  updateTask(taskId, patch, { eventKind = null, eventMessage = null, eventData = {} } = {}) {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    Object.assign(task, patch, { updatedAt: nowIso() });
    if (eventKind) this.recordEvent("info", eventKind, eventMessage ?? `${taskId} updated`, { taskId, ...eventData });
    else this.save();
    return task;
  }

  addTask(task) {
    if (this.state.tasks[task.id]) throw new Error(`Task already exists: ${task.id}`);
    this.state.tasks[task.id] = task;
    this.state.order.push(task.id);
    this.save();
    return task;
  }

  addTasks(tasks) {
    for (const task of tasks) {
      if (this.state.tasks[task.id]) throw new Error(`Task already exists: ${task.id}`);
      this.state.tasks[task.id] = task;
      this.state.order.push(task.id);
    }
    this.save();
  }

  setPolicy(patch) {
    this.state.policy = normalizePolicy({ ...this.state.policy, ...(patch ?? {}) });
    this.recordEvent("info", "policy.updated", "Policy updated", { policy: this.state.policy });
    return this.state.policy;
  }

  setProject(project) {
    this.state.project = String(project);
    this.save();
    return this.state.project;
  }

  recordAttempt(attempt) {
    const record = {
      id: attempt.id ?? uid("att"),
      taskId: attempt.taskId,
      modelId: attempt.modelId ?? null,
      provider: attempt.provider ?? null,
      costClass: attempt.costClass ?? "unknown",
      kind: attempt.kind ?? "execute",
      startedAt: attempt.startedAt ?? nowIso(),
      finishedAt: attempt.finishedAt ?? nowIso(),
      success: Boolean(attempt.success),
      score: attempt.score ?? null,
      costCny: Number(attempt.costCny ?? 0),
      tokensIn: Number(attempt.tokensIn ?? 0),
      tokensOut: Number(attempt.tokensOut ?? 0),
      durationMs: Number(attempt.durationMs ?? 0),
      error: attempt.error ?? null,
      review: attempt.review ?? null,
      simulated: Boolean(attempt.simulated),
      evidenceClass: attempt.evidenceClass ?? (attempt.simulated ? "simulated" : "real")
    };
    this.state.attempts.push(record);
    if (this.state.attempts.length > 5000) this.state.attempts.splice(0, this.state.attempts.length - 5000);
    if (record.modelId) {
      const stats = this.state.modelStats[record.modelId] ?? {
        modelId: record.modelId,
        provider: record.provider,
        costClass: record.costClass,
        runs: 0,
        successes: 0,
        qualitySum: 0,
        costCny: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastRunAt: null
      };
      stats.provider = record.provider;
      stats.costClass = record.costClass;
      stats.runs += 1;
      stats.successes += record.success ? 1 : 0;
      stats.qualitySum += Number(record.score ?? 0);
      stats.costCny += record.costCny;
      stats.tokensIn += record.tokensIn;
      stats.tokensOut += record.tokensOut;
      stats.lastRunAt = record.finishedAt;
      this.state.modelStats[record.modelId] = stats;
    }
    this.save();
    return record;
  }

  applySpend({ apiCny = 0, reservedCny = 0, subscriptionTokens = 0, costClass = "unknown" }) {
    const budget = this.state.budget;
    budget.reservedCny = Math.max(0, Number(budget.reservedCny ?? 0) - Number(reservedCny ?? 0));
    budget.apiSpentCny = Number(budget.apiSpentCny ?? 0) + Math.max(0, Number(apiCny ?? 0));
    budget.subscriptionTokens = Number(budget.subscriptionTokens ?? 0) + Math.max(0, Number(subscriptionTokens ?? 0));
    if (costClass === "free") budget.freeRuns += 1;
    else if (costClass === "api") budget.paidRuns += 1;
    else if (costClass === "unknown") budget.unknownCostRuns += 1;
    this.save();
    return budget;
  }

  reserveBudget(amount) {
    const value = Math.max(0, Number(amount ?? 0));
    this.state.budget.reservedCny = Number(this.state.budget.reservedCny ?? 0) + value;
    this.save();
    return value;
  }

  acquireLocks(taskId, resources, leaseMs = 20 * 60 * 1000) {
    this.purgeExpiredLocks();
    const unique = [...new Set(resources ?? [])];
    if (!unique.length) return { ok: true, acquired: [] };
    const held = [];
    for (const resource of unique) {
      const lock = this.state.locks[resource];
      if (lock && lock.taskId !== taskId) held.push({ resource, taskId: lock.taskId, expiresAt: lock.expiresAt });
    }
    if (held.length) return { ok: false, held };
    const acquiredAt = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    for (const resource of unique) {
      this.state.locks[resource] = { resource, taskId, acquiredAt, expiresAt };
    }
    this.recordEvent("info", "locks.acquired", `${taskId} acquired ${unique.join(", ")}`, { taskId, resources: unique, expiresAt });
    return { ok: true, acquired: unique, expiresAt };
  }

  releaseLocks(taskId) {
    const released = [];
    for (const [resource, lock] of Object.entries(this.state.locks)) {
      if (lock.taskId === taskId) {
        released.push(resource);
        delete this.state.locks[resource];
      }
    }
    if (released.length) {
      this.recordEvent("info", "locks.released", `${taskId} released ${released.join(", ")}`, { taskId, resources: released });
    }
    return released;
  }

  purgeExpiredLocks() {
    const now = Date.now();
    let changed = false;
    for (const [resource, lock] of Object.entries(this.state.locks)) {
      if (new Date(lock.expiresAt).getTime() <= now) {
        delete this.state.locks[resource];
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  cleanupStaleLocks({ runningTaskIds = [] } = {}) {
    const running = new Set(runningTaskIds);
    let changed = false;
    for (const [resource, lock] of Object.entries(this.state.locks)) {
      const owner = this.state.tasks[lock.taskId];
      if (!running.has(lock.taskId) || !owner || owner.status !== "running") {
        delete this.state.locks[resource];
        changed = true;
      }
    }
    if (changed) this.recordEvent("warn", "locks.recovered", "Released locks left by interrupted tasks", { runningTaskIds });
    return changed;
  }

  addNote({ text, tags = [], clearance = 1, source = "human" }) {
    const note = {
      id: uid("note"),
      text: String(text),
      tags: [...new Set(tags.map(String))],
      clearance: Math.max(0, Math.min(2, Number(clearance))),
      source,
      createdAt: nowIso()
    };
    this.state.notes.push(note);
    if (this.state.notes.length > 2000) this.state.notes.splice(0, this.state.notes.length - 2000);
    this.recordEvent("info", "note.added", `Note added (${note.tags.join(", ") || "untagged"})`, { noteId: note.id, clearance: note.clearance });
    return note;
  }

  setMainQuota(quota) {
    this.state.mainModelQuota = { ...this.state.mainModelQuota, ...quota };
    this.save();
  }

  setRun(patch) {
    this.state.run = { ...this.state.run, ...patch };
    this.save();
    return this.state.run;
  }

  reset({ project = "orchestra-project", policy = {} } = {}) {
    this.state = createState(project, policy);
    this.save();
    return this.state;
  }
}

export function openStore(root, options) {
  return new Store(root, options);
}
