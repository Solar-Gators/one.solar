/**
 * Makes a GatorWire build look and work like the other OneSolar apps. Run it after putting a new
 * build in gatorwire/index.html (it's safe to run again):
 *
 *   npm run gatorwire
 *
 * It does three things:
 *   1. The Share dialog lists every .json file in the repository to pick from (tools/gatorwire/file-picker.js),
 *      instead of a box where you type the file's exact name.
 *   2. The page loads ../shared/theme.js (the shared Light / Dark setting) and gatorwire/onesolar-skin.css + .js:
 *      the OneSolar top bar above GatorWire's toolbar, and the OneSolar light colours.
 *   3. It writes gatorwire/onesolar-light.css: a light version of every colour the build wrote straight into its
 *      styles (GatorWire's dark colours are already OneSolar's dark ones).
 *
 * The build is minified, so the names of its helpers change from build to build; they're found by what
 * the code looks like. If GatorWire's code changes so much that one can't be found, this stops and says which.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url);
const FILE = here('../gatorwire/index.html');
let page = readFileSync(FILE, 'utf8');

const fail = (what) => {
  console.error(`GatorWire: couldn't find ${what} in gatorwire/index.html. The build changed; update tools/gatorwire-onesolar.mjs.`);
  process.exit(1);
};
const find = (re, what) => page.match(re) || fail(what);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- 1. The file picker ----------------------------------------------------------------------
if (page.includes('function GwFiles(')) {
  console.log('File picker: already there.');
} else {
  const names = {
    parseRepo: find(/function (\w+)\(e\)\{let t=e\.trim\(\)\.replace\(\/\\\.git\$\//, 'the repository-name reader')[1],
    headers: find(/function (\w+)\(e,t=\{\}\)\{return\{Accept:`application\/vnd\.github\+json`/, 'the GitHub request headers')[1],
    repoUrl: find(/[,;](\w+)=e=>`\$\{\w+\(e\)\}\/repos\//, 'the repository address')[1],
    githubError: find(/async function (\w+)\(e,t\)\{let n=``;try\{n=\(await e\.json\(\)\)\.message/, 'the GitHub error messages')[1],
    offline: find(/[,;](\w+)=\(\)=>\{throw new \w+\(`GitHub could not be reached/, 'the "GitHub could not be reached" error')[1],
  };
  const tokenKey = find(/(\w+)=`gatorwire:shared:token`/, 'the saved token key')[1];
  const apiKey = find(/(\w+)=`gatorwire:shared:api`/, 'the API address key')[1];
  names.savedToken = find(new RegExp(`function (\\w+)\\(\\)\\{try\\{return localStorage\\.getItem\\(${esc(tokenKey)}\\)\\}catch\\{return null\\}\\}`), 'the saved token')[1];
  names.apiBase = find(new RegExp(`function (\\w+)\\(\\)\\{try\\{return localStorage\\.getItem\\(${esc(apiKey)}\\)\\?\\?void 0\\}`), 'the API address')[1];

  // The Share dialog, its "File in the repository" box, and its Connect button.
  const box = find(
    /\(0,(\w+)\.jsxs\)\(`label`,\{children:\[\(0,\w+\.jsx\)\(`span`,\{children:`File in the repository`\}\),\(0,\w+\.jsx\)\(`input`,\{type:`text`,value:(\w+),onChange:e=>(\w+)\(e\.target\.value\),spellCheck:!1\}\)\]\}\)/,
    'the "File in the repository" box'
  );
  const [boxCode, jsx, value, setValue] = box;
  const dialogStart = page.lastIndexOf('function ', box.index);
  const dialog = page.slice(dialogStart, box.index);
  if (!/^function \w+\(\{shared:e,onClose:t\}\)/.test(dialog)) fail('the Share dialog');
  names.jsx = jsx;
  names.react = (dialog.match(/\(0,(\w+)\.useState\)/) || fail('React in the Share dialog'))[1];
  const connect = find(/disabled:(\w+)\|\|!(\w+)\.trim\(\),onClick:\(\)=>void (\w+)\(\(\)=>e\.connect\(\2,(\w+),(\w+)\),!0\)/, 'the Connect button');
  const [connectCode, busy, repo, run, value2, token] = connect;
  if (value2 !== value) fail('the file name the Connect button uses');

  let picker = readFileSync(here('./gatorwire/file-picker.js'), 'utf8');
  picker = picker.replace(/\$(\w+)/g, (m, k) => (k in names ? names[k] : m));
  page = page.slice(0, dialogStart) + picker + page.slice(dialogStart);
  page = page.replace(boxCode, `(0,${jsx}.jsx)(GwFiles,{repo:${repo},token:${token},value:${value},onChange:${setValue}})`);
  page = page.replace(connectCode, connectCode.replace(`!${repo}.trim()`, `!${repo}.trim()||!${value}.trim()`));

  const styleEnd = page.lastIndexOf('</style>');
  page = page.slice(0, styleEnd) + readFileSync(here('./gatorwire/file-picker.css'), 'utf8') + '\n' + page.slice(styleEnd);
  console.log('File picker: added to the Share dialog.');
}

// ---- 1b. Clearer wording on the Share button (top right) -------------------------------------
// GatorWire's labels ("Shared · read-only") didn't look like something to click. Same states, plainer words.
const LABELS = {
  local: 'Share with the team',
  synced: 'Shared · up to date',
  unsaved: 'Shared · saving soon',
  saving: 'Shared · saving…',
  conflict: 'Shared · needs a decision',
  drawing: 'Shared · drawing updated',
  readonly: 'View only · add a token to edit',
  error: 'Shared · not synced',
};
const labels = page.match(/\{local:`[^`]*`,synced:`[^`]*`,unsaved:`[^`]*`,saving:`[^`]*`,conflict:`[^`]*`,drawing:`[^`]*`,readonly:`[^`]*`,error:`[^`]*`\}/) || fail('the Share button labels');
const newLabels = `{${Object.entries(LABELS).map(([k, v]) => `${k}:\`${v}\``).join(',')}}`;
if (labels[0] === newLabels) console.log('Share button wording: already there.');
else {
  page = page.replace(labels[0], newLabels);
  console.log('Share button wording: updated.');
}

// ---- 2. Shared Light / Dark, the OneSolar top bar --------------------------------------------
if (page.includes('onesolar-skin.css')) {
  console.log('OneSolar look: already hooked up.');
} else {
  const headEnd = page.lastIndexOf('</head>');
  page = page.slice(0, headEnd)
    + '<!-- OneSolar (tools/gatorwire-onesolar.mjs): shared Light / Dark, light colours, top bar. -->\n'
    + '    <script src="../shared/theme.js"></script>\n'
    + '    <link rel="icon" href="../shared/assets/favicon.png">\n'
    + '    <link rel="stylesheet" href="onesolar-light.css">\n'
    + '    <link rel="stylesheet" href="onesolar-skin.css">\n  '
    + page.slice(headEnd);
  const bodyEnd = page.lastIndexOf('</body>');
  page = page.slice(0, bodyEnd) + '  <script type="module" src="onesolar-skin.js"></script>\n  ' + page.slice(bodyEnd);
  console.log('OneSolar look: hooked up.');
}
writeFileSync(FILE, page);

// ---- 3. Light colours for what the build wrote straight into its styles -----------------------
// GatorWire's own styles (the last <style> in the page). Its dark colours → OneSolar's light ones.
const css = page.slice(page.lastIndexOf('<style>') + 7, page.lastIndexOf('</style>'));
const LIGHT = {
  // page backgrounds
  '041327': '#f4f6f9', '05172e': '#f4f6f9', '04101a': '#f4f6f9', '04111a': '#f4f6f9', '07131c': '#f4f6f9', '08131c': '#f4f6f9', '0a1720': '#f4f6f9', '0d1c26': '#f4f6f9',
  // panels, inputs, menus
  '061a35': '#ffffff', '071d39': '#ffffff', '0a2444': '#ffffff', '081f3d': '#ffffff', '002657': '#ffffff', '0a1b34': '#ffffff', '1b1418': '#ffffff', '132633': '#ffffff', '17242d': '#ffffff', '1a303d': '#ffffff',
  '0d2b50': '#f8fafc', '0a2830': '#f8fafc', '0b2b5a': '#eef4ff',
  // lines
  '31577f': '#c8d1dc', '4a6a90': '#c8d1dc', '2c4f7c': '#c8d1dc', '416b97': '#c8d1dc', '23486f': '#dde3ea', '2f5fa4': '#cbdcfb',
  // light text on dark → dark text on light
  'f7f9ff': '#1c2733', 'dbe8ff': '#1e3a78', 'b8c9df': '#5d6d7e', 'c7b8bd': '#5d6d7e', 'becbd3': '#5d6d7e', '8da0ac': '#5d6d7e', '7d8f9c': '#5d6d7e', '5d7180': '#5d6d7e', '60717b': '#5d6d7e', '6d84a0': '#5d6d7e', 'a8b8ce': '#5d6d7e',
  // red, amber, green: washes and words
  'ff9d9d': '#b42318', 'ffb7b7': '#7a1a12', 'ffe9e9': '#7a1a12', 'ff7373': '#b42318',
  '351d22': '#fdecea', '2a1619': '#fdecea', '241619': '#fdecea', '321a1d': '#fdecea', '351c20': '#fdecea', '331b1f': '#fdecea', '4a221f': '#fbd9d4', '35202a': '#fdecea',
  '5c3a3f': '#f5c2bd', '6c3438': '#f5c2bd', '6d3238': '#f5c2bd',
  'ffd79a': '#6b4304', 'ffc486': '#6b4304', '26200f': '#fff7e0', '241f11': '#fff7e0', '2a1f13': '#fff7e0', '342718': '#fff7e0', '6b552a': '#f3d98c', '73472d': '#f3d98c',
  '123124': '#e6f6ec', '10291e': '#e6f6ec', '286345': '#b8e2c7', '52c97f': '#17803d',
};
const lighten = (v) => v.replace(/#([0-9a-fA-F]{6})\b(?![0-9a-fA-F])/g, (m, h) => LIGHT[h.toLowerCase()] ?? m);
const scope = (sel) => sel.split(/,(?![^(]*\))/).map((s) => {
  s = s.trim();
  if (s.startsWith(':root')) return s.replace(':root', ':root[data-theme="light"]');
  if (/^(html|body)\b/.test(s)) return `:root[data-theme="light"] ${s.replace(/^html\s*/, '')}`.trim();
  return `:root[data-theme="light"] ${s}`;
}).join(',');

const out = [];
// Walk the stylesheet: plain rules, and rules inside @media / @supports (not @keyframes).
(function walk(text, wrap) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    const body = text.slice(open + 1, j - 1);
    if (/^@(media|supports)/.test(prelude)) walk(body, prelude);
    else if (!prelude.startsWith('@') && prelude !== ':root') {
      const decls = body.split(/;(?![^(]*\))/).map((d) => d.trim()).filter((d) => d && lighten(d) !== d).map(lighten);
      if (decls.length) {
        const rule = `${scope(prelude)}{${decls.join(';')}}`;
        out.push(wrap ? `${wrap}{${rule}}` : rule);
      }
    }
    i = j;
  }
})(css, '');

writeFileSync(here('../gatorwire/onesolar-light.css'),
  `/* GENERATED by tools/gatorwire-onesolar.mjs from gatorwire/index.html: don't edit, run "npm run gatorwire".\n`
  + ` * Light-mode versions of the colours GatorWire's build writes straight into its rules. */\n${out.join('\n')}\n`);
console.log(`Light colours: ${out.length} rules in gatorwire/onesolar-light.css.`);
