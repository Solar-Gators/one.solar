/**
 * Projects: calculated fields. A small arithmetic language worked out here, never eval()'d and never run as SQL.
 *
 *   numbers 1.5   text 'pass'   field keys (budget, cell_count) and built-ins: estimate_hours, progress,
 *   start_date, due_date, priority, title
 *   + - * / %   < <= > >= == !=   and or not   a ? b : c   ( )
 *   min(a, b…) max(a, b…) round(x, places) abs(x) ceil(x) floor(x) if(test, a, b) coalesce(a, b…)
 *   days_between(a, b)  today()  len(text)
 *
 * A blank field is null; anything worked out from a null is null (so a half-filled item shows nothing, not 0).
 * Calculated values are shown on the item and in lists; they aren't stored, so they can't be filtered on.
 */

const FUNCTIONS = {
  min: (...a) => (a.some((x) => x === null) ? null : Math.min(...a)),
  max: (...a) => (a.some((x) => x === null) ? null : Math.max(...a)),
  round: (x, n = 0) => (x === null ? null : Math.round(x * 10 ** n) / 10 ** n),
  abs: (x) => (x === null ? null : Math.abs(x)),
  ceil: (x) => (x === null ? null : Math.ceil(x)),
  floor: (x) => (x === null ? null : Math.floor(x)),
  if: (c, a, b = null) => (c ? a : b),
  coalesce: (...a) => a.find((x) => x !== null && x !== '') ?? null,
  len: (x) => (x === null ? null : String(x).length),
  today: () => new Date().toISOString().slice(0, 10),
  days_between: (a, b) => {
    const [x, y] = [Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`), Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`)];
    return a === null || b === null || Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((y - x) / 86400000);
  },
};
export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);
export const FORMULA_BUILTINS = ['estimate_hours', 'progress', 'start_date', 'due_date', 'priority', 'title'];

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|[-+*/%()<>?:,]))/y;
  let m;
  let at = 0;
  while (at < src.length) {
    if (/^\s*$/.test(src.slice(at))) break;
    re.lastIndex = at;
    m = re.exec(src);
    if (!m) throw new Error(`The formula has something it can't read at "${src.slice(at, at + 12).trim()}".`);
    at = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: 'str', v: m[2] ?? m[3] });
    else if (m[4] !== undefined) out.push({ t: ['and', 'or', 'not'].includes(m[4]) ? 'op' : 'id', v: m[4] });
    else out.push({ t: 'op', v: m[5] });
  }
  return out;
}

/** Parse into a tree: precedence from loosest to tightest is ?:, or, and, not, comparisons, + -, * / %, unary -. */
function parse(src) {
  const toks = tokenize(String(src || ''));
  if (!toks.length) throw new Error('The formula is empty.');
  if (toks.length > 200) throw new Error('The formula is too long.');
  let i = 0;
  const peek = (v) => toks[i]?.t === 'op' && toks[i].v === v;
  const eat = (v) => (peek(v) ? (i++, true) : false);
  const need = (v) => {
    if (!eat(v)) throw new Error(`The formula is missing "${v}".`);
  };
  const binary = (next, ops) => () => {
    let left = next();
    while (toks[i]?.t === 'op' && ops.includes(toks[i].v)) left = { op: toks[i++].v, a: left, b: next() };
    return left;
  };
  function primary() {
    const tk = toks[i++];
    if (!tk) throw new Error('The formula ends too soon.');
    if (tk.t === 'num' || tk.t === 'str') return { lit: tk.v };
    if (tk.t === 'id') {
      if (!eat('(')) return { ref: tk.v };
      if (!Object.hasOwn(FUNCTIONS, tk.v)) throw new Error(`"${tk.v}" isn't a function a formula can use.`);
      const args = [];
      if (!eat(')')) {
        do args.push(ternary()); while (eat(','));
        need(')');
      }
      if (args.length > 20) throw new Error('Too many values in a function.');
      return { fn: tk.v, args };
    }
    if (tk.v === '(') {
      const e = ternary();
      need(')');
      return e;
    }
    if (tk.v === '-') return { op: 'neg', a: primary() };
    throw new Error(`The formula has "${tk.v}" where a value should be.`);
  }
  const mul = binary(primary, ['*', '/', '%']);
  const addn = binary(mul, ['+', '-']);
  const cmp = binary(addn, ['<', '<=', '>', '>=', '==', '!=']);
  const not = () => (toks[i]?.t === 'op' && toks[i].v === 'not' ? (i++, { op: 'not', a: not() }) : cmp());
  const and = binary(not, ['and']);
  const or = binary(and, ['or']);
  function ternary() {
    const c = or();
    if (!eat('?')) return c;
    const a = ternary();
    need(':');
    return { op: '?', a: c, b: a, c: ternary() };
  }
  const tree = ternary();
  if (i < toks.length) throw new Error(`The formula has "${toks[i].v}" left over.`);
  return tree;
}

