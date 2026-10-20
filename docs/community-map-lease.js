// A short lease on just the receiver's idle five-second camera fit. TurboWarp
// calls compiled procedures through thread.procedures on every invocation
// (index.js, JSGenerator/procedures.call). Replacing that one property does not
// change the project graph, compiler cache, receiver loop or camera timestamps.
const leases = new WeakMap();
const LEASE_MS = 3_000;
const CODE = '自動カメラ呼び出し %b %s %b %b %b';
const ARGUMENTS = ['xR~s.7r8uJ`Gy$G+39K-', ']i~SLv(%iUF3##kN#Ior',
  'SrUnuL6Lw.G[T=ku;}@+', 'goG`x?1gjjka]-*yNpcW', 'f(9A_KodknBR#N-aF1ac'];
const COMMENTS = {HE:'カメラフィット', hU:'初EEW', 'M@':'地図表示変更', aTX:'津波情報',
  'a!|':'最大震度更新', 'a#.':'5秒ごと', 'c,Q':'地震情報表示', 'c/D':'津波観測', 'a~N':'タブ切り替え'};
const defaultClock = () => globalThis.performance?.now?.() ?? NaN;

const input = (block, name) => block?.inputs?.[name]?.block;
const field = (block, name) => block?.fields?.[name]?.value;
const sameArguments = value => {
  try {return JSON.stringify(JSON.parse(value)) === JSON.stringify(ARGUMENTS);} catch {return false;}
};

function receiverFor(runtime) {
  return runtime.targets?.find(target => target.isOriginal && target.getName?.() === '受信と検出');
}

// This is intentionally tied to the shipped 1.6.3 graph. A future native
// version or dynamically computed comment must fall back to normal native
// operation, rather than accidentally suppressing a new alert call site.
function compatible(receiver) {
  const blocks = receiver?.blocks;
  if (!blocks || typeof blocks.getBlock !== 'function' || !blocks._blocks) return false;
  const get = id => blocks.getBlock(id);
  const literal = (block, name) => {
    const value = get(input(block, name));
    return value?.opcode === 'text' ? field(value, 'TEXT') :
      ['math_number','math_integer','math_whole_number','math_positive_number'].includes(value?.opcode) ? field(value, 'NUM') : undefined;
  };
  const variable = (block, name, id) => {
    const reporter = get(input(block, name));
    return reporter?.opcode === 'data_variable' && reporter.fields?.VARIABLE?.id === id;
  };
  const equal = (id, valueId, expected) => {
    const block = get(id);
    return block?.opcode === 'operator_equals' && variable(block, 'OPERAND1', valueId) && String(literal(block, 'OPERAND2')) === expected;
  };
  const branch = get('TM'), and = get('TN'), modEquals = get('a#/'), modulo = get('c(~');
  const call = get('a#.'), definition = get('aK('), prototype = get('ac'), hat = get('c%S');
  if (branch?.opcode !== 'control_if' || branch.parent !== 'a#-' || branch.next !== null ||
    input(branch, 'CONDITION') !== 'TN' || input(branch, 'SUBSTACK') !== 'a#.' ||
    and?.opcode !== 'operator_and' || input(and, 'OPERAND1') !== 'a#/' || input(and, 'OPERAND2') !== 'c(}' ||
    modEquals?.opcode !== 'operator_equals' || input(modEquals, 'OPERAND1') !== 'c(~' || String(literal(modEquals, 'OPERAND2')) !== '0' ||
    modulo?.opcode !== 'operator_mod' || !variable(modulo, 'NUM1', 'gL0dQ0-W8^^TMo7TVk~L') || String(literal(modulo, 'NUM2')) !== '5' ||
    !equal('c(}', '3r2[u9%!:$J!~0,[!WA`', '1') || !equal('c)a', 'cOE)RT$1^[}M~v,_zl5i', '1') ||
    call?.opcode !== 'procedures_call' || call.parent !== 'TM' || call.next !== null ||
    call.mutation?.proccode !== CODE || !sameArguments(call.mutation.argumentids) ||
    input(call, ARGUMENTS[0]) !== 'c)a' || ARGUMENTS.slice(2).some(name => input(call, name)) ||
    definition?.opcode !== 'procedures_definition' || input(definition, 'custom_block') !== 'ac' ||
    prototype?.opcode !== 'procedures_prototype' || prototype.mutation?.proccode !== CODE ||
    !sameArguments(prototype.mutation.argumentids) ||
    hat?.opcode !== 'event_whenbroadcastreceived' || field(hat, 'BROADCAST_OPTION') !== 'スタート') return false;
  let id = 'a#.';
  const seen = new Set();
  while (id && !seen.has(id) && id !== 'c%S') {seen.add(id); id = get(id)?.parent;}
  if (id !== 'c%S') return false;
  const calls = Object.values(blocks._blocks).filter(block => block.opcode === 'procedures_call' && block.mutation?.proccode === CODE);
  return calls.length === Object.keys(COMMENTS).length && calls.every(block =>
    Object.hasOwn(COMMENTS, block.id) && sameArguments(block.mutation.argumentids) &&
    literal(block, ARGUMENTS[1]) === COMMENTS[block.id]);
}

function kindOf(fn) {
  if (typeof fn !== 'function') return null;
  const name = fn.constructor?.name;
  return name === 'GeneratorFunction' ? 'generator' : name === 'Function' ? 'sync' : null;
}

