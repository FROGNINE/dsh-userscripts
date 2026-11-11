// ==UserScript==
// @name         B站 · 自动网页全屏 / 最高画质 / 视频二倍速 / 屏蔽小橙车弹窗
// @namespace    https://github.com/frognine/dsh-userscripts
// @version      1.9.0
// @description  直播间：自动网页全屏 + 最高画质 + 清除小橙车弹窗；视频页：自动网页全屏 + 二倍速。支持站内切换直播间/切换视频。
// @author       frognine
// @license      MIT
// @homepageURL  https://github.com/FROGNINE/dsh-userscripts
// @supportURL   https://github.com/FROGNINE/dsh-userscripts/issues
// @downloadURL  https://update.greasyfork.org/scripts/604933/script.user.js
// @updateURL    https://update.greasyfork.org/scripts/604933/script.meta.js
// @match        *://live.bilibili.com/*
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/list/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://www.bilibili.com/medialist/play/*
// @match        *://www.bilibili.com/festival/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 两种页面，两套播放器：
 *
 * A) 直播间 live.bilibili.com（bilibili-live-player，Svelte 控制条）
 *  - 网页全屏：播放器给 <body> 加 class `player-full-win`；控制条按钮文案「网页模式」，
 *    挂在 #web-player-controller-wrap-el 内。
 *  - 画质：window.livePlayer.getPlayerInfo() 给出 qualityCandidates 与当前 quality，
 *    用 switchQuality 切换（实测这版对外 API 静默无效，所以主力是「悬停唤出面板再点档位」）。
 *  - 小黄车提示：按文本精确匹配并连同底框隐藏。
 *
 * B) 视频页 www.bilibili.com/video/…（bpx 播放器）
 *  - 网页全屏：点控制条的 `.bpx-player-ctrl-web`，进入后 <body> 会带 `webscreen-fix`。
 *  - 二倍速：window.player.setPlaybackRate(2)；兜底直接改 <video>.playbackRate。
 *  - 换分P/换集时视频源变化，会重新应用一次（见 trackVideoChange）。
 */

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  const CFG = {
    version: '1.9.0',
    webFullscreen: true,     // 自动网页全屏（直播 / 视频都生效）
    maxQuality: true,        // 直播间：自动最高画质
    killCartTip: true,       // 直播间：清除「网页端暂不支持购物小橙车/小黄车」提示
    // 视频页（www.bilibili.com/video 等）
    videoWebFullscreen: true, // 自动「网页全屏」
    videoPlaybackRate: 2,     // 自动倍速，设 0 表示关闭
    respectUserExit: true,   // 用户手动退出网页全屏后，本页面不再强行进入
    pollInterval: 2500,      // 播放器就绪轮询
    maxRunsPerRoom: 8,       // 每个页面最多尝试轮次
    apiAttempts: 3,          // 播放器 API 最多调用几次
    clickAttempts: 4,        // 「网页模式」按钮最多点几次
  };

  const TAG = '[BiliLive-Helper]';
  const log = (...args) => {
    try { console.log(TAG, ...args); } catch (_) { /* 忽略 */ }
  };

  /* ============================ 通用工具 ============================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 直播播放器是单例，挂在 window 上；不同版本暴露的名字不同，逐个探测
  function getPlayer() {
    const cands = [
      window.Player,
      window.__INTERACTIVE_PLAYER__,
      window.EmbedPlayer,
      window.livePlayer,
    ];
    for (const c of cands) {
      if (c && typeof c.getPlayerInfo === 'function') return c;
    }
    return null;
  }

  async function waitFor(fn, timeout, interval = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let v = null;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  /* ======================= 页面类型判定 ======================= */
  const VIDEO_PATH_RE = /^\/(video|list|bangumi\/play|medialist\/play|festival)\//;
  const isLivePage = () => /(^|\.)live\.bilibili\.com$/.test(location.hostname);
  const isVideoPage = () => !isLivePage() && /(^|\.)bilibili\.com$/.test(location.hostname) &&
    VIDEO_PATH_RE.test(location.pathname);

  /* ============== 视频页（bpx 播放器）辅助 ============== */
  function videoElement() {
    return document.querySelector('#bilibili-player video') ||
      document.querySelector('.bpx-player-container video') ||
      document.querySelector('video');
  }

  function videoApi() {
    const p = window.player;
    return p && typeof p.setPlaybackRate === 'function' ? p : null;
  }

  // 视频页「网页全屏」的标记：<body> 会加上 webscreen-fix
  const isVideoFullscreen = () => !!document.body && document.body.classList.contains('webscreen-fix');

  function findVideoFullscreenBtn() {
    return document.querySelector('.bpx-player-ctrl-web') ||
      document.querySelector('.bpx-player-ctrl-wide');
  }

  async function enterVideoFullscreen() {
    if (isVideoFullscreen()) return true;
    for (let i = 0; i < 8; i++) {
      const btn = findVideoFullscreenBtn();
      if (btn) {
        try { btn.click(); } catch (e) { log('点击视频「网页全屏」失败', e); }
        await sleep(400);
        if (isVideoFullscreen()) return true;
      } else {
        // 控制条还没渲染出来：先把鼠标「移」到播放器上唤醒它
        const host = document.querySelector('#bilibili-player') ||
          document.querySelector('.bpx-player-container');
        if (host) hoverEnter(host);
        await sleep(400);
      }
    }
    return isVideoFullscreen();
  }

  async function applyVideoRate() {
    const want = Number(CFG.videoPlaybackRate) || 0;
    if (!(want > 0)) return true;
    for (let i = 0; i < 10; i++) {
      const v = videoElement();
      const api = videoApi();
      if (!v && !api) { await sleep(400); continue; }
      if (v && Math.abs(v.playbackRate - want) < 0.01) return true;
      try { if (api) api.setPlaybackRate(want); } catch (_) { /* 忽略 */ }
      if (v) { try { v.playbackRate = want; } catch (_) { /* 忽略 */ } }
      await sleep(350);
      const after = videoElement();
      if (after && Math.abs(after.playbackRate - want) < 0.01) {
        log(`视频倍速已设为 ${want}x`);
        return true;
      }
    }
    log(`视频倍速没设置成功（目标 ${want}x）`);
    return false;
  }

  /* ============================ 网页全屏 ============================ */
  function isWebFullscreen() {
    if (isVideoFullscreen()) return true;
    const b = document.body;
    const h = document.documentElement;
    return !!((b && b.classList.contains('player-full-win')) ||
      (h && h.classList.contains('player-full-win')));
  }

  // 找控制条里的「网页模式」按钮；精确匹配文案，避免误点「退出网页模式」
  function findWebFullscreenButton() {
    const wrap = document.getElementById('web-player-controller-wrap-el');
    const scope = wrap || document;
    let fallback = null;
    for (const el of scope.querySelectorAll('div, span, a, button, i')) {
      if ((el.textContent || '').trim() !== '网页模式') continue;
      const holder = el.closest('div');
      const icon = (holder && holder.querySelector('span.icon')) || el.querySelector('span.icon');
      const target = icon || el;
      if (!target) continue;
      // 优先可见的按钮；控制条隐藏时也允许用兜底目标（.click() 仍会触发事件）
      if (target.offsetParent !== null) return target;
      if (!fallback) fallback = target;
    }
    return fallback;
  }

  async function ensureWebFullscreen() {
    if (!CFG.webFullscreen) return false;
    if (isVideoPage()) {
      if (isVideoFullscreen()) return true;
      if (state.userOptedOut) return false;
      return enterVideoFullscreen();
    }
    if (isWebFullscreen()) return true;
    if (state.userOptedOut) return false;

    let apiCalls = 0;
    let clicks = 0;
    let idleRounds = 0; // 既没有播放器 API 也没有按钮，连续这么多轮就放弃
    for (let i = 0; i < 40; i++) {
      if (isWebFullscreen()) return true;
      let didSomething = false;

      const p = getPlayer();
      if (apiCalls < CFG.apiAttempts && p && typeof p.setFullscreenStatus === 'function') {
        apiCalls += 1;
        didSomething = true;
        log(`调用 Player.setFullscreenStatus(1)（第 ${apiCalls} 次）`);
        try { p.setFullscreenStatus(1); } catch (e) { /* 部分版本会抛错，忽略 */ }
        await sleep(200);
        if (isWebFullscreen()) return true;
      }

      if (clicks < CFG.clickAttempts) {
        const btn = findWebFullscreenButton();
        if (btn) {
          clicks += 1;
          didSomething = true;
          try { btn.click(); } catch (e) { log('点击「网页模式」失败', e); }
          await sleep(250);
          if (isWebFullscreen()) return true;
        }
      }

      if (!didSomething) {
        idleRounds += 1;
        if (idleRounds >= 6) { log('网页全屏：既没等到播放器 API，也没找到「网页模式」按钮，放弃本轮'); break; }
      } else {
        idleRounds = 0;
      }
      if (apiCalls >= CFG.apiAttempts && clicks >= CFG.clickAttempts) break;
      await sleep(500);
    }
    return isWebFullscreen();
  }

  // 用户自己退出网页全屏时不要一直抢回来
  let exitWatcher = null;
  function armUserExitWatch() {
    if (!CFG.respectUserExit || exitWatcher) return;
    let offCount = 0;
    exitWatcher = setInterval(() => {
      if (state.running) return;
      if (isWebFullscreen()) { offCount = 0; return; }
      offCount += 1;
      if (offCount < 2) return; // 连续两次都关着，才认为是用户主动退出
      state.userOptedOut = true;
      clearInterval(exitWatcher);
      exitWatcher = null;
      log('检测到手动退出网页全屏，本直播间不再自动进入（切房后恢复）');
    }, 1200);
  }

  /* ============================ 最高画质 ============================ */
  // 直播播放器的画质表里「自动」是一条 code = -1 的假档位（播放器 bundle 里 label 就叫「自动」），
  // 面板点错就会永远停在自动，所以下面所有选择都显式排除它，并且切完要回读确认。
  const AUTO_RE = /自动|^auto$/i;

  function isAutoLabel(text) {
    const t = (text || '').trim();
    return !t || AUTO_RE.test(t);
  }

  // 面板文案 → 优先级（数字越大越高）
  const LABEL_RANK = [
    [/原画\s*(PRO|pro)|原画pro|杜比|HDR/i, 100],
    [/原画/, 90],
    [/蓝光/, 80],
    [/超清/, 70],
    [/高清/, 60],
    [/流畅/, 50],
  ];

  // 面板里混着非画质项（实测有一条「画质增强」），不能当成档位点
  const NOT_QUALITY_RE = /增强|设置|开关|音轨|字幕|反馈|更多|帮助|记录/;

  function rankOfLabel(text) {
    const t = (text || '').trim();
    if (isAutoLabel(t)) return -1;
    if (NOT_QUALITY_RE.test(t)) return -1;
    for (const [re, rank] of LABEL_RANK) if (re.test(t)) return rank;
    return 40;
  }

  let apiQualityDead = false; // 对外 switchQuality 静默无效时置位，避免每轮白等 9 秒

  function qnOf(c) {
    if (c == null) return NaN;
    if (typeof c === 'number') return c;
    if (typeof c === 'string' && /^-?\d+$/.test(c)) return Number(c);
    if (typeof c === 'object') {
      const v = c.qn ?? c.code ?? c.quality ?? c.value ?? c.id;
      if (v && typeof v === 'object') return Number(v.quality);
      return Number(v);
    }
    return NaN;
  }

  function readInfo() {
    const p = getPlayer();
    if (!p) return null;
    try { return p.getPlayerInfo() || null; } catch (e) { log('getPlayerInfo() 异常', e); return null; }
  }

  function curQn(info) {
    const n = Number(info ? (info.quality ?? info.currentQuality ?? info.qn) : NaN);
    return Number.isFinite(n) ? n : NaN;
  }

  async function tryApiQuality() {
    const p = getPlayer();
    if (!p) return false;
    const info = readInfo();
    if (!info) return false;

    const list = info.qualityCandidates || info.qualityList || [];
    const cands = (Array.isArray(list) ? list : [])
      .map((c) => ({ qn: qnOf(c), label: (c && (c.desc || c.label)) || '' }))
      .filter((c) => Number.isFinite(c.qn) && c.qn > 0); // 丢掉 -1 的「自动」
    if (!cands.length) {
      log('画质候选列表为空：', JSON.stringify(list).slice(0, 300));
      return false;
    }

    const max = Math.max(...cands.map((c) => c.qn));
    const cur = curQn(info);
    log(`画质：当前=${JSON.stringify(info.quality)}　候选=${cands.map((c) => `${c.label || '?'}:${c.qn}`).join(' / ')}　目标=${max}`);
    if (Number.isFinite(cur) && cur === max) return true;

    const fn = p.switchQualitySeamless || p.switchQuality || p.setQuality;
    if (typeof fn !== 'function') { log('播放器没有 switchQuality 方法'); return false; }

    // 只切一次，然后轮询等它生效：B 站换码流要重新拉流，通常要好几秒
    try {
      fn.call(p, max);
      log(`调用 switchQuality(${max})`);
    } catch (e) {
      log('switchQuality 抛错', e);
      return false;
    }

    const got = await waitFor(() => {
      const q = curQn(readInfo());
      return Number.isFinite(q) && q === max ? q : null;
    }, 9000, 500);
    if (got != null) { log(`画质已确认切到 ${max}`); return true; }
    log(`等了 9 秒仍未切到 ${max}，当前 ${JSON.stringify(curQn(readInfo()))}`);
    return false;
  }

  // ---- 画质面板兜底（模拟人手点击）----
  // 实测：网页全屏后控制条里的画质部件可能根本没挂载，必须先让控制条显示出来
  const QUALITY_LABEL_RE = /(原画|蓝光|超清|高清|流畅|杜比|4K|自动)/;

  function playerContainer() {
    return document.querySelector('#live-player') ||
      document.querySelector('.web-player') ||
      document.querySelector('[class*="player-container"]') ||
      (document.getElementById('web-player-controller-wrap-el') || {}).parentElement ||
      null;
  }

  // 把鼠标「移」到播放器上，控制条才会出现
  function pokePlayer() {
    const el = playerContainer();
    if (!el) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    const opts = {
      bubbles: true, cancelable: true,
      clientX: r.left + Math.min(r.width / 2, 400),
      clientY: r.top + Math.min(r.height / 2, 300),
    };
    for (const type of ['mouseenter', 'mouseover', 'mousemove', 'pointermove', 'pointerenter']) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (_) { /* 忽略 */ }
    }
    return true;
  }

  const ctrlScope = () => document.getElementById('web-player-controller-wrap-el') || null;

  // 找「当前画质」按钮：先按已知类名，再按文案（控制条上显示「自动 / 原画 / 蓝光…」的那个）
  function findQualityTrigger() {
    const scope = ctrlScope() || playerContainer();
    if (!scope) return null;
    const sels = ['[class*="quality-wrap"]', '[class*="qualityWrap"]', '[class*="quality"]', '[class*="clarity"]'];
    for (const sel of sels) {
      const el = scope.querySelector(sel);
      if (el) {
        log(`画质按钮命中选择器 ${sel}（class=${el.className}）`);
        return el.querySelector('.text') || el.querySelector('.selected-qn') || el;
      }
    }
    // 文案兜底：只扫叶子节点（对大树调 textContent 很贵，这里直接读 nodeValue）
    let n = 0;
    for (const el of scope.querySelectorAll('div, span, i')) {
      if (++n > 4000) break;
      if (el.childElementCount !== 0) continue;
      const t = ((el.firstChild && el.firstChild.nodeValue) || '').trim();
      if (!t || t.length > 12 || !QUALITY_LABEL_RE.test(t)) continue;
      if (el.closest('.quality-wrap .panel') || el.closest('.quality-container')) continue;
      log(`画质按钮按文案命中：「${t}」class=${el.className}`);
      return el;
    }
    return null;
  }

  // 叶子取文案：嵌套节点才回退到 textContent
  function leafText(el) {
    if (el.childElementCount === 0) return ((el.firstChild && el.firstChild.nodeValue) || '').trim();
    return (el.textContent || '').trim();
  }

  // 面板项：实测这两种结构（新版 .list-it / 旧版 .quality-select），再按最内层文案兜底
  function findQualityItems(root) {
    const scope = root;
    if (!scope) return [];
    const direct = [...scope.querySelectorAll('.list-it, .quality-select')];
    if (direct.length) return direct;
    const labels = ['原画', '蓝光', '超清', '高清', '流畅', '杜比', '4K'];
    const out = [];
    let n = 0;
    for (const el of scope.querySelectorAll('div, span, li, p, a, button')) {
      if (++n > 4000) break;
      if (el.childElementCount > 3) continue;
      const t = leafText(el);
      if (!t || t.length > 28 || !labels.some((l) => t.includes(l))) continue;
      out.push(el);
    }
    // 只保留最内层，避免把整个面板当成一个「档位」
    return out.filter((el) => !out.some((o) => o !== el && el.contains(o)));
  }

  // 悬停事件：面板是 hover 弹出的，mouseenter 是关键（实测只发 pointerenter 不生效）
  function hoverEnter(el) {
    if (!el) return;
    let r = { left: 0, top: 0, width: 0, height: 0 };
    try { r = el.getBoundingClientRect(); } catch (_) { /* 忽略 */ }
    const base = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    for (const type of ['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove', 'pointermove']) {
      const isPointer = type.startsWith('pointer');
      try {
        el.dispatchEvent(isPointer ? new PointerEvent(type, base) : new MouseEvent(type, base));
      } catch (_) {
        try { el.dispatchEvent(new MouseEvent(type, base)); } catch (_) { /* 忽略 */ }
      }
    }
  }

  function hoverLeave(el) {
    if (!el) return;
    try { el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, view: window })); } catch (_) { /* 忽略 */ }
  }

  // 面板是 hover 出来的：把「悬停」撤掉才会收起。收不干净会一直挂在画面上（用户感受就是卡住）
  // 实测：mouseleave(不冒泡) 才有效；且组件重渲染是异步的，所以隔一会儿再补一次
  function closeQualityPanel() {
    const dispatch = () => {
      const w = document.querySelector('.quality-wrap');
      if (!w) return;
      const fire = (target, type, bubbles) => {
        if (!target) return;
        try { target.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true, view: window })); } catch (_) { /* 忽略 */ }
      };
      fire(w, 'mouseout', true);
      fire(w, 'mouseleave', false);
      try { w.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, view: window })); } catch (_) { /* 忽略 */ }
      fire(ctrlScope(), 'mouseleave', false);
      fire(playerContainer(), 'mouseleave', false);
    };
    dispatch();
    setTimeout(() => {
      if (!qualityPanel()) return;
      dispatch(); // 第二遍：等组件重渲染完
      setTimeout(() => {
        const p = qualityPanel();
        if (!p) return;
        // 组件把面板重新挂回来了（悬停状态没清掉）——直接视觉上藏掉，保证不会挂在画面上
        try { p.style.setProperty('display', 'none', 'important'); } catch (_) { /* 忽略 */ }
        log('画质面板 hover 关闭未生效，已强制隐藏');
      }, 900);
    }, 350);
  }

  // 点击事件：有些实现只认 pointerdown/pointerup 序列
  function fireClick(el) {
    if (!el) return;
    let r = { left: 0, top: 0, width: 0, height: 0 };
    try { r = el.getBoundingClientRect(); } catch (_) { /* 忽略 */ }
    const base = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const isPointer = type.startsWith('pointer');
      try {
        el.dispatchEvent(isPointer ? new PointerEvent(type, base) : new MouseEvent(type, base));
      } catch (_) {
        try { el.dispatchEvent(new MouseEvent(type, base)); } catch (_) { /* 忽略 */ }
      }
    }
  }

  // 面板是否已展开：新版在 .quality-wrap 里挂 .panel，旧版是 .quality-container
  const qualityPanel = () => document.querySelector('.quality-wrap .panel') ||
    document.querySelector('.quality-container') || null;

  // 打开画质面板：唤醒控制条 → 悬停画质按钮（面板是 hover 出来的）→ 不行再点一下
  async function openQualityPanel() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      pokePlayer();
      await sleep(350);
      const trigger = findQualityTrigger();
      if (!trigger) continue;

      const targets = [
        trigger,
        trigger.closest('[class*="quality-wrap"]'),
        trigger.parentElement,
      ].filter(Boolean);

      for (const el of targets) {
        hoverEnter(el);
        await sleep(400);
        if (qualityPanel()) return true;
      }
      for (const el of targets) {
        fireClick(el);
        await sleep(400);
        if (qualityPanel()) return true;
      }
    }
    return !!qualityPanel();
  }

  async function tryDomQuality() {
    // 1) 先让控制条出现
    pokePlayer();
    await sleep(400);

    let trigger = findQualityTrigger();
    if (!trigger) {
      pokePlayer();
      await sleep(600);
      trigger = findQualityTrigger();
    }
    if (!trigger) {
      const wrap = document.getElementById('web-player-controller-wrap-el');
      const kids = wrap
        ? [...wrap.querySelectorAll('*')].slice(0, 25).map((e) => `${e.tagName}.${e.className}`)
        : [];
      log('找不到画质按钮；控制条现有节点：', JSON.stringify(kids));
      return false;
    }

    // 2) 打开面板
    const opened = await openQualityPanel();
    const panel = qualityPanel();
    const scope = panel || playerContainer() || ctrlScope();
    const items = findQualityItems(scope);
    if (!items.length) {
      log(`画质面板没打开或没找到档位项（panel=${panel ? panel.className : 'null'}，open=${opened}）`);
      const around = panel || trigger.parentElement;
      if (around) log('附近 HTML：', (around.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300));
      closeQualityPanel();
      return false;
    }

    const scored = items.map((el) => {
      const label = leafText(el);
      return { el, label, rank: rankOfLabel(label) };
    }).filter((i) => i.rank > 0).sort((a, b) => b.rank - a.rank);

    log('画质面板：' + scored.map((i) => `${i.label}(${i.rank})`).join(' / '));
    const best = scored[0];
    if (!best) { log('面板里没有非「自动」的档位'); closeQualityPanel(); return false; }

    const isSelected = best.el.classList.contains('selected') ||
      (best.el.closest('.selected') != null);
    if (isSelected) {
      log(`面板已是最高档：${best.label}`);
      closeQualityPanel(); // 别把下拉菜单留在画面上
      return true;
    }

    // 记下点之前的 qn，以及这次点击对应候选里的目标 qn（按文案对），便于回读校验
    const infoBefore = readInfo();
    const before = curQn(infoBefore);
    let target = NaN;
    const candList = (infoBefore && (infoBefore.qualityCandidates || infoBefore.qualityList)) || [];
    for (const c of candList) {
      const desc = String((c && (c.desc || c.label)) || '').trim();
      if (desc && (desc === best.label || desc.includes(best.label) || best.label.includes(desc))) {
        const qn = qnOf(c);
        if (Number.isFinite(qn)) target = qn;
      }
    }

    fireClick(best.el);
    log(`已点选画质：${best.label}${Number.isFinite(target) ? `（目标 qn=${target}）` : ''}`);
    closeQualityPanel(); // 点完立刻收面板

    if (!Number.isFinite(before)) { log('读不到播放器画质，无法回读校验，按已点选处理'); return true; }

    // 等「qn 相对点击前发生变化」，而不是「不低于当前值」——后者会立刻为真，等于没校验
    const got = await waitFor(() => {
      const q = curQn(readInfo());
      if (!Number.isFinite(q) || q === before) return null;
      if (Number.isFinite(target)) return q === target ? q : null;
      return q > 0 ? q : null;
    }, 12000, 400);

    const now = got != null ? got : curQn(readInfo());
    log(`点选后当前 qn=${JSON.stringify(now)}（点击前 ${JSON.stringify(before)}）`);
    return got != null;
  }

  async function applyMaxQuality() {
    if (!CFG.maxQuality) return false;
    const firstQn = curQn(readInfo());

    // 先看是不是已经最高档：是的话完全不用碰 DOM（避免去开下拉面板）
    const info0 = readInfo();
    const cands0 = ((info0 && (info0.qualityCandidates || info0.qualityList)) || [])
      .map(qnOf).filter((n) => Number.isFinite(n) && n > 0);
    if (Number.isFinite(firstQn) && cands0.length && firstQn >= Math.max(...cands0)) {
      log(`已是最高画质 qn=${firstQn}，无需操作`);
      return true;
    }

    for (let round = 1; round <= 2; round++) {
      // 播放器实例可能比页面晚很多，耐心等；没实例就无法回读校验
      const p = await waitFor(getPlayer, 5000);
      if (!p) { log(`第 ${round} 轮：还没拿到播放器实例（livePlayer / Player）`); await sleep(1500); continue; }

      // 先走「像人一样悬停 + 点面板」，这条路实测最可靠
      const domOk = await tryDomQuality();
      closeQualityPanel(); // 无论成败都收面板，避免下拉菜单挂在画面上
      if (domOk) return true;

      // 面板点不通再试一次对外 API；它静默无效过一次就不再等
      if (!apiQualityDead) {
        if (await tryApiQuality()) return true;
        apiQualityDead = true;
        log('播放器 API 切画质无效，后续只走「点面板」路线');
      }
      await sleep(1200);
    }
    const nowQn = curQn(readInfo());
    if (Number.isFinite(firstQn) && Number.isFinite(nowQn) && nowQn > firstQn) {
      log(`没能切到最高档，但画质已从 ${firstQn} 提升到 ${nowQn}（可能是账号或房间上限），就此停手`);
      return true;
    }
    log(`画质未能切换，当前 ${JSON.stringify(nowQn)}`);
    log('提示：若手动在画质面板里也选不了更高档，就是账号/房间限制（原画通常需要登录，部分房间还要大会员），脚本无法绕开');
    return false;
  }

  /* ============== 清除「小橙车 / 小黄车」提示弹窗 ============== */
  // 实测文案（用户截图）：
  //   网页端暂不支持购物“小橙车”，麻烦观众老爷移步APP主播直播间内使用“小橙车”哦~
  // 站点会换词（小黄车 / 小橙车…），所以只锚定「暂不支持购物」这个核心短语
  const TIP_RE = /暂不支持购物|暂不支持.{0,6}小[黄橙]车|小[黄橙]车.{0,8}不支持/;
  const TIP_MAX_TEXT = 120; // 整张卡片文案约 40~60 字，放宽上限但仍是「小节点」
  // 别误伤聊天/弹幕区域（那里可能刚好有人在刷同一句话）
  const TIP_SKIP = [
    '#chat-items', '.chat-history-list', '.danmaku-item', '.bili-danmaku',
    '[class*="chat-item"]', '[class*="danmaku"]', '[class*="comment-item"]',
  ].join(',');

  function hideTipElement(el) {
    if (!el || el.nodeType !== 1) return false;

    // 处理过且仍是隐藏状态就跳过；若被站点重新显示（样式被清掉）则再处理一次
    if (el.getAttribute && el.getAttribute('data-bili-tip-killed') === '1') {
      if (el.offsetParent === null && getComputedStyle(el).display === 'none') return false;
      el.removeAttribute('data-bili-tip-killed');
    }

    const text = (el.textContent || '').trim();
    if (!text || text.length > TIP_MAX_TEXT) return false;
    if (!TIP_RE.test(text)) return false;
    try {
      if (el.closest(TIP_SKIP)) return false;
    } catch (_) { return false; }

    // 从命中节点往上隐藏：盖住「立绘 + 文案 + 关闭按钮」整张卡片，
    // 若外层只是这张卡片的空壳容器，也一并隐藏；一旦外层混入别的内容就停手
    let cur = el;
    let changed = false;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      if (cur.querySelector && cur.querySelector('video')) break; // 千万别把播放器藏了
      try {
        cur.style.setProperty('display', 'none', 'important');
        cur.setAttribute('data-bili-tip-killed', '1');
        changed = true;
      } catch (_) { /* 非 HTMLElement，忽略 */ }

      const parent = cur.parentElement;
      if (!parent || parent === document.body) break;
      if (parent.querySelector && parent.querySelector('video')) break;
      // 外层文案必须仍是这段提示（允许带上「×」等零碎字符），否则说明混入了别的内容
      const pText = (parent.textContent || '').trim();
      if (!pText.includes(text) || pText.length > text.length + 12) break;
      if (parent.childElementCount > 3) break; // 外层不像卡片容器，停手
      cur = parent;
    }
    if (changed) log('已移除小橙车提示弹窗：', text.slice(0, 40));
    return changed;
  }

  // 只遍历「文本节点」，避免大页面全量扫描导致卡顿
  function scanContainerForTip(root) {
    if (!root) return;
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').trim();
      if (!t || t.length > TIP_MAX_TEXT) continue;
      if (!TIP_RE.test(t)) continue;
      if (node.parentElement) hits.push(node.parentElement);
    }
    hits.forEach(hideTipElement);
  }

  // 个别弹窗可能挂在 shadow DOM 里，按宿主名定向扫一下
  const SHADOW_SCOPE = 'live-player, #live-player, [class*="shop"], [class*="cart"], [class*="commerce"], [class*="mall"]';
  function scanShadowRoots() {
    for (const host of document.querySelectorAll(SHADOW_SCOPE)) {
      if (host.shadowRoot) scanContainerForTip(host.shadowRoot);
    }
  }

  function startTipKiller() {
    if (!CFG.killCartTip) return;
    if (!document.body) { setTimeout(startTipKiller, 60); return; }

    scanContainerForTip(document.body);
    scanShadowRoots();

    // 兜底轮询：站点有时只改属性或重新挂载，MutationObserver 未必能触发
    // 用极便宜的字符串预筛，避免在弹幕/礼物很多的大页面上反复全量遍历
    setInterval(() => {
      if (document.hidden || !document.body) return;
      if (document.body.textContent.indexOf('暂不支持购物') === -1) return;
      scanContainerForTip(document.body);
      scanShadowRoots();
    }, 5000);

    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          if (m.target && m.target.parentElement) hideTipElement(m.target.parentElement);
        } else {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            hideTipElement(n);
            // 超大的新增子树（礼物/弹幕面板）跳过深扫，避免拖慢页面
            if (n.childElementCount <= 150) scanContainerForTip(n);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    log('小橙车提示弹窗清理已启动');
  }

  /* ============================ 调度 ============================ */
  const state = {
    href: location.href,
    running: false,
    fsDone: false,
    qDone: false,       // 直播间 = 画质；视频页 = 倍速
    userOptedOut: false,
    runs: 0,
    videoKey: '',       // 视频页：当前视频源，用来发现「切换分P/换集」
  };

  const allDone = () => {
    if (isVideoPage()) {
      const rateOn = Number(CFG.videoPlaybackRate) > 0;
      return (!CFG.webFullscreen || !CFG.videoWebFullscreen || state.fsDone) && (!rateOn || state.qDone);
    }
    return (!CFG.webFullscreen || state.fsDone) && (!CFG.maxQuality || state.qDone);
  };

  async function run(tag) {
    if (state.running || allDone() || state.userOptedOut) return;
    if (state.runs >= CFG.maxRunsPerRoom) return;
    state.runs += 1;
    state.running = true;

    const onVideo = isVideoPage();

    // 全屏和（画质/倍速）互不依赖，并行跑，避免一个卡住拖累另一个
    const tasks = [];
    if (CFG.webFullscreen && !state.fsDone && !state.userOptedOut) {
      tasks.push((async () => {
        const ok = await ensureWebFullscreen();
        log(`[${tag}] 网页全屏：${ok ? '已进入' : '未生效'}`);
        if (ok) { state.fsDone = true; armUserExitWatch(); }
      })());
    }

    if (onVideo) {
      if (Number(CFG.videoPlaybackRate) > 0 && !state.qDone) {
        tasks.push((async () => {
          const ok = await applyVideoRate();
          log(`[${tag}] 二倍速：${ok ? '已设置' : '未生效'}`);
          if (ok) state.qDone = true;
        })());
      }
    } else if (CFG.maxQuality && !state.qDone) {
      tasks.push((async () => {
        const ok = await applyMaxQuality();
        log(`[${tag}] 最高画质：${ok ? '已设置' : '未生效'}`);
        if (ok) state.qDone = true;
      })());
    }

    try {
      await Promise.all(tasks);
    } catch (e) {
      log(`[${tag}] 执行异常`, e);
    } finally {
      state.running = false;
    }
  }

  function onNavigate() {
    if (location.href === state.href) return;
    state.href = location.href;
    state.fsDone = false;
    state.qDone = false;
    state.userOptedOut = false;
    state.runs = 0;
    if (exitWatcher) { clearInterval(exitWatcher); exitWatcher = null; }
    log(isVideoPage() ? '切换视频，重新应用' : '切换直播间，重新应用');
  }

  // 视频页：换分P / 换集时视频元素和源都会变，这里检测到变化就重新应用一次
  function trackVideoChange() {
    if (!isVideoPage()) return;
    const v = videoElement();
    const key = v ? (v.currentSrc || v.src || '') : '';
    if (!key) return;
    if (!state.videoKey) { state.videoKey = key; return; } // 首次只记录，不算「换视频」
    if (key === state.videoKey) return;
    state.videoKey = key;
    state.fsDone = false;
    state.qDone = false;
    state.userOptedOut = false;
    state.runs = 0;
    log('检测到新的视频源，重新应用全屏/倍速');
  }

  /* ============================ 启动 ============================ */
  // 供控制台排查：__biliLiveHelperDebug()
  function exposeDebug() {
    window.__biliLiveHelperClosePanel = () => { closeQualityPanel(); return 'closing'; };
    window.__biliLiveHelperDebug = () => {
      const p = getPlayer();
      let info = null;
      try { info = p ? p.getPlayerInfo() : null; } catch (e) { info = { error: String(e) }; }
      const labels = [...document.querySelectorAll('.quality-container .quality-select')]
        .map((el) => (el.textContent || '').trim());
      const out = {
        version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || CFG.version,
        page: isVideoPage() ? 'video' : (isLivePage() ? 'live' : 'other'),
        hasPlayer: !!p,
        playerKeys: p ? ['getPlayerInfo', 'switchQuality', 'switchQualitySeamless', 'setFullscreenStatus']
          .filter((k) => typeof p[k] === 'function') : [],
        webFullscreen: isWebFullscreen(),
        quality: info && info.quality,
        candidates: info && (info.qualityCandidates || []).map((c) => ({ qn: c.qn, code: c.code, desc: c.desc || c.label })),
        panelLabels: labels,
        video: isVideoPage() ? {
          playbackRate: (videoElement() || {}).playbackRate,
          hasApi: !!videoApi(),
          hasFullscreenBtn: !!findVideoFullscreenBtn(),
          videoKey: state.videoKey.slice(0, 60),
        } : null,
        state: { fsDone: state.fsDone, qDone: state.qDone, optedOut: state.userOptedOut, runs: state.runs },
      };
      console.info('[BiliLive-Helper] debug', out);
      return out;
    };
  }

  function boot() {
    log(`已注入 v${CFG.version}（${location.href}）`);
    exposeDebug();
    startTipKiller();

    // 直播间（/12345、/blanc/12345）或视频页（/video/BV…）才需要干活
    const inRoom = () => /^\/(blanc\/)?\d+/.test(location.pathname);
    const applicable = () => inRoom() || isVideoPage();

    setInterval(() => {
      onNavigate();
      trackVideoChange();
      if (applicable() && !state.running && !allDone()) run('poll');
    }, CFG.pollInterval);

    // 首轮尽快尝试
    setTimeout(() => { if (applicable()) run('init'); }, 600);
    window.addEventListener('popstate', onNavigate);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
