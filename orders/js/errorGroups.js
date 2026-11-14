/** Admin → Diagnostics (046): errors grouped by kind, message and build, newest first. */
export function groupErrors(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.kind}|${r.message}|${r.version}`;
    const g = groups.get(key) || { kind: r.kind, message: r.message, version: r.version, first: r.at, last: r.last_at, count: 0, apps: new Set(), people: new Set(), sample: r };
    g.count += r.count || 1;
    if (r.at < g.first) g.first = r.at;
    if (r.last_at > g.last) (g.last = r.last_at), (g.sample = r);
    if (r.app) g.apps.add(r.app);
    g.people.add(r.user_id || 'signed out');
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}
