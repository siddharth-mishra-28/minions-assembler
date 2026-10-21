/**
 * Global run serialization: exactly one SDK session executes at a time (each run spawns
 * a Go child process), so every run route chains its work onto the same queue.
 * Concurrent POSTs execute in submission order and the server stays responsive.
 */
export class RunQueue {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` after every previously enqueued task. The internal chain swallows task
   * errors (a failure never breaks subsequent runs); the returned promise still
   * rejects so the caller can turn the error into an HTTP response.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const queued = this.chain.then(() => fn()) as Promise<T>;
    this.chain = queued.catch(() => { /* keep the chain alive after failures */ });
    return queued;
  }
}
