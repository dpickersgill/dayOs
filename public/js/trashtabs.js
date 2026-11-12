// The Trash and recycling app's tab registry (release 2026.11.22). PHASE 1 COPY by workstream "routes", the same contract
// as the release spec: the schedule workstream owns this file and the assembler keeps its version.
// A module registers a tab: registerTab({ id, label, order, show: (ctx) => bool, render: async (el, params) => void }).
export const TABS = [];
export function registerTab(tab) {
  const i = TABS.findIndex((t) => t.id === tab.id);
  if (i >= 0) TABS.splice(i, 1, tab); else TABS.push(tab);
  TABS.sort((a, b) => (a.order || 0) - (b.order || 0));
}
