import { CommunityStore } from './community-core.js';
import { CommunityFeed } from './community-feed.js';
import { CommunityLog } from './community-log.js';
import { startCommunityLogView } from './community-log-view.js';
import { startCommunityMapFollow } from './community-map.js';
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
  const log = new CommunityLog();
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let state = store.snapshot();
  let status = { state: 'connecting', message: '接続しています' };
  let enabled = safeRead('eew-community-bursts', 'true') !== 'false';
  let followEnabled = safeRead('eew-community-focus', 'true') !== 'false';
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
  let logTimer = null;
  let lastLog = '';
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
      <label class="eew-community-toggle"><input type="checkbox" class="eew-community-follow">投稿地域へ地図移動</label>
      <p class="eew-community-follow-state" role="status">新着の個別投稿を待っています</p>
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
  const followCheckbox = host.querySelector('.eew-community-follow');
  const followStateNode = host.querySelector('.eew-community-follow-state');
  const refreshButton = host.querySelector('.eew-community-refresh');
  const demoButton = host.querySelector('.eew-community-demo');
  checkbox.checked = enabled;
  followCheckbox.checked = followEnabled;
  followStateNode.textContent = followEnabled?'新着の個別投稿を待っています':'投稿による地図移動はOFFです';
  followCheckbox.title = '地震情報の自動表示や手動の地図操作を優先します';
  const mapFollow = startCommunityMapFollow({enabled:followEnabled, onState(next) {
    host.dataset.focusState = next.state;
    host.dataset.focusReason = next.reason ?? '';
    host.dataset.focusCheckedAt = String(next.at);
    const waiting = '元の地図の自動調整後に移動します';
    const messages = {idle:'新着の個別投稿を待っています',disabled:'投稿による地図移動はOFFです',paused:'投稿による地図移動を一時停止しています',
      pending:'新着の投稿地域を確認しています',waiting,moving:'投稿地域へ地図を移動中です',arrived:'投稿地域を表示しました'};
    const reasons = {'manual-hold':'地図の手動操作を優先しています','manual-motion':'地図の手動操作を優先しています',
      'eew-active':'緊急地震速報の地図を優先しています','tsunami-active':'津波情報の地図を優先しています',
      'native-information':'新しい地震情報の地図を優先しています','shaking':'観測された揺れの地図を優先しています',
      'native-auto-disabled':'元の「自動カメラ」がOFFです','history':'地震履歴の表示を優先しています',
      'replay':'リプレイの表示を優先しています','dialog':'設定・案内画面の表示を優先しています',
      'not-map':'この画面では地図を移動しません','native-replaced':'元の地震情報の地図に切り替わりました',
      'native-pending':'元の地図の自動調整を優先しました','native-auto-recent':'元の地図の自動調整を優先しました',
      'native-moving':'元の地図の自動調整を優先しました','layout-unsettled':'画面の切り替えを優先しました',
      'old-source':'古い投稿のため地図を移動しません','unlocated':'地域を特定できない投稿です',
      'expired':'投稿の受信から時間が経ったため移動しません','non-live':'履歴の投稿では地図を移動しません',
      'disabled':'投稿による地図移動はOFFです',
      'movement-timeout':'地図の自動調整を優先しました'};
    followStateNode.textContent = messages[next.state] ?? reasons[next.reason] ?? '新着の個別投稿を待っています';
    followStateNode.dataset.state = next.state;
    document.dispatchEvent(new CustomEvent('eew-community-map-state',{detail:{...next,message:followStateNode.textContent}}));
  }, onMove(next) {
    host.dataset.focusAreas = next.areas.map(area => area.code).join(',');
    host.dataset.focusedAt = String(Date.now());
  }});

  function publishLog(force = false) {
    if (disposed) return;
    const snapshot = log.snapshot();
    const detail = {entries:snapshot.entries, connection:demo?'demo':status.state, upstreamState:status.upstreamState??null,
      message:demo?'デモ表示・実際の投稿ではありません':label(status.message), demo};
    const key = JSON.stringify(detail);
    if (!force && key === lastLog) return;
    lastLog = key;
    document.dispatchEvent(new CustomEvent('eew-community-log', {detail}));
  }
  function queueLog() {
    // Coalesce a storm of posts without adding an animation/render loop.
    if (logTimer !== null || !running || document.hidden || disposed) return;
    logTimer = setTimeout(() => {logTimer = null;publishLog();}, 80);
  }
  const requestLog = () => publishLog(true);
  document.addEventListener('eew-community-log-request', requestLog);
  const logView = startCommunityLogView({detailsBody:host.querySelector('.eew-community-body')});
  const logActivity = event => logView.setActive(event.detail?.active === true);
  document.addEventListener('eew-community-log-activity', logActivity);
  document.dispatchEvent(new Event('eew-community-log-activity-request'));

  function relayout() {
    if (disposed) return;
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
    // Read-only transport diagnostics remain current even when visible content
    // is unchanged. Do not put frames, report identifiers, or debug text in UI.
    for (const key of ['openedAt', 'lastFrameAt', 'lastLiveAt', 'lastHistoryAt', 'realtimeRecoveryCount', 'liveRejectedCount']) {
      host.dataset[key] = status[key] == null ? '' : String(status[key]);
    }
    host.dataset.lastRejectedReason = status.lastRejectedReason ?? '';
    const content = JSON.stringify([state.total, state.areas.map((area) => [area.code, area.count]), state.unlocatedCount,
      state.latestAt, state.quality.notes, status.state, status.message]);
    if (content === lastPanel) return;
    lastPanel = content;
    totalNode.textContent = `${number.format(state.total)}件`;
    const text = demo ? 'デモ表示 · 実際の投稿ではありません' : label(status.message || '接続しています');
    statusNode.textContent = `${text}${state.latestAt ? ` · 最終投稿 ${clock.format(state.latestAt)}` : ''}`;
    host.dataset.connection = demo ? 'demo' : status.state;
    host.dataset.reportCount = String(state.total);
    host.setAttribute('aria-description', demo ? 'コミュニティ投稿のデモです' : `直近10分 ${number.format(state.total)}件 · ${text}`);
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
    if (!demo && Date.now() - lastPrune >= 5000) { lastPrune = Date.now(); state = store.snapshot(); updatePanel(); queueLog(); }
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
    running = true; mapFollow.resume();relayout(); feed?.start(); wake();
  }
  function pause() {
    running = false; clearTimeout(timer); timer = null;
    clearTimeout(settleTimer); settleTimer = null;
    clearTimeout(logTimer); logTimer = null;
    feed?.stop(); clearVisuals();
    mapFollow.pause();
  }
  const feed = demo ? null : new CommunityFeed({
    store,
    onChange: (next) => { state = next; updatePanel(); wake(); },
    onStatus: (next) => { status = next; updatePanel(); queueLog(); },
    onLive: (next, detail) => { log.ingestLive(next, detail);queueLog();
      // Feed acceptance defines a new post; the bounded display log may be full.
      if (detail.message?.code === 561) {
        // Queue video first. Its optional shelf resize settles before the map
        // submits a geographic target and starts its brief background-fit hold.
        document.dispatchEvent(new CustomEvent('eew-community-report', {detail:{message:detail.message,receivedAt:detail.receivedAt}}));
        const decision = mapFollow.ingestLive(next, detail);
        host.dataset.focusAccepted = String(decision.accepted);
        host.dataset.focusIntakeReason = decision.reason;
        host.dataset.focusLastReportAt = String(detail.receivedAt);
      }
      if (enabled) pulses.ingestLive(next, detail); wake(); },
    onHistory: (messages) => {log.ingestHistory(messages);queueLog();},
  });
  checkbox.addEventListener('change', () => {
    enabled = checkbox.checked; safeWrite('eew-community-bursts', String(enabled));
    if (!enabled) pulses.clear();
    wake();
  });
  followCheckbox.addEventListener('change', () => {
    followEnabled = followCheckbox.checked;safeWrite('eew-community-focus', String(followEnabled));
    mapFollow.setEnabled(followEnabled);
  });
  refreshButton.addEventListener('click', () => feed?.refresh());
  details.addEventListener('toggle', () => {
    document.body.classList.toggle('eew-community-details', details.open);
    // An explicit drawer action keeps its normal map priority even when the
    // desktop log already reserves the same width (no geometry change).
    document.dispatchEvent(new CustomEvent('eew-layout-change',{detail:{source:'community-details'}}));
  });
  const visibility = () => { if (document.hidden) { clearTimeout(timer); timer = null;clearTimeout(logTimer);logTimer = null; clearVisuals(); } else {wake();queueLog();} };
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
  updatePanel(); start();queueLog();
  return {
    stop() {
      if (disposed) return;
      disposed = true; pause();
      logView.stop();
      document.removeEventListener('eew-community-log-activity', logActivity);
      mapFollow.stop();
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('eew-layout-change', resize);
      document.removeEventListener('eew-community-log-request', requestLog);
      removeEventListener('resize', resize); removeEventListener('pagehide', pause); removeEventListener('pageshow', start);
      host.remove(); overlay.remove(); bubbles.remove();
      document.body.classList.remove('eew-community-layout', 'eew-community-details');
      globalThis.scaffolding?.relayout?.();
    },
  };
}
