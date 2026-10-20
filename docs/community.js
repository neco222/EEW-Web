import { CommunityStore } from './community-core.js';
import { CommunityFeed } from './community-feed.js';
import { CommunityPulses, formatPulseCount } from './community-pulses.js';
import { readView } from './viewer-bridge.js';
import { layoutReportBubbles } from './report-bubbles.js';
import { readMapObstacles } from './viewer-obstacles.js';

const number = new Intl.NumberFormat('ja-JP');
const clock = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const safeRead = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const safeWrite = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage may be disabled */ } };
const label = (text) => String(text ?? '').replaceAll('P2P地震情報', 'コミュニティ投稿').replaceAll('P2P', 'コミュニティ投稿');

export function startCommunity() {
  const demo = new URL(location.href).searchParams.get('communityDemo') === '1';
  const store = new CommunityStore();
  const pulses = new CommunityPulses();
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let state = store.snapshot();
  let status = { state: 'connecting', message: '接続しています' };
  let enabled = safeRead('eew-community-bursts', 'true') !== 'false';
  let demoPending = demo;
  let running = false;
  let disposed = false;
  let timer = null;
  let settleTimer = null;
  let settleUntil = 0;
  let lastFrameAt = -Infinity;
  let awaitingGeometry = false;
  let lastPrune = Date.now();
  let lastPanel = '';
  let lastLayoutKey = '';
  let lastObstacles = null;
  let placements = [];
  const nodes = new Map();

  const host = document.createElement('section');
  host.className = 'eew-community';
  host.setAttribute('aria-label', 'コミュニティ投稿');
  host.dataset.activeBubbles = '0';
  host.innerHTML = `<details class="eew-community-panel">
    <summary><span class="eew-community-dot" aria-hidden="true"></span><span class="eew-community-name">コミュニティ投稿</span><strong class="eew-community-total">0件</strong><span class="eew-community-window">（直近10分）</span><span class="eew-community-caret" aria-hidden="true">⌄</span></summary>
    <div class="eew-community-body">
      <p class="eew-community-period">コミュニティ投稿</p>
      <p class="eew-community-status" role="status">接続しています</p>
      <label class="eew-community-toggle"><input type="checkbox">新着を3秒表示</label>
      <div class="eew-community-regions" aria-label="地域別の投稿数"></div>
      <p class="eew-community-note"></p>
      <p class="eew-community-caption">投稿数はユーザーによる体感の報告です。震度や震源を示すものではありません。位置は地域の代表点です。</p>
      <div class="eew-community-links"><a href="https://www.p2pquake.net/" target="_blank" rel="noopener noreferrer">データ提供元</a><button type="button" class="eew-community-refresh">再取得</button></div>
      <button type="button" class="eew-community-demo" hidden>デモを再生</button>
    </div>
  </details><span class="eew-community-live" aria-live="polite"></span>`;
  const overlay = document.createElement('canvas');
  overlay.className = 'eew-community-map';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.hidden = true;
  const bubbles = document.createElement('div');
  bubbles.className = 'eew-community-bubbles';
  bubbles.setAttribute('aria-hidden', 'true');
  bubbles.hidden = true;
  document.body.append(overlay, bubbles, host);
  document.body.classList.add('eew-community-layout');
  const context = overlay.getContext('2d', { alpha: true });
  const details = host.querySelector('details');
  const totalNode = host.querySelector('.eew-community-total');
  const statusNode = host.querySelector('.eew-community-status');
  const regionsNode = host.querySelector('.eew-community-regions');
  const noteNode = host.querySelector('.eew-community-note');
  const checkbox = host.querySelector('input');
  const refreshButton = host.querySelector('.eew-community-refresh');
  const demoButton = host.querySelector('.eew-community-demo');
  checkbox.checked = enabled;

  function relayout() {
    // Packager resizes its canvas synchronously; Scratch's map/layout lists
    // catch up on subsequent VM frames. Never combine those two geometries.
    clearVisuals();
    settleUntil = performance.now() + 180;
    clearTimeout(settleTimer);
    globalThis.scaffolding?.relayout?.();
    lastLayoutKey = '';
    settleTimer = setTimeout(() => { settleTimer = null; wake(); }, 180);
  }

  function clearVisuals() {
    if (nodes.size || !overlay.hidden) context?.clearRect(0, 0, overlay.width, overlay.height);
    for (const node of nodes.values()) node.remove();
    nodes.clear();
    overlay.hidden = bubbles.hidden = true;
    host.dataset.activeBubbles = bubbles.dataset.activeBubbles = overlay.dataset.activeBubbles = '0';
    lastLayoutKey = '';
    lastObstacles = null;
    placements = [];
  }

  function updatePanel() {
    const content = JSON.stringify([state.total, state.areas.map((area) => [area.code, area.count]), state.unlocatedCount,
      state.latestAt, state.quality.notes, status.state, status.message]);
    if (content === lastPanel) return;
    lastPanel = content;
    totalNode.textContent = `${number.format(state.total)}件`;
    const text = demo ? 'デモ表示 · 実際の投稿ではありません' : label(status.message || '接続しています');
    statusNode.textContent = `${text}${state.latestAt ? ` · 最終投稿 ${clock.format(state.latestAt)}` : ''}`;
    host.dataset.connection = demo ? 'demo' : status.state;
    host.dataset.reportCount = String(state.total);
    host.title = demo ? 'コミュニティ投稿のデモです' : `直近10分 ${number.format(state.total)}件 · ${text}`;
    const fragment = document.createDocumentFragment();
    for (const area of [...state.areas].sort((a, b) => b.count - a.count || a.code - b.code)) {
      const row = document.createElement('div');
      row.className = 'eew-community-region';
      const name = document.createElement('span'); name.textContent = area.name;
      const count = document.createElement('strong'); count.textContent = `${number.format(area.count)}件`;
      row.append(name, count); fragment.append(row);
    }
    if (!state.areas.length) {
      const empty = document.createElement('p'); empty.className = 'eew-community-empty';
      empty.textContent = state.total ? '地域ごとの集計を待っています' : '直近10分の投稿はありません';
      fragment.append(empty);
    }
    regionsNode.replaceChildren(fragment);
    const notes = [];
    if (state.unlocatedCount) notes.push(`位置情報のない投稿 ${number.format(state.unlocatedCount)}件`);
    if (state.quality.notes.includes('window-clipped')) notes.push('古い累積集計を除き、受信できた個別投稿を表示しています');
    if (state.quality.notes.includes('overlapping-evaluations')) notes.push('期間が重なる古い集計を除外しています');
    noteNode.textContent = notes.join('。');
    host.querySelector('.eew-community-live').textContent = demo ? 'デモ表示中' : `直近10分のコミュニティ投稿 ${number.format(state.total)}件`;
  }

  function render() {
    awaitingGeometry = false;
    if (document.hidden || !enabled) { clearVisuals(); return; }
    if (performance.now() < settleUntil) { awaitingGeometry = true; clearVisuals(); return; }
    const view = readView();
    if (view && !view.settled) { awaitingGeometry = true; clearVisuals(); return; }
    const loading = document.getElementById('loading');
    const error = document.getElementById('error');
    const ready = view && (!loading || loading.hidden) && (!error || error.hidden) &&
      String(view.dialog ?? '') === '' && Number(view.tab) < 3 && view.viewport.width > 0 && view.viewport.height > 0;
    if (!ready) { clearVisuals(); return; }
    if (demoPending) {
      demoPending = false;
      pulses.clear();
      pulses.ingest(state, { areas: [] });
    }
    const posts = pulses.snapshot();
    if (!posts.length) { clearVisuals(); return; }
    const { canvasRect: rect, viewport, width, height } = view;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    for (const element of [overlay, bubbles]) {
      element.style.left = `${rect.left}px`; element.style.top = `${rect.top}px`;
      element.style.width = `${width}px`; element.style.height = `${height}px`;
    }
    if (overlay.width !== Math.round(width * ratio) || overlay.height !== Math.round(height * ratio)) {
      overlay.width = Math.round(width * ratio); overlay.height = Math.round(height * ratio); lastLayoutKey = '';
    }
    const obstacles = readMapObstacles(globalThis.vm, view);
    const layoutKey = JSON.stringify([width, height, view.camera, view.layout, viewport, view.tab,
      posts.map((post) => [post.key, post.count, post.expiresAt]), ratio]);
    if (layoutKey !== lastLayoutKey || obstacles !== lastObstacles) {
      lastLayoutKey = layoutKey;
      lastObstacles = obstacles;
      placements = layoutReportBubbles(posts, view, obstacles);
      context?.setTransform(ratio, 0, 0, ratio, 0, 0);
      context?.clearRect(0, 0, width, height);
      context?.save();
      if (context) {
        context.beginPath(); context.rect(viewport.left, viewport.top, viewport.width, viewport.height); context.clip();
        context.lineWidth = 1; context.strokeStyle = 'rgba(178,232,246,.6)';
      }
      const retained = new Set();
      for (const placement of placements) {
        const key = String(placement.key);
        retained.add(key);
        let node = nodes.get(key);
        if (!node) {
          node = document.createElement('div'); node.className = 'eew-community-bubble';
          node.innerHTML = '<span></span><strong></strong>';
          nodes.set(key, node); bubbles.append(node);
        }
        node.style.left = `${placement.x}px`; node.style.top = `${placement.y}px`;
        node.style.width = `${placement.width}px`; node.style.height = `${placement.height}px`;
        node.querySelector('span').textContent = placement.name;
        node.querySelector('strong').textContent = formatPulseCount(placement.count);
        node.dataset.reportCode = String(placement.code ?? placement.codes?.join(',') ?? '');
        node.dataset.reportCount = String(placement.count);
        node.dataset.expiresAt = String(placement.expiresAt);
        node.title = `${placement.name} · コミュニティ投稿 +${number.format(placement.count)}件`;
        if (context && placement.anchor) {
          const edgeX = Math.max(placement.x, Math.min(placement.x + placement.width, placement.anchor.x));
          const edgeY = Math.max(placement.y, Math.min(placement.y + placement.height, placement.anchor.y));
          context.beginPath(); context.moveTo(placement.anchor.x, placement.anchor.y); context.lineTo(edgeX, edgeY); context.stroke();
        }
      }
      for (const [key, node] of nodes) if (!retained.has(key)) { node.remove(); nodes.delete(key); }
      // Keep even the thin leader lines away from native intensity labels.
      // Bubble boxes are already collision-tested by the layout helper.
      if (context) for (const obstacle of obstacles) {
        context.clearRect(obstacle.left - 1.5, obstacle.top - 1.5, obstacle.width + 3, obstacle.height + 3);
      }
      context?.restore();
      overlay.hidden = bubbles.hidden = placements.length === 0;
      host.dataset.activeBubbles = bubbles.dataset.activeBubbles = overlay.dataset.activeBubbles = String(placements.length);
    }
    const now = performance.now();
    for (const placement of placements) {
      const node = nodes.get(String(placement.key));
      if (node) node.style.opacity = String(reducedMotion ? 1 : Math.max(0, Math.min(1, (placement.expiresAt - now) / 400)));
    }
  }

  function tick() {
    timer = null;
    if (!running || document.hidden) { clearVisuals(); return; }
    if (!demo && Date.now() - lastPrune >= 5000) { lastPrune = Date.now(); state = store.snapshot(); updatePanel(); }
    lastFrameAt = performance.now();
    render();
    const active = placements.length || awaitingGeometry && pulses.snapshot().length;
    timer = setTimeout(tick, enabled && active ? 50 : 500);
  }
  function wake() {
    if (!running || disposed) return;
    clearTimeout(timer);
    // Coalesce bursty message/resize callbacks as well as the regular timer.
    timer = setTimeout(tick, Math.max(0, 50 - (performance.now() - lastFrameAt)));
  }
  function start() {
    if (running || disposed) return;
    running = true; relayout(); feed?.start(); wake();
  }
  function pause() {
    running = false; clearTimeout(timer); timer = null;
    clearTimeout(settleTimer); settleTimer = null;
    feed?.stop(); clearVisuals();
  }
  const feed = demo ? null : new CommunityFeed({
    store,
    onChange: (next) => { state = next; updatePanel(); wake(); },
    onStatus: (next) => { status = next; updatePanel(); },
    onLive: (next, detail) => { if (enabled) pulses.ingestLive(next, detail); wake(); },
  });
  checkbox.addEventListener('change', () => {
    enabled = checkbox.checked; safeWrite('eew-community-bursts', String(enabled));
    if (!enabled) pulses.clear();
    wake();
  });
  refreshButton.addEventListener('click', () => feed?.refresh());
  details.addEventListener('toggle', () => {
    document.body.classList.toggle('eew-community-details', details.open); relayout(); wake();
  });
  const visibility = () => { if (document.hidden) { clearTimeout(timer); timer = null; clearVisuals(); } else wake(); };
  const resize = () => { relayout(); wake(); };
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('eew-layout-change', resize);
  addEventListener('resize', resize);
  addEventListener('pagehide', pause);
  addEventListener('pageshow', start);
  if (demo) {
    const demoStore = new CommunityStore();
    const time = new Date().toISOString();
    demoStore.ingest({ code: 9611, id: 'community-demo', time, started_at: time, updated_at: time,
      count: 37, confidence: 0.98, area_confidences: { 10: { count: 21 }, 60: { count: 9 }, 70: { count: 7 } } });
    state = demoStore.snapshot();
    host.classList.add('is-demo');
    host.querySelector('.eew-community-name').textContent = 'コミュニティ投稿 · デモ';
    demoButton.hidden = false;
    refreshButton.disabled = true;
    demoButton.addEventListener('click', () => { demoPending = true; pulses.clear(); wake(); });
  }
  updatePanel(); start();
  return {
    stop() {
      if (disposed) return;
      disposed = true; pause();
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('eew-layout-change', resize);
      removeEventListener('resize', resize); removeEventListener('pagehide', pause); removeEventListener('pageshow', start);
      host.remove(); overlay.remove(); bubbles.remove();
      document.body.classList.remove('eew-community-layout', 'eew-community-details');
      globalThis.scaffolding?.relayout?.();
    },
  };
}
