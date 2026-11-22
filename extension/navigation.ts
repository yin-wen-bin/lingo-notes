export type PanelRoute = 'learn' | 'history' | 'history-detail' | 'settings';

/** Local navigation identity is separate from billable learning requests. */
export class PanelNavigation {
  route: PanelRoute = 'learn';
  private version = 0;
  get selectedTab() { return this.route === 'history-detail' ? 'history' : this.route; }
  get visibleView() { return this.route === 'history-detail' ? 'learn' : this.route; }
  ticket() { return this.version; }
  isCurrent(ticket: number) { return ticket === this.version; }
  go(route: PanelRoute) { this.route = route; ++this.version; }
  clear() { this.route = 'learn'; ++this.version; }
}
