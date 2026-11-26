import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildContext, buildReviewPrompt } from "./context.js";
import {
  normalizeTask,
  progressOf,
  taskDependencyState
} from "./domain.js";
import {
  combineGate,
  evaluateDeterministic,
  isCriticalTask,
  parseReviewOutput
} from "./quality.js";
import { planPool } from "./pool.js";
import { routeReviewer, routeTask } from "./router.js";
import {
  formatDuration,
  nowIso,
  truncate
} from "./util.js";
import { Workspace } from "./workspace.js";

function summarizeOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).filter(Boolean);
  const picked = [];
  for (const line of lines) {
    if (picked.join("\n").length > 700) break;
    if (/^```/.test(line)) continue;
    picked.push(line);
    if (picked.length >= 8) break;
  }
  return truncate(picked.join("\n") || text, 900);
}

function taskGateIssues(gate) {
  return (gate?.issues ?? []).slice(0, 12);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireRunLock(root) {
  const dir = path.join(root, ".orchestra");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "RUN.lock");
  if (fs.existsSync(file)) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      existing = null;
    }
    const ageMs = existing?.startedAt ? Date.now() - new Date(existing.startedAt).getTime() : Infinity;
    const stale = !existing || !pidAlive(Number(existing.pid)) || ageMs > 24 * 60 * 60 * 1000;
    if (!stale) {
      throw new Error(`Another scheduler run is active (pid ${existing.pid}, since ${existing.startedAt}). Stop it or remove ${file} after confirming it is dead.`);
    }
    fs.rmSync(file, { force: true });
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: nowIso() }), "utf8");
  return file;
}

function releaseRunLock(file) {
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number(existing.pid) === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

export class Scheduler {
  constructor({ root, store, config, providers, log = () => {} }) {
    this.root = root;
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.log = log;
    this.workspace = new Workspace(root);
    this.active = new Map();
    this.running = false;
    this.stopRequested = false;
    this.budgetStop = false;
    this.lastRun = null;
    if (this.store.getState().run?.status === "running") {
      this.store.recordEvent("warn", "run.recovered", "Previous process did not close its run cleanly; state recovered as idle", {});
      this.store.setRun({
        status: "idle",
        stopReason: "recovered",
        finishedAt: nowIso()
      });
    }
  }

  get state() {
    return this.store.getState();
  }

  isRunning() {
    return this.running;
  }

  isPaused() {
    return fs.existsSync(path.join(this.root, ".orchestra", "PAUSE"));
  }

  pause() {
    fs.writeFileSync(path.join(this.root, ".orchestra", "PAUSE"), "paused\n", "utf8");
    this.store.recordEvent("warn", "run.paused", "Pause flag created", {});
  }

  resume() {
    fs.rmSync(path.join(this.root, ".orchestra", "PAUSE"), { force: true });
    this.store.recordEvent("info", "run.resumed", "Pause flag removed", {});
  }

  requestStop() {
    this.stopRequested = true;
    this.store.recordEvent("warn", "run.stop_requested", "Stop requested; active tasks will finish before exit", {});
  }

  wakeWaitingBudget() {
    let count = 0;
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === "waiting_budget") {
        this.store.updateTask(task.id, { status: "pending", blockedReason: null, blockedCode: null });
        count += 1;
      }
    }
    return count;
  }

  settle() {
    const state = this.state;
    const tasks = Object.values(state.tasks);
    for (const task of tasks) {
      if (["running", "done", "failed", "cancelled", "decomposed", "waiting_approval", "waiting_budget"].includes(task.status)) continue;
      if (task.status === "needs_main_model" && !state.policy.allowDelegateL0) continue;
      if (task.status === "needs_main_model" && state.policy.allowDelegateL0) {
        this.store.updateTask(task.id, { status: "pending", blockedReason: null, blockedCode: null });
        continue;
      }
      if (task.status === "blocked" && task.blockedCode !== "dependency") continue;
      const dep = taskDependencyState(state.tasks, task);
      if (dep.failed.length || dep.blocked.length || dep.missing.length) {
        const reason = dep.missing.length
          ? `Missing dependencies: ${dep.missing.join(", ")}`
          : dep.failed.length
            ? `Dependency failed: ${dep.failed.join(", ")}`
            : `Dependency blocked: ${dep.blocked.join(", ")}`;
        if (task.status !== "blocked" || task.blockedReason !== reason) {
          this.store.updateTask(task.id, {
            status: "blocked",
            blockedCode: "dependency",
            blockedReason: reason,
            error: reason
          }, { eventKind: "task.blocked", eventMessage: `${task.id} blocked by dependency`, eventData: { reason } });
        }
        continue;
      }
      if (!dep.allDone) {
        if (task.status !== "pending") this.store.updateTask(task.id, { status: "pending" });
        continue;
      }
      if (task.humanGate || task.owner === "human") {
        this.store.updateTask(task.id, { status: "waiting_approval", blockedReason: null, blockedCode: null });
        continue;
      }
      if (task.owner === "main" || (task.tier === "L0" && !state.policy.allowDelegateL0)) {
        this.store.updateTask(task.id, { status: "needs_main_model", blockedReason: null, blockedCode: null });
        continue;
      }
      this.store.updateTask(task.id, { status: "ready", blockedReason: null, blockedCode: null, error: null });
    }
  }

  readyTasks(providerFilter = null) {
    const tasks = Object.values(this.state.tasks)
      .filter((task) => task.status === "ready")
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return String(a.createdAt).localeCompare(String(b.createdAt));
      });
    if (!providerFilter) return tasks;
    return tasks;
  }

  availableModels(providerFilter = null, { purpose = "producer", taskKind = null } = {}) {
    const base = providerFilter
      ? this.config.models.filter((model) => model.provider === providerFilter)
      : this.config.models;
    if (!this.state.policy.enforcePool) return base;
    const pool = planPool({
      tasks: Object.values(this.state.tasks),
      models: base,
      roles: this.config.roles,
      policy: this.state.policy,
      state: this.state
    });
    const reviewerLike = purpose === "reviewer" || taskKind === "review";
    const relevant = reviewerLike
      ? pool.slots.filter((slot) => slot.role === "reviewer" || slot.pinned || String(slot.role).startsWith("task:") || slot.role === "all-pin")
      : pool.slots.filter((slot) => slot.role !== "reviewer");
    // An empty pool means no adequate model exists; fall back to the full
    // catalogue so the router can return the precise privacy/budget reason
    // instead of a generic "no model" block.
    if (!relevant.length) return base;
    const ids = new Set(relevant.map((slot) => slot.modelId));
    return base.filter((model) => ids.has(model.id));
  }

  setBlocked(task, route) {
    if (route.reason === "budget_exhausted") {
      this.store.updateTask(task.id, {
        status: "waiting_budget",
        blockedCode: route.reason,
        blockedReason: route.reasonText,
        error: route.reasonText,
        route: { reason: route.reason, reasonText: route.reasonText }
      }, { eventKind: "task.waiting_budget", eventMessage: `${task.id} waiting for budget`, eventData: { reason: route.reasonText } });
      this.budgetStop = true;
      return;
    }
    if (route.reason === "main_model_required") {
      this.store.updateTask(task.id, {
        status: "needs_main_model",
        blockedCode: route.reason,
        blockedReason: route.reasonText,
        error: route.reasonText
      }, { eventKind: "task.main_model", eventMessage: `${task.id} reserved for main model`, eventData: {} });
      return;
    }
    this.store.updateTask(task.id, {
      status: "blocked",
      blockedCode: route.reason,
      blockedReason: route.reasonText,
      error: route.reasonText,
      route: { reason: route.reason, reasonText: route.reasonText, rejected: route.rejected?.slice(0, 20) }
    }, { eventKind: "task.blocked", eventMessage: `${task.id} blocked: ${route.reasonText}`, eventData: { reason: route.reason } });
  }

  startTask(task) {
    if (task.kind === "script") {
      const lock = this.store.acquireLocks(task.id, task.resources, this.state.policy.lockLeaseMinutes * 60 * 1000);
      if (!lock.ok) {
        this.store.recordEvent("info", "lock.wait", `${task.id} waiting for ${lock.held.map((item) => item.resource).join(", ")}`, {
          taskId: task.id,
          heldBy: lock.held
        });
        return { started: false, locked: true };
      }
      const attemptNo = Number(task.attempts ?? 0) + 1;
      const startedAt = nowIso();
      this.store.updateTask(task.id, {
        status: "running",
        attempts: attemptNo,
        assignedModel: "script/local",
        startedAt
      }, { eventKind: "task.started", eventMessage: `${task.id} script started`, eventData: {} });
      const promise = this.executeScriptTask(task, attemptNo, startedAt, Date.now())
        .catch((error) => {
          this.store.recordEvent("error", "task.internal_error", `${task.id} script error: ${error.message}`, { taskId: task.id });
          this.store.releaseLocks(task.id);
          this.store.updateTask(task.id, { status: "failed", error: error.message, finishedAt: nowIso() });
        })
        .finally(() => this.active.delete(task.id));
      this.active.set(task.id, promise);
      return { started: true };
    }
    let route = routeTask({
      task,
      models: this.availableModels(this.currentProviderFilter, { taskKind: task.kind }),
      roles: this.config.roles,
      policy: this.state.policy,
      state: this.state,
      promptChars: task.brief.length + 2000,
      excludeModelIds: task.triedModels
    });
    if (!route.selected && route.reason === "no_eligible_model" && task.triedModels.length) {
      route = routeTask({
        task,
        models: this.availableModels(this.currentProviderFilter, { taskKind: task.kind }),
        roles: this.config.roles,
        policy: this.state.policy,
        state: this.state,
        promptChars: task.brief.length + 2000,
        excludeModelIds: [],
        allowTriedModels: true
      });
      if (route.selected) route.reusedTriedModel = true;
    }
    if (!route.selected) {
      this.setBlocked(task, route);
      return { started: false, stop: route.reason === "budget_exhausted" };
    }

    const model = route.selected.model;
    const lock = this.store.acquireLocks(task.id, task.resources, this.state.policy.lockLeaseMinutes * 60 * 1000);
    if (!lock.ok) {
      this.store.recordEvent("info", "lock.wait", `${task.id} waiting for ${lock.held.map((item) => item.resource).join(", ")}`, {
        taskId: task.id,
        heldBy: lock.held
      });
      return { started: false, locked: true };
    }

    const reservedCny = model.costClass === "api" ? Number(route.selected.estimateCny ?? 0) : 0;
    if (reservedCny > 0) this.store.reserveBudget(reservedCny);

    const routeSummary = {
      modelId: model.id,
      provider: model.provider,
      label: model.label,
      costClass: model.costClass,
      privacy: model.privacy,
      quality: route.selected.quality,
      score: route.selected.score,
      minQuality: route.minQuality,
      estimateCny: route.selected.estimateCny,
      qualityPreference: this.state.policy.qualityPreference,
      candidates: route.candidates.slice(0, 4).map((item) => ({
        modelId: item.modelId,
        quality: item.quality,
        score: item.score,
        costCny: item.estimateCny
      })),
      rejectedCount: route.rejected.length,
      reason: null,
      reusedTriedModel: Boolean(route.reusedTriedModel)
    };

    this.store.updateTask(task.id, {
      status: "running",
      assignedModel: model.id,
      route: routeSummary,
      startedAt: nowIso(),
      error: null,
      blockedReason: null,
      blockedCode: null
    }, {
      eventKind: "route.selected",
      eventMessage: `${task.id} -> ${model.id} (${model.costClass}, quality ${route.selected.quality}/${route.minQuality})`,
      eventData: { route: routeSummary }
    });

    const promise = this.executeTask(task, route, reservedCny)
      .catch((error) => {
        this.store.recordEvent("error", "task.internal_error", `${task.id} internal scheduler error: ${error.message}`, { taskId: task.id, stack: error.stack });
        this.store.releaseLocks(task.id);
        const current = this.state.tasks[task.id];
        if (current && current.status === "running") {
          this.store.updateTask(task.id, { status: "failed", error: error.message, finishedAt: nowIso() });
        }
      })
      .finally(() => {
        this.active.delete(task.id);
      });
    this.active.set(task.id, promise);
    this.log(`started ${task.id} on ${model.id}`);
    return { started: true };
  }

  async executeTask(task, route, reservedCny) {
    const model = route.selected.model;
    const attemptNo = Number(task.attempts ?? 0) + 1;
    this.store.updateTask(task.id, { attempts: attemptNo, status: "running", startedAt: nowIso() });
    const startedAt = nowIso();
    const started = Date.now();
    let reservation = reservedCny;
    let reviewReservation = 0;

    if (task.kind === "script") {
      return this.executeScriptTask(task, attemptNo, startedAt, started);
    }

    try {
      this.workspace.prepareTask(task);
      const cwd = this.workspace.taskDir(task.id);
      const deps = task.deps.map((id) => this.state.tasks[id]).filter(Boolean);
      const context = buildContext({
        task,
        state: this.state,
        model,
        route,
        deps,
        roles: this.config.roles
      });
      this.workspace.writePrompt(task, context.prompt);
      const timeoutMs = Math.max(
        60_000,
        Number(this.config.providers?.[model.provider]?.timeoutMinutes ?? 25) * 60 * 1000
      );
      const result = await this.providers.run({
        model,
        prompt: context.prompt,
        cwd,
        task,
        role: "execute",
        attempt: attemptNo,
        context: { quality: route.selected.quality, minQuality: route.minQuality, routeQuality: route.selected.quality },
        timeoutMs
      });

      const blocks = (result.artifacts ?? []).map((artifact) => ({ ...artifact, source: "provider-block" }));
      const workspaceFiles = result.meta?.workspaceScan ? this.workspace.scanTaskDir(task.id) : [];
      const merged = [...blocks, ...workspaceFiles];
      const persisted = this.workspace.persistArtifacts(task.id, attemptNo, merged, {
        simulated: Boolean(result.meta?.simulated)
      });
      const gateArtifacts = persisted.map((artifact) => ({
        ...artifact,
        content: this.workspace.readArtifact(task.id, artifact.latestPath)
      }));
      result.artifacts = gateArtifacts;

      const deterministic = evaluateDeterministic(task, result, this.state.policy);
      const reviewRequired = isCriticalTask(task, this.state.policy) && deterministic.pass;
      let review = null;
      let reviewRun = null;
      if (reviewRequired) {
        const reviewerRoute = routeReviewer({
          task,
          models: this.availableModels(this.currentProviderFilter, { purpose: "reviewer" }),
          roles: this.config.roles,
          policy: this.state.policy,
          state: this.state,
          producerModel: model,
          producerProvider: model.provider,
          promptChars: 8000
        });
        if (!reviewerRoute.selected) {
          review = { valid: false, reason: reviewerRoute.reasonText ?? "No reviewer model available" };
        } else {
          const reviewerModel = reviewerRoute.selected.model;
          reviewReservation = reviewerModel.costClass === "api" ? Number(reviewerRoute.selected.estimateCny ?? 0) : 0;
          if (reviewReservation > 0) this.store.reserveBudget(reviewReservation);
          const reviewCwd = this.workspace.reviewDir(task.id, attemptNo);
          const reviewPrompt = buildReviewPrompt({
            task,
            result,
            deterministic,
            minReviewScore: this.state.policy.minReviewScore,
            reviewerModel
          });
          const reviewStarted = Date.now();
          try {
            const reviewResult = await this.providers.run({
              model: reviewerModel,
              prompt: reviewPrompt,
              cwd: reviewCwd,
              task,
              role: "reviewer",
              attempt: 1,
              context: {
                reviewTargetScore: deterministic.score,
                deterministicIssues: deterministic.issues,
                deterministicPass: deterministic.pass,
                minReviewScore: this.state.policy.minReviewScore,
                quality: reviewerRoute.selected.quality
              },
              timeoutMs: 8 * 60 * 1000
            });
            const parsed = parseReviewOutput(reviewResult.output);
            review = {
              ...parsed,
              modelId: reviewerModel.id,
              provider: reviewerModel.provider,
              costCny: reviewResult.costCny,
              simulated: Boolean(reviewResult.meta?.simulated),
              crossProvider: reviewerRoute.crossProvider,
              fallbackReason: reviewerRoute.fallbackReason ?? null
            };
            reviewRun = {
              reviewerModel,
              reviewResult,
              parsed,
              durationMs: Date.now() - reviewStarted
            };
            this.store.applySpend({
              apiCny: reviewResult.costCny,
              reservedCny: reviewReservation,
              subscriptionTokens: reviewResult.tokensIn + reviewResult.tokensOut,
              costClass: reviewerModel.costClass
            });
            reviewReservation = 0;
            this.store.recordAttempt({
              taskId: task.id,
              modelId: reviewerModel.id,
              provider: reviewerModel.provider,
              costClass: reviewerModel.costClass,
              kind: "review",
              startedAt: new Date(reviewStarted).toISOString(),
              finishedAt: nowIso(),
              success: parsed.valid && parsed.pass,
              score: parsed.valid ? parsed.score : 0,
              costCny: reviewResult.costCny,
              tokensIn: reviewResult.tokensIn,
              tokensOut: reviewResult.tokensOut,
              durationMs: reviewRun.durationMs,
              error: parsed.valid ? null : parsed.reason,
              simulated: Boolean(reviewResult.meta?.simulated),
              review: { crossProvider: reviewerRoute.crossProvider }
            });
            this.store.recordEvent("info", "review.completed", `${task.id} reviewed by ${reviewerModel.id}`, {
              taskId: task.id,
              score: parsed.valid ? parsed.score : null,
              pass: parsed.valid ? parsed.pass : null,
              crossProvider: reviewerRoute.crossProvider,
              simulated: Boolean(reviewResult.meta?.simulated)
            });
          } catch (error) {
            review = { valid: false, reason: `Reviewer failed: ${error.message}` };
            this.store.applySpend({ apiCny: 0, reservedCny: reviewReservation, costClass: reviewerModel.costClass });
            reviewReservation = 0;
            this.store.recordEvent("error", "review.failed", `${task.id} review failed: ${error.message}`, { taskId: task.id });
          }
        }
      }

      const gate = combineGate({
        task,
        deterministic,
        review,
        reviewRequired,
        policy: this.state.policy
      });
      const totalCost = Number(result.costCny ?? 0);
      this.store.applySpend({
        apiCny: totalCost,
        reservedCny: reservation,
        subscriptionTokens: Number(result.tokensIn ?? 0) + Number(result.tokensOut ?? 0),
        costClass: model.costClass
      });
      reservation = 0;

      const resultRecord = {
        output: truncate(result.output ?? "", 16000),
        summary: summarizeOutput(result.output ?? ""),
        artifacts: persisted,
        meta: result.meta ?? {},
        tokensIn: result.tokensIn ?? 0,
        tokensOut: result.tokensOut ?? 0,
        costCny: totalCost,
        promptChars: context.chars,
        context: {
          includedNotes: context.includedNotes,
          includedDeps: context.includedDeps,
          redactions: context.redactions,
          promptBudgetChars: context.promptBudgetChars
        },
        gate: {
          pass: gate.pass,
          score: gate.score,
          status: gate.status,
          reason: gate.reason,
          deterministicScore: gate.deterministicScore,
          reviewScore: review?.valid ? review.score : null,
          issues: taskGateIssues(gate),
          evidenceClass: gate.evidenceClass
        },
        review
      };

      this.store.recordAttempt({
        taskId: task.id,
        modelId: model.id,
        provider: model.provider,
        costClass: model.costClass,
        kind: "execute",
        startedAt,
        finishedAt: nowIso(),
        success: gate.pass,
        score: gate.score,
        costCny: totalCost,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: Date.now() - started,
        error: gate.pass ? null : gate.reason,
        simulated: Boolean(result.meta?.simulated),
        evidenceClass: gate.evidenceClass
      });

      if (gate.pass) {
        this.store.updateTask(task.id, {
          status: "done",
          score: gate.score,
          result: resultRecord,
          review,
          simulated: Boolean(result.meta?.simulated),
          error: null,
          finishedAt: nowIso()
        }, {
          eventKind: "gate.passed",
          eventMessage: `${task.id} accepted at ${gate.score} by ${model.id}`,
          eventData: { score: gate.score, evidenceClass: gate.evidenceClass, simulated: Boolean(result.meta?.simulated) }
        });
        return;
      }

      if (gate.status === "needs_human_review") {
        this.store.updateTask(task.id, {
          status: "waiting_approval",
          score: gate.score,
          result: resultRecord,
          review,
          simulated: Boolean(result.meta?.simulated),
          reviewReason: gate.reason,
          error: gate.reason,
          finishedAt: nowIso()
        }, {
          eventKind: "gate.needs_human_review",
          eventMessage: `${task.id} needs human review: ${gate.reason}`,
          eventData: { score: gate.score }
        });
        return;
      }

      this.handleFailure(task, model, gate.reason, gate, resultRecord, attemptNo);
    } catch (error) {
      this.store.applySpend({ apiCny: 0, reservedCny: reservation, costClass: model.costClass });
      this.store.applySpend({ apiCny: 0, reservedCny: reviewReservation, costClass: model.costClass });
      reservation = 0;
      reviewReservation = 0;
      this.store.recordAttempt({
        taskId: task.id,
        modelId: model.id,
        provider: model.provider,
        costClass: model.costClass,
        kind: "execute",
        startedAt,
        finishedAt: nowIso(),
        success: false,
        score: 0,
        costCny: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: Date.now() - started,
        error: error.message,
        simulated: false
      });
      this.handleFailure(task, model, error.message, null, null, attemptNo);
    } finally {
      this.store.releaseLocks(task.id);
    }
  }

  handleFailure(task, model, reason, gate, resultRecord, attemptNo) {
    const tried = [...new Set([...(task.triedModels ?? []), model.id])];
    const canRetry = attemptNo < Number(task.maxAttempts ?? this.state.policy.maxAttempts);
    if (canRetry) {
      this.store.updateTask(task.id, {
        status: "ready",
        triedModels: tried,
        error: reason,
        score: gate?.score ?? task.score,
        result: resultRecord ?? task.result,
        review: gate?.review ?? task.review,
        finishedAt: null
      }, {
        eventKind: "task.retry",
        eventMessage: `${task.id} failed attempt ${attemptNo}; escalating (${reason})`,
        eventData: { reason, modelId: model.id, triedModels: tried }
      });
      return;
    }
    this.store.updateTask(task.id, {
      status: "failed",
      triedModels: tried,
      error: reason,
      score: gate?.score ?? task.score,
      result: resultRecord ?? task.result,
      review: gate?.review ?? task.review,
      finishedAt: nowIso()
    }, {
      eventKind: "task.failed",
      eventMessage: `${task.id} failed after ${attemptNo} attempts: ${reason}`,
      eventData: { reason, modelId: model.id }
    });
  }

  executeScriptTask(task, attemptNo, startedAt, started) {
    return new Promise((resolve) => {
      const policy = this.state.policy;
      if (!policy.allowScripts) {
        this.store.updateTask(task.id, { status: "failed", error: "Scripts are disabled by policy", finishedAt: nowIso() });
        resolve();
        return;
      }
      const command = (task.command ?? []).map((item) => String(item)
        .replaceAll("{root}", this.root)
        .replaceAll("{taskId}", task.id));
      if (!command.length) {
        this.store.updateTask(task.id, { status: "failed", error: "Script task has no command", finishedAt: nowIso() });
        resolve();
        return;
      }
      const executable = path.basename(command[0]).replace(/\.(exe|cmd|bat)$/i, "");
      if (!policy.allowedExecutables.includes(executable)) {
        this.store.updateTask(task.id, { status: "failed", error: `Executable not allowed: ${command[0]}`, finishedAt: nowIso() });
        resolve();
        return;
      }
      const cwd = this.workspace.prepareTask(task);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command[0], command.slice(1), {
        cwd,
        windowsHide: true,
        shell: false,
        env: { ...process.env, AGENTORCHESTRA_TASK_ID: task.id }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5 * 60 * 1000);
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 1_000_000) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 1_000_000) stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        this.store.updateTask(task.id, { status: "failed", error: `Script failed to start: ${error.message}`, finishedAt: nowIso() });
        this.store.releaseLocks(task.id);
        resolve();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        const files = this.workspace.scanTaskDir(task.id);
        const persisted = this.workspace.persistArtifacts(task.id, attemptNo, files, { simulated: false });
        const artifacts = persisted.map((artifact) => ({
          ...artifact,
          content: this.workspace.readArtifact(task.id, artifact.latestPath)
        }));
        const result = {
          output,
          artifacts,
          tokensIn: 0,
          tokensOut: 0,
          costCny: 0,
          meta: { provider: "script", modelId: "script/local", simulated: false, evidenceClass: "real", exitCode: code }
        };
        const deterministic = evaluateDeterministic(task, result, this.state.policy);
        const gate = combineGate({
          task,
          deterministic,
          review: null,
          reviewRequired: false,
          policy: this.state.policy
        });
        this.store.recordAttempt({
          taskId: task.id,
          modelId: "script/local",
          provider: "script",
          costClass: "free",
          kind: "execute",
          startedAt,
          finishedAt: nowIso(),
          success: gate.pass && code === 0 && !timedOut,
          score: gate.score,
          costCny: 0,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: Date.now() - started,
          error: timedOut ? "Script timed out" : code !== 0 ? `Script exited ${code}` : gate.pass ? null : gate.reason,
          simulated: false,
          evidenceClass: "real"
        });
        if (gate.pass && code === 0 && !timedOut) {
          this.store.updateTask(task.id, {
            status: "done",
            score: gate.score,
            result: {
              output: truncate(output, 16000),
              summary: summarizeOutput(output),
              artifacts: persisted,
              meta: result.meta,
              gate: { pass: true, score: gate.score, status: "accepted", reason: "Deterministic script gate passed", issues: [], evidenceClass: "real" }
            },
            simulated: false,
            finishedAt: nowIso()
          }, { eventKind: "gate.passed", eventMessage: `${task.id} script accepted`, eventData: { score: gate.score, exitCode: code } });
        } else {
          this.handleFailure(task, { id: "script/local" }, timedOut ? "Script timed out" : code !== 0 ? `Script exited ${code}` : gate.reason, gate, null, attemptNo);
        }
        this.store.releaseLocks(task.id);
        resolve();
      });
    });
  }

  async run({ maxSteps = 200, providerFilter = null, stopOnApproval = false } = {}) {
    if (this.running) throw new Error("Scheduler is already running");
    const runLock = acquireRunLock(this.root);
    this.running = true;
    const started = Date.now();
    let stopReason = null;
    let steps = 0;
    let lastDone = Object.values(this.state.tasks).filter((task) => task.status === "done").length;
    let idleWaves = 0;
    try {
      this.stopRequested = false;
      this.budgetStop = false;
      this.currentProviderFilter = providerFilter;
      this.store.cleanupStaleLocks({ runningTaskIds: [] });
      for (const task of Object.values(this.state.tasks)) {
        if (task.status === "running") {
          this.store.updateTask(task.id, { status: "ready", error: "Recovered from an interrupted run" });
        }
        if (task.status === "blocked" && task.blockedCode !== "dependency") {
          this.store.updateTask(task.id, { status: "pending", blockedReason: null, blockedCode: null });
        }
        if (task.status === "waiting_budget") {
          this.store.updateTask(task.id, { status: "pending", blockedReason: null, blockedCode: null });
        }
      }
      this.store.setRun({ status: "running", stopReason: null, startedAt: nowIso(), finishedAt: null });

      while (steps < maxSteps) {
        if (this.stopRequested) {
          stopReason = "stopped";
          break;
        }
        if (this.isPaused()) {
          stopReason = "paused";
          break;
        }
        if ((Date.now() - started) / 60000 > this.state.policy.maxWallMinutes) {
          stopReason = "wall_clock";
          break;
        }
        this.settle();

        for (const task of this.readyTasks(providerFilter)) {
          if (task.autoDecompose && task.decomposeInto?.length) {
            this.decomposeTask(task);
          }
        }
        this.settle();

        let startedThisWave = 0;
        while (this.active.size < this.state.policy.maxConcurrency) {
          const ready = this.readyTasks(providerFilter);
          if (!ready.length) break;
          let startedOne = false;
          for (const task of ready) {
            const outcome = this.startTask(task);
            if (outcome.started) {
              startedThisWave += 1;
              steps += 1;
              startedOne = true;
              break;
            }
            if (outcome.stop) {
              this.budgetStop = true;
              break;
            }
          }
          if (!startedOne) break;
        }

        if (this.active.size === 0) {
          stopReason = this.inferStopReason();
          break;
        }
        if (stopOnApproval && Object.values(this.state.tasks).some((task) => task.status === "waiting_approval")) {
          stopReason = "needs_approval";
          break;
        }

        const doneCount = Object.values(this.state.tasks).filter((task) => task.status === "done").length;
        if (doneCount > lastDone) {
          lastDone = doneCount;
          idleWaves = 0;
        } else {
          idleWaves += 1;
        }
        if (idleWaves >= this.state.policy.stagnationLimit) {
          stopReason = "stagnation";
          break;
        }
        if (startedThisWave === 0 && this.active.size === 0) {
          stopReason = this.inferStopReason();
          break;
        }
        await Promise.race(this.active.values());
      }
      if (!stopReason) stopReason = steps >= maxSteps ? "max_steps" : "no_runnable";
      if (this.active.size) await Promise.allSettled(this.active.values());
    } finally {
      this.running = false;
      this.currentProviderFilter = null;
      const summary = this.summary(stopReason, steps, Date.now() - started);
      this.store.setRun({
        status: "idle",
        stopReason,
        finishedAt: nowIso(),
        lastSummary: summary
      });
      this.lastRun = summary;
      this.store.recordEvent(
        stopReason === "complete" ? "info" : "warn",
        "run.finished",
        `Run finished: ${stopReason} (${summary.progress}% accepted)`,
        { stopReason, steps, durationMs: summary.durationMs }
      );
      releaseRunLock(runLock);
    }
    return this.lastRun;
  }

  inferStopReason() {
    const tasks = Object.values(this.state.tasks);
    if (tasks.some((task) => task.status === "waiting_approval")) return "needs_approval";
    if (tasks.some((task) => task.status === "waiting_budget")) return "waiting_budget";
    if (tasks.some((task) => task.status === "needs_main_model")) return "needs_main_model";
    if (tasks.some((task) => ["failed", "blocked"].includes(task.status))) return "blocked";
    const leaves = tasks.filter((task) => task.status !== "decomposed" && task.status !== "cancelled");
    if (leaves.length && leaves.every((task) => task.status === "done")) return "complete";
    return "no_runnable";
  }

  decomposeTask(task) {
    const policy = this.state.policy;
    if (!task.decomposeInto?.length) return { decomposed: false, reason: "no_subtasks" };
    if (task.depth >= policy.maxDepth) {
      this.store.recordEvent("warn", "decompose.blocked", `${task.id} not decomposed: depth ${task.depth} reached maxDepth ${policy.maxDepth}`, { taskId: task.id });
      return { decomposed: false, reason: "max_depth" };
    }
    if (task.decomposeInto.length > policy.maxChildren) {
      this.store.recordEvent("warn", "decompose.blocked", `${task.id} not decomposed: ${task.decomposeInto.length} children exceeds maxChildren ${policy.maxChildren}`, { taskId: task.id });
      return { decomposed: false, reason: "max_children" };
    }
    const ids = new Set(Object.keys(this.state.tasks));
    const children = [];
    try {
      for (const raw of task.decomposeInto) {
        const child = normalizeTask({
          ...raw,
          id: raw.id,
          tier: raw.tier ?? task.tier,
          group: raw.group ?? task.group,
          confidentiality: raw.confidentiality ?? task.confidentiality,
          resources: raw.resources ?? [],
          deps: [...task.deps, ...(raw.deps ?? [])],
          parentId: task.id,
          owner: "orchestra"
        }, { policy, existingIds: ids, defaultGroup: task.group });
        child.depth = task.depth + 1;
        ids.add(child.id);
        children.push(child);
      }
      const integrateId = `${task.id}.integrate`;
      if (ids.has(integrateId)) throw new Error(`Integration id already exists: ${integrateId}`);
      const integrate = normalizeTask({
        id: integrateId,
        title: `${task.title} — integration`,
        brief: `Integrate the accepted child outputs for ${task.id}. State what passed, what is unverified, and residual risks.\n\nParent brief: ${task.brief}`,
        group: task.group,
        kind: "integration",
        tier: task.tier,
        role: "integrator",
        difficulty: task.difficulty,
        confidentiality: task.confidentiality,
        resources: task.resources,
        deps: children.map((child) => child.id),
        parentId: task.id,
        acceptance: task.acceptance,
        owner: "orchestra",
        humanGate: false
      }, { policy, existingIds: ids, defaultGroup: task.group });
      integrate.depth = task.depth + 1;
      integrate.isIntegration = true;
      integrate.parentId = task.id;
      this.store.addTasks([...children, integrate]);
      for (const dependent of Object.values(this.state.tasks)) {
        if (dependent.deps.includes(task.id)) {
          dependent.deps = dependent.deps.map((dep) => dep === task.id ? integrateId : dep);
        }
      }
      this.store.updateTask(task.id, {
        status: "decomposed",
        children: children.map((child) => child.id),
        integratedBy: integrateId
      }, {
        eventKind: "task.decomposed",
        eventMessage: `${task.id} decomposed into ${children.length} children + integration`,
        eventData: { children: children.map((child) => child.id), integrateId }
      });
      this.store.save();
      return { decomposed: true, children: children.map((child) => child.id), integrateId };
    } catch (error) {
      this.store.recordEvent("error", "decompose.failed", `${task.id} decomposition failed: ${error.message}`, { taskId: task.id });
      return { decomposed: false, reason: error.message };
    }
  }

  approveTask(taskId, decision = "approve", note = "", actor = "human") {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status !== "waiting_approval") {
      throw new Error(`Task ${taskId} is not waiting for approval (status: ${task.status})`);
    }
    if (decision === "approve") {
      this.store.updateTask(task.id, {
        status: "done",
        score: task.score ?? 100,
        approval: { decision, note, actor, at: nowIso() },
        error: null,
        finishedAt: nowIso(),
        result: task.result ? {
          ...task.result,
          meta: { ...(task.result.meta ?? {}), evidenceClass: "human-approved" }
        } : task.result
      }, {
        eventKind: "task.approved",
        eventMessage: `${task.id} approved by ${actor}`,
        eventData: { note }
      });
      return { ok: true, task: this.state.tasks[task.id] };
    }
    this.store.updateTask(task.id, {
      status: "failed",
      approval: { decision: "reject", note, actor, at: nowIso() },
      error: note || "Rejected by human",
      finishedAt: nowIso()
    }, {
      eventKind: "task.rejected",
      eventMessage: `${task.id} rejected by ${actor}`,
      eventData: { note }
    });
    return { ok: true, task: this.state.tasks[task.id] };
  }

  retryTask(taskId) {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (["running", "decomposed"].includes(task.status)) throw new Error(`Cannot retry ${taskId} while ${task.status}`);
    this.store.updateTask(task.id, {
      status: "pending",
      attempts: 0,
      triedModels: [],
      error: null,
      blockedReason: null,
      blockedCode: null,
      finishedAt: null
    }, { eventKind: "task.retry_manual", eventMessage: `${taskId} reset for retry`, eventData: {} });
    return this.state.tasks[taskId];
  }

  completeByMain(taskId, { output = "", artifacts = [], score = null, actor = "main-model" } = {}) {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.humanGate || task.owner === "human") throw new Error(`Task ${taskId} is a human gate and cannot be completed by the main model`);
    if (!["needs_main_model", "ready", "waiting_approval", "pending"].includes(task.status)) {
      throw new Error(`Task ${taskId} cannot be completed by main model in status ${task.status}`);
    }
    const artifactList = (artifacts ?? []).map((artifact) => ({
      path: artifact.path ?? artifact.name,
      content: String(artifact.content ?? ""),
      source: "main-model"
    }));
    const persisted = this.workspace.persistArtifacts(task.id, 0, artifactList, { simulated: false });
    const gateArtifacts = persisted.map((artifact) => ({
      ...artifact,
      content: this.workspace.readArtifact(task.id, artifact.latestPath)
    }));
    const result = {
      output,
      artifacts: gateArtifacts,
      tokensIn: 0,
      tokensOut: 0,
      costCny: 0,
      meta: { provider: "main-model", modelId: "main/model", simulated: false, evidenceClass: "main_model" }
    };
    const deterministic = evaluateDeterministic(task, result, this.state.policy);
    const gate = combineGate({
      task,
      deterministic,
      review: null,
      reviewRequired: false,
      policy: this.state.policy
    });
    if (!gate.pass) {
      this.store.updateTask(task.id, { status: "needs_main_model", error: gate.reason, score: gate.score });
      return { ok: false, gate };
    }
    this.store.updateTask(task.id, {
      status: "done",
      score: score ?? gate.score,
      result: {
        output: truncate(output, 16000),
        summary: summarizeOutput(output),
        artifacts: persisted,
        meta: result.meta,
        gate: { ...gate, evidenceClass: "main_model" }
      },
      simulated: false,
      error: null,
      finishedAt: nowIso(),
      approval: { decision: "main-model-complete", actor, at: nowIso() }
    }, { eventKind: "task.main_completed", eventMessage: `${task.id} completed by main model`, eventData: { score: score ?? gate.score } });
    return { ok: true, gate, task: this.state.tasks[task.id] };
  }

  summary(stopReason, steps = 0, durationMs = 0) {
    const progress = progressOf(this.state);
    return {
      project: this.state.project,
      stopReason,
      steps,
      durationMs,
      durationText: formatDuration(durationMs),
      progress: progress.progress,
      total: progress.total,
      accepted: progress.accepted,
      active: progress.active,
      waitingApproval: progress.waitingApproval,
      waitingBudget: progress.waitingBudget,
      needsMainModel: progress.needsMainModel,
      blocked: progress.blocked,
      freeShare: progress.freeShare,
      apiSpentCny: progress.apiSpentCny,
      simulatedResults: progress.simulatedResults,
      simulatedOnly: progress.simulatedOnly,
      nextActions: progress.nextActions.slice(0, 12),
      mainModelQuota: progress.mainModelQuota
    };
  }

  statusSnapshot() {
    const progress = progressOf(this.state);
    const pool = planPool({
      tasks: Object.values(this.state.tasks),
      models: this.config.models,
      roles: this.config.roles,
      policy: this.state.policy,
      state: this.state
    });
    const tasks = this.state.order
      .map((id) => this.state.tasks[id])
      .filter(Boolean)
      .map((task) => ({
        id: task.id,
        title: task.title,
        group: task.group,
        kind: task.kind,
        tier: task.tier,
        role: task.role,
        status: task.status,
        difficulty: task.difficulty,
        confidentiality: task.confidentiality,
        deps: task.deps,
        resources: task.resources,
        priority: task.priority,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        assignedModel: task.assignedModel,
        route: task.route,
        score: task.score,
        error: task.error,
        blockedReason: task.blockedReason,
        reviewReason: task.reviewReason ?? null,
        simulated: Boolean(task.result?.meta?.simulated),
        artifacts: (task.result?.artifacts ?? []).map((artifact) => ({
          name: artifact.name,
          path: artifact.path,
          latestPath: artifact.latestPath,
          bytes: artifact.bytes,
          sha256: artifact.sha256
        })),
        summary: task.result?.summary ?? null,
        gate: task.result?.gate ?? null,
        review: task.review ?? null,
        approval: task.approval ?? null,
        parentId: task.parentId,
        children: task.children,
        integratedBy: task.integratedBy,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        finishedAt: task.finishedAt
      }));
    const models = this.config.models.map((model) => {
      const stats = this.state.modelStats[model.id];
      return {
        id: model.id,
        label: model.label,
        provider: model.provider,
        costClass: model.costClass,
        privacy: model.privacy,
        available: model.available,
        contextTokens: model.contextTokens,
        inputCostCnyPerMTok: model.inputCostCnyPerMTok,
        outputCostCnyPerMTok: model.outputCostCnyPerMTok,
        capabilities: model.capabilities,
        stats: stats ? {
          runs: stats.runs,
          successes: stats.successes,
          avgScore: stats.runs ? Math.round(stats.qualitySum / stats.runs) : 0,
          costCny: stats.costCny,
          tokensIn: stats.tokensIn,
          tokensOut: stats.tokensOut
        } : null
      };
    });
    return {
      project: this.state.project,
      projectDescription: this.state.projectDescription ?? "",
      policy: this.state.policy,
      progress,
      pool,
      tasks,
      models,
      providers: this.config.providers,
      locks: this.state.locks,
      events: this.state.events.slice(-100).reverse(),
      attempts: this.state.attempts.slice(-50).reverse(),
      mainModelQuota: this.state.mainModelQuota,
      run: this.state.run,
      running: this.running,
      paused: this.isPaused(),
      warnings: [
        this.config.models.some((model) => model.provider.startsWith("mock")) ? "Mock provider output is simulated and must not be used as engineering evidence." : null,
        this.config.providers?.opencode?.verified === false ? "OpenCode CLI adapter flags are unverified for your installed version." : null,
        this.config.providers?.codex?.verified === false ? "Codex CLI adapter flags are unverified for your installed version." : null
      ].filter(Boolean)
    };
  }
}