// Missing boolean inputs in the original call use Scratch's false/empty
// defaults. Anything else is passed through, especially manual/EEW/force flags.
function falseFlag(value) {return value === false || value === 0 || value === '' || value === '0' || value === 'false' || value === undefined;}

/** Start a non-renewable 3 s lease after a successful community pan.
 * canHold must recheck live priority and ownership; false/throw permanently
 * releases the lease. Unsupported/interpreted graphs return null unchanged.
 * No timers, source blocks, native state, permission or timestamp are changed.
 */
export function acquireCommunityMapLease(vm, options = {}) {
  try {return acquire(vm, options ?? {});} catch {return null;}
}

function acquire(vm, {canHold, now = defaultClock}) {
  const runtime = vm?.runtime;
  if (!runtime || typeof canHold !== 'function' || typeof now !== 'function') return null;
  const existing = leases.get(runtime);
  if (existing?.active) return existing;
  if (typeof runtime.on !== 'function' || typeof runtime.removeListener !== 'function') return null;
  const receiver = receiverFor(runtime), stage = runtime.getTargetForStage?.();
  try {if (!stage || !compatible(receiver)) return null;} catch {return null;}
  let start;
  try {start = now(); if (!Number.isFinite(start) || canHold() !== true) return null;} catch {return null;}
  const threads = () => runtime.threads?.filter(thread => thread.target === receiver && thread.topBlock === 'c%S') ?? [];
  const initial = threads();
  if (!initial.length || initial.some(thread => !thread.isCompiled || !thread.procedures ||
    !['Z','W'].some(prefix => kindOf(thread.procedures[prefix + CODE])))) return null;

  let ended = false, reason = null, lastTime = start;
  const entries = [], wrapped = new WeakMap();
  const stats = {skipped:0, passed:0};
  const expiresAt = start + LEASE_MS;
  const resetEvents = ['PROJECT_LOADED','PROJECT_STOP_ALL','PROJECT_START','STAGE_SIZE_CHANGED','PROJECT_CHANGED'];
  const reset = () => release('native-reset');

  function release(nextReason = 'cancelled') {
    if (ended) return;
    ended = true; reason = nextReason;
    try {runtime.removeListener('BEFORE_EXECUTE', before);} catch {}
    for (const event of resetEvents) {try {runtime.removeListener(event, reset);} catch {}}
    for (const entry of entries) {
      try {if (entry.procedures[entry.key] === entry.wrapper) entry.procedures[entry.key] = entry.original;} catch {}
    }
    if (leases.get(runtime) === lease) leases.delete(runtime);
  }

  function live() {
    if (ended) return false;
    try {
      const time = now();
      if (!Number.isFinite(time) || time < lastTime) {release('invalid-clock'); return false;}
      lastTime = time;
      if (time >= expiresAt) {release('expired'); return false;}
      if (runtime.getTargetForStage?.() !== stage || receiverFor(runtime) !== receiver || receiver.blocks !== blocks) {release('source-changed'); return false;}
      if (canHold() !== true) {release('priority'); return false;}
      return true;
    } catch {release('priority'); return false;}
  }

  function skip(args) {
    if (!live()) return false;
    if (args.length !== 5 || args[1] !== '5秒ごと' || !args.slice(2).every(falseFlag)) {
      release('native-request'); return false;
    }
    stats.skipped++;
    return true;
  }

  function hook(thread) {
    const procedures = thread.procedures;
    const known = wrapped.get(thread);
    if (known) {
      // Another hook or a recompilation owns the replacement. Do not overwrite
      // it with a stale closure, including when releasing this lease.
      if (known.some(entry => entry.procedures !== procedures || procedures[entry.key] !== entry.wrapper)) release('procedure-changed');
      return;
    }
    if (!thread.isCompiled || !procedures) {release('not-compiled'); return;}
    const added = [];
    for (const prefix of ['Z','W']) {
      const key = prefix + CODE, original = procedures[key], kind = kindOf(original);
      if (!kind) continue;
      const descriptor = Object.getOwnPropertyDescriptor(procedures, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.writable) {release('procedure-readonly'); return;}
      const wrapper = kind === 'generator' ? function* (...args) {
        if (skip(args)) return '';
        stats.passed++;
        return yield* Reflect.apply(original, this, args);
      } : function (...args) {
        if (skip(args)) return '';
        stats.passed++;
        return Reflect.apply(original, this, args);
      };
      const entry = {procedures, key, original, wrapper};
      entries.push(entry); added.push(entry); procedures[key] = wrapper;
    }
    if (!added.length) {release('not-compiled'); return;}
    wrapped.set(thread, added);
  }

  function before() {
    try {
      if (!live()) return;
      const current = threads();
      if (!current.length) {release('receiver-stopped'); return;}
      for (const thread of current) {hook(thread); if (ended) break;}
    } catch {release('unsupported');}
  }

  const blocks = receiver.blocks;
  const lease = {stats, get active() {return live();}, get reason() {return reason;}, get expiresAt() {return expiresAt;},
    release, dispose() {release('disposed');}};
  leases.set(runtime, lease);
  try {
    for (const thread of initial) {hook(thread); if (ended) break;}
    if (ended) return null;
    runtime.on('BEFORE_EXECUTE', before);
    for (const event of resetEvents) runtime.on(event, reset);
    return lease;
  } catch {release('unsupported'); return null;}
}

/** Inspection for local QA; acquiring remains exclusive to a successful pan. */
export const getCommunityMapLease = vm => leases.get(vm?.runtime) ?? null;
