// Fan-out scheduler for multi-device actions.
//
// This is a load-management primitive, not an anti-correlation measure. It bounds
// concurrency, smooths load on the host and on any backend we drive (so we don't
// self-inflict rate-limit failures against our own staging), and produces a
// reconstructable timeline for every run. The randomized per-job delay is a
// realistic-concurrency safeguard (humans like an occasional pause), not a
// detection-evasion feature.
//
// Phase 3 of the roadmap.

export interface SchedulerOptions {
  /** Global maximum number of jobs running at any moment. */
  globalConcurrencyCap: number;
  /** Token-bucket rate limit. Optional. */
  rateLimit?: { maxJobs: number; windowMs: number };
  /** Default per-job delay window (jitter is uniform random in this range). */
  defaultDelay?: { minMs: number; maxMs: number };
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable RNG for tests (returns [0, 1)). */
  rand?: () => number;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SchedulerJobSpec<R = unknown> {
  /** Optional id; generated if absent. */
  id?: string;
  /** Logical group id (e.g. a single run id); group-level cancel supported. */
  groupId?: string;
  /** Action to run. Aborted via the signal on cancel. */
  action: (signal: AbortSignal) => Promise<R>;
  /** Lower = higher priority. Default 100. */
  priority?: number;
  /** Override default delay for this job. */
  delay?: { minMs: number; maxMs: number };
  /** If not started within this many ms after submit, the job is cancelled. */
  ttlMs?: number;
  /** Free-form label for audit logs. */
  label?: string;
}

export interface AuditEntry<R = unknown> {
  jobId: string;
  groupId?: string;
  label?: string;
  priority: number;
  scheduledAt: number;
  startedAt?: number;
  completedAt?: number;
  appliedDelayMs: number;
  status: JobStatus;
  error?: string;
  result?: R;
  orderIndex: number;
}

export interface SubmitResult {
  jobId: string;
  audit: AuditEntry; // mutable reference; status updates as job progresses
}

interface QueueItem<R = unknown> {
  spec: SchedulerJobSpec<R>;
  id: string;
  groupId?: string;
  enqueuedAt: number;
  delayMs: number;
  orderIndex: number;
  priority: number;
  controller: AbortController;
  delayTimer?: ReturnType<typeof setTimeout>;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

interface RunningItem<R = unknown> {
  spec: SchedulerJobSpec<R>;
  id: string;
  groupId?: string;
  startedAt: number;
  orderIndex: number;
  controller: AbortController;
  promise: Promise<R>;
}

export class Scheduler {
  private readonly opts: Required<SchedulerOptions>;
  private queue: QueueItem[] = [];
  private running = new Map<string, RunningItem>();
  private auditLog: AuditEntry[] = [];
  private rateState = { windowStart: 0, countInWindow: 0 };
  private orderCounter = 0;
  private auditListeners = new Set<(e: AuditEntry) => void>();
  private drainResolvers: Array<() => void> = [];
  private seqCounter = 0;

  constructor(options: SchedulerOptions) {
    if (options.globalConcurrencyCap < 1) {
      throw new Error('globalConcurrencyCap must be >= 1');
    }
    if (options.rateLimit && options.rateLimit.maxJobs < 1) {
      throw new Error('rateLimit.maxJobs must be >= 1');
    }
    if (options.defaultDelay && options.defaultDelay.minMs < 0) {
      throw new Error('defaultDelay.minMs must be >= 0');
    }
    if (options.defaultDelay && options.defaultDelay.maxMs < options.defaultDelay.minMs) {
      throw new Error('defaultDelay.maxMs must be >= defaultDelay.minMs');
    }
    this.opts = {
      globalConcurrencyCap: options.globalConcurrencyCap,
      rateLimit: options.rateLimit ?? { maxJobs: Infinity, windowMs: 0 },
      defaultDelay: options.defaultDelay ?? { minMs: 0, maxMs: 0 },
      now: options.now ?? (() => Date.now()),
      rand: options.rand ?? Math.random,
    };
  }

