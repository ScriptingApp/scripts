export function isServiceInvocation(source: string): boolean {
  return source === "scriptSessionCall" || source === "scriptSessionRequest";
}

/** One root presentation shared by startup, resume, and pairing requests. */
export class PageCoordinator {
  private presentation: Promise<void> | null = null;
  private readonly changes = new Set<() => void>();

  constructor(
    private readonly present: (pairingOnly: boolean) => Promise<void>,
    private readonly hasPairing: () => boolean,
  ) {}

  open(pairingOnly = false): Promise<void> {
    if (this.presentation) return this.presentation;
    // Assign before invoking native presentation, including synchronous/reentrant calls.
    const pending = Promise.resolve().then(() => this.present(pairingOnly));
    const tracked = pending.finally(() => {
      if (this.presentation === tracked) this.presentation = null;
      this.notifyPairingChanged();
    });
    this.presentation = tracked;
    return tracked;
  }

  notifyPairingChanged(): void {
    for (const listener of [...this.changes]) listener();
  }

  waitForPairing(timeoutMs = 120_000): Promise<boolean> {
    if (this.hasPairing()) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        finished = true;
        this.changes.delete(changed);
        if (timer !== undefined) clearTimeout(timer);
      };
      const complete = (paired: boolean) => {
        if (finished) return;
        cleanup();
        resolve(paired);
      };
      const changed = () => {
        if (this.hasPairing()) complete(true);
      };
      this.changes.add(changed);
      timer = setTimeout(() => complete(false), timeoutMs);
      this.open(true).then(
        () => complete(this.hasPairing()),
        error => {
          if (finished) return;
          cleanup();
          reject(error);
        },
      );
      changed();
    });
  }
}
