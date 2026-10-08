/** One native presentation owner; the underlying panel layout remains live. */
export class FullscreenPresentation {
  private session: {
    viewId: string;
    panel: boolean;
    html: boolean;
    wasWindowFullscreen: boolean;
  } | null = null;

  constructor(
    private readonly host: {
      isWindowFullscreen(): boolean;
      setWindowFullscreen(fullscreen: boolean): void;
      canPresent(viewId: string): boolean;
      present(viewId: string | null): void;
      exitDocument(viewId: string): Promise<void>;
    }
  ) {}

  get viewId(): string | null {
    return this.session?.viewId ?? null;
  }
  get windowFullscreen(): boolean {
    return this.session?.wasWindowFullscreen ?? this.host.isWindowFullscreen();
  }
  get html(): boolean {
    return this.session?.html ?? false;
  }

  private enter(viewId: string) {
    if (!this.host.canPresent(viewId))
      throw new Error("Only a presented panel can enter fullscreen");
    if (this.session && this.session.viewId !== viewId)
      throw new Error("Another panel owns fullscreen");
    this.session ??= {
      viewId,
      panel: false,
      html: false,
      wasWindowFullscreen: this.host.isWindowFullscreen(),
    };
    return this.session;
  }

  private show() {
    this.host.setWindowFullscreen(true);
    this.host.present(this.viewId);
  }

  enterPanel(viewId: string): void {
    this.enter(viewId).panel = true;
    this.show();
  }

  enterHtml(viewId: string): void {
    this.enter(viewId).html = true;
    this.show();
  }

  leaveHtml(viewId: string): Promise<void> {
    const session = this.session;
    if (session?.viewId !== viewId) return Promise.resolve();
    session.html = false;
    if (!session.panel) this.finish();
    return Promise.resolve();
  }

  private finish(restoreWindow = true): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.host.present(null);
    if (restoreWindow) this.host.setWindowFullscreen(session.wasWindowFullscreen);
  }

  /** Escape leaves HTML fullscreen first, then panel fullscreen. */
  async escape(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.html) {
      await this.host.exitDocument(session.viewId);
      // The native event normally arrives during exitDocument; retain the
      // same semantics if it arrives afterwards, without affecting a new owner.
      if (this.session === session) await this.leaveHtml(session.viewId);
    } else this.finish();
  }

  async exit(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.html) await this.host.exitDocument(session.viewId);
    if (this.session === session) this.finish();
  }

  /** Navigation, destruction, or withdrawn presentation invalidates ownership. */
  async retire(viewId: string, documentIsAlive = false): Promise<void> {
    if (this.session?.viewId !== viewId) return;
    const html = this.session.html;
    this.finish();
    if (html && documentIsAlive) await this.host.exitDocument(viewId);
  }

  /** An OS/menu window exit is authoritative, even for nested HTML fullscreen. */
  async windowLeftFullscreen(): Promise<void> {
    const session = this.session;
    this.finish(false);
    if (session?.html) await this.host.exitDocument(session.viewId);
  }

  async toggleWindow(): Promise<void> {
    if (this.session) {
      await this.exit();
      this.host.setWindowFullscreen(false);
    } else this.host.setWindowFullscreen(!this.host.isWindowFullscreen());
  }
}