const num = (x) => (x === null || x === '' || x === undefined ? null : typeof x === 'number' ? x : Number.isFinite(Number(x)) ? Number(x) : null);

function run(n, vars, depth = 0) {
  if (depth > 60) throw new Error('The formula is nested too deeply.');
  if ('lit' in n) return n.lit;
  if ('ref' in n) return Object.hasOwn(vars, n.ref) ? vars[n.ref] ?? null : null;
  if ('fn' in n) {
    const args = n.args.map((a) => run(a, vars, depth + 1));
    const numeric = ['min', 'max', 'round', 'abs', 'ceil', 'floor'].includes(n.fn);
    return FUNCTIONS[n.fn](...(numeric ? args.map(num) : args));
  }
  const a = run(n.a, vars, depth + 1);
  if (n.op === 'neg') return num(a) === null ? null : -num(a);
  if (n.op === 'not') return !a;
  if (n.op === '?') return run(a ? n.b : n.c, vars, depth + 1);
  if (n.op === 'and') return a ? run(n.b, vars, depth + 1) : a;
  if (n.op === 'or') return a ? a : run(n.b, vars, depth + 1);
  const b = run(n.b, vars, depth + 1);
  if (['==', '!='].includes(n.op)) return (String(a ?? '') === String(b ?? '')) === (n.op === '==');
  if (['<', '<=', '>', '>='].includes(n.op)) {
    if (a === null || b === null) return null;
    const [x, y] = num(a) !== null && num(b) !== null ? [num(a), num(b)] : [String(a), String(b)];
    return n.op === '<' ? x < y : n.op === '<=' ? x <= y : n.op === '>' ? x > y : x >= y;
  }
  const [x, y] = [num(a), num(b)];
  if (x === null || y === null) return null;
  if (n.op === '+') return x + y;
  if (n.op === '-') return x - y;
  if (n.op === '*') return x * y;
  if (y === 0) return null;
  return n.op === '/' ? x / y : x % y;
}

/** Field keys a formula reads. Throws (with a plain message) if the formula can't be read. */
export function formulaRefs(src) {
  const refs = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if ('ref' in n) refs.add(n.ref);
    for (const k of ['a', 'b', 'c']) walk(n[k]);
    (n.args || []).forEach(walk);
  };
  walk(parse(src));
  return [...refs];
}

/** '' if the formula is fine for these field keys, else what's wrong with it. */
export function checkFormula(src, keys = []) {
  try {
    const unknown = formulaRefs(src).filter((r) => !keys.includes(r) && !FORMULA_BUILTINS.includes(r));
    return unknown.length ? `There's no field with the key "${unknown[0]}".` : '';
  } catch (err) {
    return err.message;
  }
}

/** Work a formula out for an item. Never throws: a formula that can't be worked out gives null. */
export function evalFormula(src, item) {
  try {
    const vars = { ...(item.custom || {}) };
    for (const k of FORMULA_BUILTINS) vars[k] = item[k] ?? null;
    const v = run(parse(src), vars);
    return typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null) : v;
  } catch {
    return null;
  }
}
