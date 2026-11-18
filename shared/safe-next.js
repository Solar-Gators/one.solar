/**
 * Is `next` (from the sign-in page's ?next=) safe to go to after signing in? Only a path on this site ("/sgaa/"),
 * optionally with an app page after "#" ("/sgaa/#/contact?need=…&to=…"). Never another site ("//evil.example",
 * "https://…"). Its own file so tests can load it without a browser (tests/sgaaLib.test.mjs).
 */
export const isSafeNext = (next) => /^\/(?!\/)[\w.~/-]*(#\/?[\w.~/?=&%-]*)?$/.test(String(next || ''));