  /**
   * Submit a job. Returns immediately with the assigned jobId and a live audit entry.
   * The audit entry's status transitions queued → running → completed/failed/cancelled.
   */
  submit<R>(spec: SchedulerJobSpec<R>): SubmitResult {
    if (spec.priority !== undefined && !Number.isFinite(spec.priority)) {
      throw new Error('priority must be a finite number');
    }
    const id = spec.id ?? this.makeId();
    const now = this.opts.now();
    const priority = spec.priority ?? 100;
    const delay = spec.delay ?? this.opts.defaultDelay;
    const delayMs = this.sampleDelay(delay);

    const controller = new AbortController();
    const orderIndex = ++this.orderCounter;
    const audit: AuditEntry<R> = {
      jobId: id,
      groupId: spec.groupId,
      label: spec.label,
      priority,
      scheduledAt: now,
      appliedDelayMs: delayMs,
      status: 'queued',
      orderIndex,
    };
    this.auditLog.push(audit as AuditEntry);
    this.emitAudit(audit as AuditEntry);

    const item: QueueItem<R> = {
      spec,
      id,
      groupId: spec.groupId,
      enqueuedAt: now,
      delayMs,
      orderIndex,
      controller,
      priority,
    };

    // TTL.
    if (spec.ttlMs !== undefined && spec.ttlMs > 0) {
      item.ttlTimer = setTimeout(() => {
        if (audit.status === 'queued') {
          this.cancelInternal(item, 'ttl_expired');
        }
      }, spec.ttlMs);
    }

    // Delay: schedule the job's start, then run the dispatch loop.
    if (delayMs > 0) {
      item.delayTimer = setTimeout(() => {
        item.delayTimer = undefined;
        this.tryStart(item);
      }, delayMs);
      // Insert into queue at the right priority position. Insertion happens now even
      // though the job doesn't start until after the delay, so cancellation ordering
      // works correctly. We re-sort on each tryStart, so position-in-queue is correct.
      this.insertByPriority(item);
    } else {
      this.insertByPriority(item);
      this.tryStart(item);
    }

    return { jobId: id, audit: audit as AuditEntry };
  }

  /** Cancel a single job by id. Returns true if the job was queued or running. */
  cancel(jobId: string, reason = 'cancelled'): boolean {
    const queued = this.queue.find(it => it.id === jobId);
    if (queued) {
      this.cancelInternal(queued, reason);
      return true;
    }
    const running = this.running.get(jobId);
    if (running) {
      this.cancelInternal(running, reason);
      return true;
    }
    return false;
  }

  /** Cancel all jobs sharing a groupId. Returns the count cancelled. */
  cancelGroup(groupId: string, reason = 'cancelled'): number {
    let n = 0;
    for (const it of [...this.queue]) {
      if (it.groupId === groupId) {
        this.cancelInternal(it, reason);
        n++;
      }
    }
    for (const [, it] of [...this.running]) {
      if (it.groupId === groupId) {
        this.cancelInternal(it, reason);
        n++;
      }
    }
    return n;
  }

  /** Subscribe to audit events. Returns an unsubscribe function. */
  onAudit(listener: (e: AuditEntry) => void): () => void {
    this.auditListeners.add(listener);
    return () => this.auditListeners.delete(listener);
  }

  /** Returns a copy of the audit log. */
  getAudit(): AuditEntry[] {
    return this.auditLog.slice();
  }

  /** Snapshot of internal state for tests. */
  getStats(): { queued: number; running: number; completed: number; runningIds: string[] } {
    return {
      queued: this.queue.length,
      running: this.running.size,
      completed: this.auditLog.filter(e => e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled').length,
      runningIds: [...this.running.keys()],
    };
  }

  /**
   * Resolve when every submitted job has reached a terminal state (completed /
   * failed / cancelled). Useful for tests and shutdown paths.
   */
  drain(): Promise<void> {
    if (this.isDrained()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  // ----- internal -----

  private isDrained(): boolean {
    return this.queue.length === 0 && this.running.size === 0;
  }

  private makeId(): string {
    return `job_${++this.seqCounter}`;
  }

  private sampleDelay(d: { minMs: number; maxMs: number }): number {
    if (d.maxMs <= d.minMs) return d.minMs;
    const span = d.maxMs - d.minMs;
    return Math.floor(d.minMs + this.opts.rand() * span);
  }

  private insertByPriority(item: QueueItem): void {
    // Sort: lower priority value first; among ties, earlier enqueuedAt first; among
    // ties, earlier orderIndex first.
    const i = this.queue.findIndex(q =>
      q.priority > item.priority ||
      (q.priority === item.priority && q.enqueuedAt > item.enqueuedAt) ||
      (q.priority === item.priority && q.enqueuedAt === item.enqueuedAt && q.orderIndex > item.orderIndex)
    );
    if (i === -1) {
      this.queue.push(item);
    } else {
      this.queue.splice(i, 0, item);
    }
  }

  private tryStart(item: QueueItem): void {
    // Re-check it's still queued and not aborted
    const idx = this.queue.indexOf(item);
    if (idx === -1) return;
    if (item.controller.signal.aborted) {
      this.removeFromQueue(item);
      this.finishAudit(item.id, 'cancelled', 'aborted_pre_start');
      this.tryDispatch();
      this.maybeResolveDrain();
      return;
    }

    // Rate-limit check.
    const now = this.opts.now();
    if (this.opts.rateLimit.windowMs > 0) {
      if (now - this.rateState.windowStart >= this.opts.rateLimit.windowMs) {
        this.rateState.windowStart = now;
        this.rateState.countInWindow = 0;
      }
      if (this.rateState.countInWindow >= this.opts.rateLimit.maxJobs) {
        // Defer — re-arm a small retry timer and return.
        setTimeout(() => this.tryStart(item), Math.max(1, this.opts.rateLimit.windowMs - (now - this.rateState.windowStart)));
        return;
      }
    }

    // Concurrency cap check.
    if (this.running.size >= this.opts.globalConcurrencyCap) {
      // Don't start; another completion will trigger tryDispatch.
      return;
    }

    // Consume a rate token.
    if (this.opts.rateLimit.windowMs > 0) {
      this.rateState.countInWindow++;
    }

    // Remove from queue and start.
    this.removeFromQueue(item);
    const startedAt = this.opts.now();
    const audit = this.auditLog.find(a => a.jobId === item.id);
    if (audit) {
      audit.status = 'running';
      audit.startedAt = startedAt;
      this.emitAudit(audit);
    }

    const runningItem: RunningItem = {
      spec: item.spec,
      id: item.id,
      groupId: item.groupId,
      startedAt,
      orderIndex: item.orderIndex,
      controller: item.controller,
      promise: Promise.resolve().then(() => item.spec.action(item.controller.signal)),
    };
    this.running.set(item.id, runningItem);

    runningItem.promise.then(
      (result) => {
        this.running.delete(item.id);
        this.finishAudit(item.id, 'completed', undefined, result);
        this.tryDispatch();
        this.maybeResolveDrain();
      },
      (error) => {
        this.running.delete(item.id);
        // Cancellation surfaces as an error from the action; treat aborted as cancelled
        if (item.controller.signal.aborted) {
          this.finishAudit(item.id, 'cancelled', 'aborted');
        } else {
          this.finishAudit(item.id, 'failed', error?.message ?? String(error));
        }
        this.tryDispatch();
        this.maybeResolveDrain();
      }
    );

    // Try to dispatch more if concurrency cap allows.
    this.tryDispatch();
  }

  private tryDispatch(): void {
    // Walk the queue in order, starting as many jobs as the cap permits.
    while (this.queue.length > 0 && this.running.size < this.opts.globalConcurrencyCap) {
      // Pick the highest-priority item (queue is already sorted on insert).
      const item = this.queue[0];
      // Re-check delayTimer: if the delay hasn't elapsed, the item's setTimeout hasn't fired
      // and it's not yet ready. tryStart was the entry point for that timer.
      if (item.delayTimer !== undefined) {
        // Still waiting for delay; break to avoid starting it prematurely.
        break;
      }
      this.tryStart(item);
    }
  }

  private removeFromQueue(item: QueueItem): void {
    const i = this.queue.indexOf(item);
    if (i !== -1) this.queue.splice(i, 1);
  }

  private cancelInternal(item: { id: string; spec: SchedulerJobSpec; groupId?: string; controller: AbortController; delayTimer?: ReturnType<typeof setTimeout>; ttlTimer?: ReturnType<typeof setTimeout> }, reason: string): void {
    if (item.delayTimer !== undefined) {
      clearTimeout(item.delayTimer);
      item.delayTimer = undefined;
    }
    if (item.ttlTimer !== undefined) {
      clearTimeout(item.ttlTimer);
      item.ttlTimer = undefined;
    }
    item.controller.abort();
    // If queued, remove and mark cancelled. If running, the .then() handler will mark it
    // cancelled when it observes the aborted signal.
    const queuedIdx = this.queue.findIndex(q => q.id === item.id);
    if (queuedIdx !== -1) {
      this.queue.splice(queuedIdx, 1);
      this.finishAudit(item.id, 'cancelled', reason);
      this.tryDispatch();
      this.maybeResolveDrain();
    }
    // If running, leave the audit update to the .then() handler so the result/error is recorded.
  }

  private finishAudit(jobId: string, status: JobStatus, error?: string, result?: unknown): void {
    const a = this.auditLog.find(e => e.jobId === jobId);
    if (!a) return;
    a.status = status;
    a.completedAt = this.opts.now();
    if (error !== undefined) a.error = error;
    if (result !== undefined) a.result = result;
    this.emitAudit(a);
  }

  private emitAudit(a: AuditEntry): void {
    for (const l of this.auditListeners) {
      try { l(a); } catch { /* listener errors must not break the scheduler */ }
    }
  }

  private maybeResolveDrain(): void {
    if (this.isDrained() && this.drainResolvers.length > 0) {
      const rs = this.drainResolvers;
      this.drainResolvers = [];
      for (const r of rs) r();
    }
  }
}