/* =========================================================
   MusicPlayer · 在线体验版 Demo（仅界面展示，但交互真实可用）
   对接 www/ 真实布局：
   - 多文件夹 / 每文件夹 7 首 / 按全局序号命名
   - 播放·暂停·上一首·下一首·进度拖动 模拟真实行为
   - 均衡器滑块实时驱动可视化
   - 模糊 / 毛玻璃 / 文字颜色 设置真正生效（仅视觉）
   ========================================================= */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- 轻提示 ---------- */
  const toastEl = document.createElement("div");
  toastEl.className = "tc-toast";
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  /* ---------- 首开导航：协议 → 数据位置 → 应用 ---------- */
  function showOverlay(id) { $(id).classList.remove("hidden"); }
  function hideOverlay(id) { $(id).classList.add("hidden"); }
  $("#btn-agree").addEventListener("click", () => {
    hideOverlay("#agreement-overlay");
    showOverlay("#datafolder-overlay");
  });
  $("#btn-disagree").addEventListener("click", () => toast("需同意协议方可继续浏览"));
  $$('input[name="df"]').forEach((r) =>
    r.addEventListener("change", () => {
      $("#df-custom-row").style.display = r.value === "custom" ? "flex" : "none";
    })
  );
  $("#btn-df-pick").addEventListener("click", () => toast("体验版不支持选择文件夹"));
  $("#btn-df-confirm").addEventListener("click", () => {
    hideOverlay("#datafolder-overlay");
    toast("已进入体验界面（演示，无真实写入）");
    maybeShowDeviceStep(); // 首启第三步：设备形态选择（仅触屏弹）
  });

  /* ---------- 设备形态选择（v2.19）：手机/平板布局适配 ----------
     仅触屏(coarse)弹首启第三步；桌面(fine)按新机制解析布局（set <html data-layout>）。
     与 www/player.js 同逻辑，demo 用 localStorage 自管 deviceType（无 settings 框架）。 */
  let deviceType = localStorage.getItem("mp_deviceType") || "auto";
  function resolveDeviceLayout() {
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    let layout = "";
    if (coarse) {
      layout = (deviceType === "phone" || deviceType === "tablet")
        ? deviceType
        : (Math.min(window.innerWidth, window.innerHeight) >= 600 ? "tablet" : "phone");
    }
    const root = document.documentElement;
    if (layout) root.setAttribute("data-layout", layout);
    else root.removeAttribute("data-layout");
    return layout;
  }
  function applyDeviceLayout() { resolveDeviceLayout(); if (typeof lyricRefreshGeometry === "function") lyricRefreshGeometry(); }
  function maybeShowDeviceStep() {
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    if (!coarse) { applyDeviceLayout(); return; }
    const ov = $("#device-overlay");
    if (!ov) { applyDeviceLayout(); return; }
    const detected = Math.min(window.innerWidth, window.innerHeight) >= 600 ? "tablet" : "phone";
    const preset = (deviceType === "phone" || deviceType === "tablet") ? deviceType : detected;
    $$('input[name="dev"]').forEach((r) => { r.checked = (r.value === preset); });
    ov.classList.remove("hidden");
    const onConfirm = () => {
      const sel = document.querySelector('input[name="dev"]:checked');
      deviceType = sel ? sel.value : detected;
      try { localStorage.setItem("mp_deviceType", deviceType); } catch (_) {}
      applyDeviceLayout();
      ov.classList.add("hidden");
      const b = $("#btn-dev-confirm");
      if (b) b.removeEventListener("click", onConfirm);
    };
    const b = $("#btn-dev-confirm");
    if (b) b.addEventListener("click", onConfirm);
  }
  // 设置面板「设备形态」分段
  const devSeg = $("#set-device-seg");
  if (devSeg) {
    const refreshDevSeg = () => {
      $$(".dev-seg-btn", devSeg).forEach((b) => {
        b.classList.toggle("active", b.dataset.devtype === deviceType);
      });
    };
    $$(".dev-seg-btn", devSeg).forEach((b) => {
      b.addEventListener("click", () => {
        deviceType = b.dataset.devtype || "auto";
        try { localStorage.setItem("mp_deviceType", deviceType); } catch (_) {}
        applyDeviceLayout(); refreshDevSeg();
      });
    });
    refreshDevSeg();
  }
  // 旋转 / 尺寸 / 触屏状态变化
  window.addEventListener("resize", () => { if (deviceType === "auto") resolveDeviceLayout(); });
  window.addEventListener("orientationchange", () => { resolveDeviceLayout(); });
  try { if (window.matchMedia) window.matchMedia("(pointer: coarse)").addEventListener("change", () => { resolveDeviceLayout(); }); } catch (_) {}

  /* ---------- 顶栏时钟 ---------- */
  function tick() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    $("#header-clock").textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  tick();
  setInterval(tick, 1000);

  /* ---------- 演示数据：多文件夹，每文件夹 7 首，按全局序号命名 ---------- */
  const FORMATS = ["FLAC · 24bit", "MP3 · 320k", "WAV", "OGG", "AAC", "M4A", "OPUS", "APE"];
  // v2.16：演示歌名/歌手池，让「歌手行」等新 UI 有真实观感
  const TITLES = [
    "星夜漫游", "风与海", "落日飞行", "微光", "城市晚安", "春夜雨", "环岛公路",
    "慢速心跳", "纸飞机", "雾中车站", "夏日终曲", "月亮邮局", "逆光", "回声山谷",
    "无人岛屿", "凌晨两点", "街灯", "潮汐", "深夜食堂", "屋顶看星", "漫游指南",
  ];
  const ARTISTS = [
    "夜航星", "浅夏", "蓝桥", "拾光机", "白噪音", "未名", "山茶",
    "云雀", "薄荷汽水", "阿岚", "远山", "林间信使", "沉舟", "橘海",
  ];
  function buildTracks(start) {
    const arr = [];
    for (let i = 0; i < 7; i++) {
      const n = start + i;
      const total = 120 + n * 13;
      const m = Math.floor(total / 60), s = total % 60;
      arr.push({
        title: TITLES[(n - 1) % TITLES.length],
        artist: ARTISTS[(n - 1) % ARTISTS.length],
        format: FORMATS[(n - 1) % FORMATS.length],
        dur: total,
        durStr: `${m}:${String(s).padStart(2, "0")}`,
      });
    }
    return arr;
  }
  const FOLDERS = [
    { name: "/Music", tracks: buildTracks(1) },
    { name: "/Download/Audio", tracks: buildTracks(8) },
    { name: "/SDCard/Music", tracks: buildTracks(15) },
  ];

  let currentFolderIdx = 0, currentTrackIdx = 0, isPlaying = false, curTime = 0, playTimer = null;
  // v2.16 状态：封面旋转 / 歌词显示
  let coverRotOn = true, lyricEnabled = true;

  /* ---------- 音乐目录（切换文件夹同步刷新歌曲） ---------- */
  const dl = $("#dir-list");
  function renderDirs() {
    dl.innerHTML = "";
    FOLDERS.forEach((f, i) => {
      const li = document.createElement("li");
      li.className = "dir-item" + (i === currentFolderIdx ? " active" : "");
      li.innerHTML = `<span class="dir-icon">📁</span><span class="dir-name">${f.name}</span>`;
      li.addEventListener("click", () => {
        currentFolderIdx = i;
        renderDirs();
        renderPlaylist();
        selectTrack(0);
      });
      dl.appendChild(li);
    });
  }

  /* ---------- 播放列表 ---------- */
  const pl = $("#playlist");
  function renderPlaylist() {
    const tracks = FOLDERS[currentFolderIdx].tracks;
    pl.innerHTML = "";
    tracks.forEach((tr, i) => {
      const li = document.createElement("li");
      li.className = "playlist-item" + (i === currentTrackIdx ? " active" : "");
      li.innerHTML =
        `<span class="playlist-item-num">${i + 1}</span>` +
        `<div class="playlist-item-info"><div class="playlist-item-title">${tr.title}</div><div class="playlist-item-meta">${tr.artist}</div></div>` +
        `<span class="playlist-item-dur">${tr.durStr}</span>`;
      li.addEventListener("click", () => selectTrack(i));
      pl.appendChild(li);
    });
    $("#track-count").textContent = tracks.length + " 首";
  }

  function updateActiveItem() {
    $$(".playlist-item").forEach((x, i) => x.classList.toggle("active", i === currentTrackIdx));
  }

  /* ---------- v2.16 歌词区：全量滚动列表（mock 驱动，行为对齐 www/player.js 引擎） ----------
     当前句始终居中放大、上下收敛视差；可滑动/滚轮浏览，停止 5 秒自动回位；
     当前行右侧「— ▶」悬浮钮 → 弹出「从此句播放」气泡 → curTime 定位到该句（模拟 seek） */
  const lyricSection = $("#lyric-section");
  const lyricViewport = $("#lyric-viewport");
  const lyricList = $("#lyric-list");
  const lyricJumpBtn = $("#lyric-jump");
  const lyricJumpPop = $("#lyric-jump-pop");

  const FAKE_LYRICS = [
    "晚风穿过整座城市的灯光",
    "把心事折成纸飞机 扔向远方",
    "你听过海浪 也看过极光",
    "而我只想记住你唱歌的模样",
    "时针在屋顶上慢悠悠地走",
    "影子被路灯拉得很长很长",
    "别问明天会在哪一站靠岸",
    "此刻旋律就是最好的行囊",
    "星光落进酒杯 泛起微光",
    "把副歌唱完 我们就回家",
    "世界很大 大到忘了方向",
    "还好有这一首歌 陪在身旁",
  ];

  // 歌词引擎状态（模块级，lyr 前缀）
  let lyrItems = [];          // .lyric-item DOM 数组
  let lyrLrc = null;          // { time: i*2, text } 假想时间轴
  let lyrActive = -1;         // 当前句下标
  let lyrRowH = 0;            // 单行行盒高 px
  let lyrActiveH = 0;         // 当前句实际行盒高（展开 2 行后 ≥ lyrRowH）
  let lyrViewH = 0;           // viewport 可视高
  let lyrOffset = 0;          // lyric-list translateY
  let lyrFollowing = true;    // true=跟随播放；false=用户浏览中
  let lyrReturnTimer = null;  // 5s 自动回位定时器
  let lyrAnim = null;         // 回位动画 rAF
  let lyrPointerDrag = null;  // { id, startY, startOffset, moved }
  let lyrPopOpen = false;     // 「从此句播放」气泡是否展开
  let lyrVisA = -1, lyrVisB = -1;
  let lyrTransient = false;   // true=拖拽/滚轮/回位动画进行中 → 行内禁 transition
  let lyrTransientTimer = null;
  let lyrBrowseIdx = -1;  // 浏览态吸附/落点句（跳句以此为准）
  let lyricFontSize = 15;     // mock 字号（设置输入框同步，几何用）
  const LYR_AUTO_RETURN_MS = 5000;
  const LYR_RETURN_MS = 380;

  // 当前句下标：clamp(floor(curTime/2))（每 2 秒一句的假想时间轴）
  function lyrIdxForTime(t) {
    const n = FAKE_LYRICS.length;
    return Math.max(0, Math.min(n - 1, Math.floor(t / 2)));
  }

  // ---- 几何工具（与 www/player.js 引擎同公式） ----
  function lyrTop(i) {
    return i * lyrRowH + (i > lyrActive ? (lyrActiveH - lyrRowH) : 0);
  }
  function lyrRowHeight(i) {
    return (i === lyrActive) ? lyrActiveH : lyrRowH;
  }
  function lyrCenterOffset(i) {
    if (!lyrItems || i < 0 || i >= lyrItems.length || lyrViewH <= 0) return lyrOffset;
    return lyrViewH / 2 - (lyrTop(i) + lyrRowHeight(i) / 2);
  }
  function lyrClampOffset(o) {
    const n = lyrItems ? lyrItems.length : 0;
    if (!n || lyrViewH <= 0) return o;
    const max = lyrViewH / 2 - (0 + lyrRowHeight(0) / 2);
    const min = lyrViewH / 2 - (lyrTop(n - 1) + lyrRowHeight(n - 1) / 2);
    return Math.max(Math.min(max, o), min);
  }
  // 由当前 offset 反推「视口中心正在显示的第 i 行」（无歌词返回 -1）
  function lyrLineAtCenter() {
    if (!lyrItems || !lyrItems.length || lyrViewH <= 0) return -1;
    const half = lyrViewH / 2;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < lyrItems.length; i++) {
      const c = lyrTop(i) + lyrRowHeight(i) / 2 + lyrOffset;
      const d = Math.abs(c - half);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---- 建列表 / active 切换 / 布局 ----
  function buildLyricList() {
    if (!lyricList) return;
    lyrCancelAutoReturn();
    lyrCancelAnim();
    lyricList.innerHTML = "";
    lyrItems = [];
    lyrLrc = FAKE_LYRICS.map((txt, i) => ({ time: i * 2, text: txt }));
    lyrActive = -1;
    lyrRowH = Math.max(1, lyricFontSize * 1.45);
    lyrActiveH = lyrRowH;
    lyrViewH = lyricViewport ? lyricViewport.clientHeight : 0;
    const frag = document.createDocumentFragment();
    FAKE_LYRICS.forEach((txt) => {
      const item = document.createElement("div");
      item.className = "lyric-item";
      item.textContent = txt;
      frag.appendChild(item);
      lyrItems.push(item);
    });
    lyricList.appendChild(frag);
    lyrVisA = -1; lyrVisB = -1;
    lyrOffset = 0;
  }
  function lyrSetActiveTo(idx, expand) {
    if (!lyrItems || !lyrItems.length) return;
    if (idx < 0 || idx >= lyrItems.length) idx = 0;
    const oldEl = (lyrActive >= 0 && lyrActive < lyrItems.length) ? lyrItems[lyrActive] : null;
    const newEl = lyrItems[idx];
    if (oldEl && oldEl !== newEl) {
      oldEl.classList.remove("active");
      oldEl.style.height = "";
    }
    if (newEl) {
      newEl.classList.add("active");
      newEl.style.height = expand ? "auto" : "";
    }
    lyrActive = idx;
    if (expand && newEl) {
      lyrActiveH = newEl.offsetHeight || lyrRowH;
      if (lyrActiveH < lyrRowH) lyrActiveH = lyrRowH;
    } else {
      lyrActiveH = lyrRowH;
    }
  }
  function lyrLayout() {
    if (!lyricList || !lyrItems || !lyrItems.length || lyrViewH <= 0) return;
    lyricList.style.transform = "translateY(" + lyrOffset + "px)";
    const half = lyrViewH / 2;
    const n = lyrItems.length;
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      const y = lyrTop(i) + lyrOffset;
      if (y + lyrRowHeight(i) < 0) continue;
      if (y > lyrViewH) break;
      if (first < 0) first = i;
      last = i;
    }
    if (lyrVisA >= 0) {
      for (let i = lyrVisA; i <= lyrVisB; i++) {
        if (first >= 0 && i >= first && i <= last) continue;
        const el = lyrItems[i];
        if (el && el._lyrOn) {
          el.style.opacity = "0";
          el.style.transform = "";
          el._lyrOn = false;
        }
      }
    }
    if (first < 0) { lyrVisA = -1; lyrVisB = -1; return; }
    for (let i = first; i <= last; i++) {
      const el = lyrItems[i];
      if (!el) continue;
      let d = lyrTop(i) + lyrRowHeight(i) / 2 + lyrOffset - half;
      let nn = d / half;
      if (nn < -1) nn = -1; else if (nn > 1) nn = 1;
      const scale = Math.max(0.66, 1 - 0.34 * Math.abs(nn));
      const opacity = Math.max(0.15, 1 - 0.8 * Math.abs(nn));
      el.style.transition = lyrTransient ? "none" : "";
      el.style.opacity = String(opacity);
      el.style.transform = "translateY(0) scale(" + scale.toFixed(4) + ")";
      el._lyrOn = true;
    }
    lyrVisA = first; lyrVisB = last;
  }
  // 字号/尺寸变化后重算几何（行高/可视高/当前句实测高度）
  function lyricRefreshGeometry() {
    if (!lyricList || !lyrItems || !lyrItems.length) return;
    const prevOffset = lyrOffset;
    lyrRowH = Math.max(1, lyricFontSize * 1.45);
    lyrViewH = lyricViewport ? lyricViewport.clientHeight : 0;
    const el = lyrItems[lyrActive];
    if (el && el.classList.contains("active") && lyrFollowing) {
      el.style.height = "auto";
      lyrActiveH = el.offsetHeight || lyrRowH;
      if (lyrActiveH < lyrRowH) lyrActiveH = lyrRowH;
    } else {
      if (el) el.style.height = "";
      lyrActiveH = lyrRowH;
    }
    if (lyrFollowing && lyrActive >= 0) {
      lyrOffset = lyrCenterOffset(lyrActive);
    } else {
      lyrOffset = lyrClampOffset(prevOffset);
    }
    lyrLayout();
  }

  // ---- 浏览 / 回位 / 动画 ----
  function lyrCancelAutoReturn() {
    if (lyrReturnTimer) { clearTimeout(lyrReturnTimer); lyrReturnTimer = null; }
  }
  function lyrCancelAnim() {
    if (lyrAnim) { cancelAnimationFrame(lyrAnim); lyrAnim = null; }
  }
  // 浏览态吸附：把视口中心行吸附到中线（偏移微调到恰好居中），返回该行下标
  function lyrSnapBrowseToCenter() {
    if (!lyrItems || !lyrItems.length || lyrViewH <= 0) return -1;
    const idx = lyrLineAtCenter();
    if (idx < 0) return -1;
    lyrOffset = lyrClampOffset(lyrCenterOffset(idx));
    lyrLayout();
    return idx;
  }
  // 平滑移动 offset 到 to（用于吸附动画；结束时恢复 transient 并刷新跳句按钮）
  function lyrAnimOffsetTo(to, ms) {
    lyrCancelAnim();
    const from = lyrOffset;
    if (Math.abs(to - from) < 1) {
      lyrOffset = to; lyrLayout(); lyrTransient = false; lyrUpdateJumpUi(); return;
    }
    lyrTransient = true;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / (ms || 140));
      const ease = 1 - Math.pow(1 - p, 3);
      lyrOffset = lyrClampOffset(from + (to - from) * ease);
      lyrLayout();
      if (p < 1 && lyrFollowing === false && !lyrPointerDrag) {
        lyrAnim = requestAnimationFrame(step);
      } else {
        lyrAnim = null; lyrTransient = false; lyrLayout(); lyrUpdateJumpUi();
      }
    };
    lyrAnim = requestAnimationFrame(step);
  }
  function lyrScheduleAutoReturn() {
    lyrCancelAutoReturn();
    lyrReturnTimer = setTimeout(lyrFireAutoReturn, LYR_AUTO_RETURN_MS);
  }
  function lyrEnterBrowse() {
    if (!lyrItems || !lyrItems.length) return;
    lyrFollowing = false;
    lyrBrowseIdx = -1;  // 进入浏览即重置落点句
    lyrCancelAutoReturn();
    lyrCancelAnim();
    lyrHideJumpUi();
    lyrTransient = true;
  }
  function lyrFireAutoReturn() {
    lyrCancelAutoReturn();
    if (!lyrItems || !lyrItems.length) return;
    if (!lyricSection || lyricSection.classList.contains("hidden") || !lyricEnabled) return;
    lyrFollowing = true;
    const cur = lyrIdxForTime(curTime);   // 浏览期间播放可能前进，回到最新行（并实测行高）
    lyrSetActiveTo(cur, true);
    const from = lyrOffset;
    const to = lyrClampOffset(lyrCenterOffset(lyrActive));
    lyrTransient = true;
    if (Math.abs(to - from) < 1) {
      lyrOffset = to;
      lyrTransient = false;
      lyrLayout();
      lyrUpdateJumpUi();
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      if (!lyrFollowing) { lyrAnim = null; lyrTransient = false; return; }
      const p = Math.min(1, (now - t0) / LYR_RETURN_MS);
      const ease = 1 - Math.pow(1 - p, 3);   // easeOutCubic
      lyrOffset = lyrClampOffset(from + (to - from) * ease);
      lyrLayout();
      if (p < 1) {
        lyrAnim = requestAnimationFrame(step);
      } else {
        lyrAnim = null;
        lyrTransient = false;
        lyrLayout();
        lyrUpdateJumpUi();
      }
    };
    lyrAnim = requestAnimationFrame(step);
  }

  // ---- 手势：拖拽 / 滚轮（挂在 lyric-viewport） ----
  function lyrOnPointerDown(e) {
    if (!lyricEnabled || !lyricSection || lyricSection.classList.contains("hidden")) return;
    if (!lyrItems || !lyrItems.length) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    lyrPointerDrag = { id: e.pointerId, startY: e.clientY, startOffset: lyrOffset, moved: false };
    if (lyricViewport && lyricViewport.setPointerCapture) {
      try { lyricViewport.setPointerCapture(e.pointerId); } catch (_) {}
    }
    lyrEnterBrowse();
    e.preventDefault();
  }
  function lyrOnPointerMove(e) {
    if (!lyrPointerDrag || e.pointerId !== lyrPointerDrag.id) return;
    const dy = e.clientY - lyrPointerDrag.startY;
    if (!lyrPointerDrag.moved && Math.abs(dy) < 3) return;
    lyrPointerDrag.moved = true;
    lyrOffset = lyrClampOffset(lyrPointerDrag.startOffset + dy);
    lyrLayout();
  }
  function lyrEndPointer(e) {
    const d = lyrPointerDrag;
    if (!d) return;
    lyrPointerDrag = null;
    if (lyricViewport && lyricViewport.releasePointerCapture) {
      try { lyricViewport.releasePointerCapture(d.id); } catch (_) {}
    }
    if (!d.moved) {
      lyrFollowing = true;
      lyrTransient = false;
      lyrUpdateJumpUi();
      return;
    }
    lyrScheduleAutoReturn();
    // 松手吸附：把离中线最近的一句滚到正中间（跟随态行高不展开，几何稳定）
    if (!lyrPointerDrag) {
      const idx = lyrSnapBrowseToCenter();
      lyrBrowseIdx = idx;
      lyrOffset = lyrClampOffset(lyrCenterOffset(idx)); // 立即居中（无动画，避免与跟手偏移叠加）
      lyrLayout();
    }
    // 拖拽结束立即复位 transient（拖拽全程恒为 true；不复位则「从此句播放」按钮被 busy 判定一直隐藏）
    if (lyrTransientTimer) { clearTimeout(lyrTransientTimer); lyrTransientTimer = null; }
    lyrTransient = false;
    lyrUpdateJumpUi();
  }
  function lyrOnWheel(e) {
    if (!lyricEnabled || !lyricSection || lyricSection.classList.contains("hidden")) return;
    if (!lyrItems || !lyrItems.length) return;
    if (!lyrFollowing) {
      lyrCancelAutoReturn();
      lyrCancelAnim();
    } else {
      lyrFollowing = false;
      lyrHideJumpUi();
    }
    const factor = (e.deltaMode === 1) ? 16 : 1;   // Firefox 行模式 → px
    lyrOffset = lyrClampOffset(lyrOffset - (e.deltaY * factor)); // 滚轮向下 = 看后面的歌词
    lyrLayout();
    lyrTransient = true;
    if (lyrTransientTimer) clearTimeout(lyrTransientTimer);
    lyrTransientTimer = setTimeout(() => {
      lyrTransientTimer = null; lyrTransient = false;
      const idx = lyrSnapBrowseToCenter();
      if (idx >= 0) lyrBrowseIdx = idx;
      lyrUpdateJumpUi();
    }, 90);
    lyrCancelAutoReturn();
    lyrScheduleAutoReturn();
    e.preventDefault();
  }

  // ---- 悬浮控件：jump 按钮 + 「从此句播放」气泡 ----
  function lyrHideJumpUi() {
    if (lyricJumpBtn) lyricJumpBtn.classList.remove("visible");
    if (lyricJumpPop) { lyricJumpPop.classList.add("hidden"); lyrPopOpen = false; }
  }
  function lyrUpdateJumpUi() {
    if (!lyricSection || lyricSection.classList.contains("hidden") || !lyricEnabled) {
      lyrHideJumpUi();
      return;
    }
    const busy = !!lyrPointerDrag || lyrTransient;
    const hasLine = lyrFollowing ? (lyrActive >= 0) : (lyrLineAtCenter() >= 0);
    const visible = !!(lyrItems && lyrItems.length > 0 && !busy && hasLine);
    if (lyricJumpBtn) lyricJumpBtn.classList.toggle("visible", visible);
    if (!visible && lyricJumpPop) { lyricJumpPop.classList.add("hidden"); lyrPopOpen = false; }
  }
  function lyrOnJumpBtnClick(e) {
    e.stopPropagation();
    if (!lyricJumpPop) return;
    if (lyrPopOpen) {
      lyrPopOpen = false;
      lyricJumpPop.classList.add("hidden");
      if (!lyrFollowing) lyrScheduleAutoReturn(); // 关闭气泡后恢复 5s 自动回位
    } else {
      lyrPopOpen = true;
      lyricJumpPop.classList.remove("hidden");
      lyrCancelAutoReturn(); // 气泡开着不自动回位，避免“看着中心句却跳回播放句”的竞态
    }
  }
  function lyrOnJumpPopClick() {
    if (lyricJumpPop) lyricJumpPop.classList.add("hidden");
    lyrPopOpen = false;
    const lrc = lyrLrc;
    if (!lrc || !lrc.length) return;
    // 跟随态 → 播放句；浏览态 → 落点句（吸附后的视口中心句，优先于实时重算，防自动回位竞态）
    let idx = lyrFollowing ? lyrActive : (lyrBrowseIdx >= 0 ? lyrBrowseIdx : lyrLineAtCenter());
    if (idx < 0 || idx >= lrc.length) idx = lyrFollowing ? lyrActive : lyrLineAtCenter();
    if (idx < 0 || idx >= lrc.length) return;
    // demo 无真实音频：seek 语义 = 把 curTime 定位到该句起点，并保持/进入"播放中"假象
    const target = lrc[idx].time;
    if (curTime !== target) { curTime = target; updateProgress(); }
    if (!isPlaying) setPlaying(true);
    if (!lyrFollowing) {
      // 从浏览态跳播：恢复跟随并把该句归中
      lyrFollowing = true;
      lyrCancelAutoReturn();
      lyrSetActiveTo(idx, true);
      lyrOffset = lyrClampOffset(lyrCenterOffset(idx));
      lyrTransient = false;
      lyrLayout();
    }
    lyrUpdateJumpUi();
    syncLyrics();
  }

  // 事件绑定
  if (lyricViewport && window.PointerEvent) {
    lyricViewport.addEventListener("pointerdown", lyrOnPointerDown, { passive: false });
    window.addEventListener("pointermove", lyrOnPointerMove, { passive: false });
    window.addEventListener("pointerup", lyrEndPointer);
    window.addEventListener("pointercancel", lyrEndPointer);
  }
  if (lyricViewport) {
    lyricViewport.addEventListener("wheel", lyrOnWheel, { passive: false });
  }
  if (lyricJumpBtn) lyricJumpBtn.addEventListener("click", lyrOnJumpBtnClick);
  if (lyricJumpPop) lyricJumpPop.addEventListener("click", lyrOnJumpPopClick);
  document.addEventListener("pointerdown", (e) => {
    if (!lyrPopOpen) return;
    const t = e.target;
    if (t && t.closest && (t.closest("#lyric-jump-pop") || t.closest("#lyric-jump"))) return;
    lyrPopOpen = false;
    if (lyricJumpPop) lyricJumpPop.classList.add("hidden");
    if (!lyrFollowing) lyrScheduleAutoReturn(); // 点击别处关闭气泡：浏览态恢复自动回位
  });

  // 隐藏歌词区并清空引擎状态（开关关闭 / 无歌词时）
  function resetDemoLyrics() {
    lyrCancelAutoReturn();
    lyrCancelAnim();
    lyrPointerDrag = null;
    lyrPopOpen = false;
    lyrBrowseIdx = -1;
    if (lyrTransientTimer) { clearTimeout(lyrTransientTimer); lyrTransientTimer = null; }
    lyrTransient = false;
    if (lyricList) lyricList.innerHTML = "";
    if (lyricSection) lyricSection.classList.add("hidden");
    lyrHideJumpUi();
    lyrItems = [];
    lyrLrc = null;
    lyrActive = -1;
    lyrRowH = 0; lyrActiveH = 0; lyrViewH = 0;
    lyrOffset = 0;
    lyrFollowing = true;
    lyrVisA = -1; lyrVisB = -1;
  }

  /** 开关/切歌/初始化入口：显示歌词并定位到当前句（curTime 驱动） */
  function renderLyrics() {
    if (!lyricSection) return;
    if (!lyricEnabled) { resetDemoLyrics(); return; }
    lyricSection.classList.remove("hidden");   // 先可见再测量（viewport 高度）
    if (!lyrItems || !lyrItems.length) buildLyricList();
    lyrFollowing = true;
    lyrCancelAutoReturn();
    lyrCancelAnim();
    const idx = lyrIdxForTime(curTime);
    lyrSetActiveTo(idx, true);
    lyrOffset = lyrClampOffset(lyrCenterOffset(idx));
    lyrLayout();
    lyrUpdateJumpUi();
  }

  // 进度推进/拖动后同步歌词行（每句约 2 秒；跟随/浏览语义对齐 www 引擎）
  function syncLyrics() {
    if (!lyricEnabled || !lyrItems || !lyrItems.length) return;
    const sec = $("#lyric-section");
    if (!sec || sec.classList.contains("hidden")) return;
    const idx = lyrIdxForTime(curTime);
    if (idx === lyrActive) return;  // 防抖：当前句未变即跳过（回位动画由 rAF 自行推进）
    if (lyrFollowing) {
      if (idx !== lyrActive) {
        lyrCancelAnim();
        lyrSetActiveTo(idx, true);
        lyrOffset = lyrClampOffset(lyrCenterOffset(idx));
      }
    } else if (idx !== lyrActive) {
      lyrSetActiveTo(idx, false);   // 浏览中只移高亮，不挪动版面
    }
    lyrLayout();
    lyrUpdateJumpUi();
  }

  /** 调试钩子（QA / 排查用）：无歌词或无元素时调用不抛错 */
  window.__lyricDebug = {
    get state() {
      return {
        active: lyrActive,
        following: lyrFollowing,
        offset: lyrOffset,
        count: lyrItems ? lyrItems.length : 0,
        viewH: lyrViewH,
        rowH: lyrRowH,
      };
    },
    setTime(t) {
      if (!lyricEnabled) return;
      if (!lyricSection || lyricSection.classList.contains("hidden")) return;
      if (!lyrItems || !lyrItems.length) buildLyricList();
      lyricSection.classList.remove("hidden");
      lyrFollowing = true;
      lyrCancelAutoReturn();
      lyrCancelAnim();
      const idx = lyrIdxForTime(typeof t === "number" && isFinite(t) ? t : curTime);
      lyrSetActiveTo(idx, true);
      lyrOffset = lyrClampOffset(lyrCenterOffset(idx));
      lyrLayout();
      lyrUpdateJumpUi();
    },
    fireAutoReturn() {
      lyrFireAutoReturn();
    },
    getItemRect(i) {
      const el = lyrItems && lyrItems[i];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, center: r.top + r.height / 2, height: r.height };
    },
    centerOffsetOf(i) {
      return lyrCenterOffset(i);
    },
  };

  /* ---------- v2.16 封面旋转：无真实封面，生成渐变假封面展示旋转效果 ---------- */
  const coverArtCache = {};
  function fakeCoverURL(n) {
    if (coverArtCache[n]) return coverArtCache[n];
    const c = document.createElement("canvas");
    c.width = 320; c.height = 320;
    const g = c.getContext("2d");
    const hue = (n * 47) % 360;
    const grd = g.createLinearGradient(0, 0, 320, 320);
    grd.addColorStop(0, `hsl(${hue},72%,58%)`);
    grd.addColorStop(1, `hsl(${(hue + 80) % 360},78%,36%)`);
    g.fillStyle = grd; g.fillRect(0, 0, 320, 320);
    g.beginPath(); g.arc(160, 160, 116, 0, Math.PI * 2);
    g.strokeStyle = "rgba(255,255,255,0.55)"; g.lineWidth = 12; g.stroke();
    g.beginPath(); g.arc(160, 160, 58, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,255,255,0.35)"; g.fill();
    coverArtCache[n] = c.toDataURL("image/png");
    return coverArtCache[n];
  }
  function updateCoverArt() {
    const img = $("#cover-img"), icon = $("#cover-icon");
    if (!img || !icon) return;
    if (coverRotOn) {
      img.src = fakeCoverURL(currentTrackIdx + 1);
      img.style.display = "";
      icon.style.display = "none";
    } else {
      img.style.display = "none";
      icon.style.display = "";
    }
  }

  /* ---------- 进度（模拟播放推进 / 拖动定位） ---------- */
  function updateProgress() {
    const tr = FOLDERS[currentFolderIdx].tracks[currentTrackIdx];
    const pct = tr.dur ? Math.min(100, (curTime / tr.dur) * 100) : 0;
    $("#progress-fill").style.width = pct + "%";
    $("#progress-thumb").style.left = pct + "%";
    const m = Math.floor(curTime / 60), s = Math.floor(curTime) % 60;
    $("#current-time").textContent = `${m}:${String(s).padStart(2, "0")}`;
  }

  function selectTrack(idx) {
    currentTrackIdx = idx;
    const tr = FOLDERS[currentFolderIdx].tracks[idx];
    $("#track-title").textContent = tr.title;
    $("#track-artist").textContent = tr.artist;
    $("#track-format").textContent = tr.format;
    $("#total-time").textContent = tr.durStr;
    curTime = 0;
    updateProgress();
    updateActiveItem();
    renderLyrics();
    updateCoverArt();
  }

  function setPlaying(p) {
    isPlaying = p;
    $("#play-icon").style.display = p ? "none" : "block";
    $("#pause-icon").style.display = p ? "block" : "none";
    const cover = $("#cover");
    cover.classList.toggle("spinning", p);
    cover.classList.toggle("spinning-paused", !p);
    if (p) {
      if (playTimer) clearInterval(playTimer);
      playTimer = setInterval(tickPlay, 1000);
    } else {
      if (playTimer) { clearInterval(playTimer); playTimer = null; }
    }
  }

  function tickPlay() {
    const tr = FOLDERS[currentFolderIdx].tracks[currentTrackIdx];
    curTime += 1;
    if (curTime >= tr.dur) { curTime = tr.dur; updateProgress(); nextTrack(); return; }
    updateProgress();
    syncLyrics();
  }

  function nextTrack() {
    const n = FOLDERS[currentFolderIdx].tracks.length;
    selectTrack((currentTrackIdx + 1) % n);
  }
  function prevTrack() {
    const n = FOLDERS[currentFolderIdx].tracks.length;
    selectTrack((currentTrackIdx - 1 + n) % n);
  }

  /* ---------- 控制按钮（真实可用） ---------- */
  $("#btn-play").addEventListener("click", () => setPlaying(!isPlaying));
  $("#btn-next").addEventListener("click", nextTrack);
  $("#btn-prev").addEventListener("click", prevTrack);
  $$(".mode-group .mode-btn").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".mode-group .mode-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const m = b.dataset.mode;
      const name = { repeatOne: "单曲循环", repeat: "列表循环", shuffle: "随机播放" }[m];
      toast("播放模式：" + name);
    })
  );

  /* ---------- 音量 ---------- */
  const vol = $("#volume");
  const volVal = $("#vol-value");
  vol.addEventListener("input", () => (volVal.textContent = Math.round(vol.value * 100) + "%"));
  $("#vol-icon").addEventListener("click", () => {
    const nv = vol.value > 0 ? 0 : 0.8;
    vol.value = nv; volVal.textContent = Math.round(nv * 100) + "%";
  });

  /* ---------- 进度条拖动 ---------- */
  const wrap = $("#progress-bar-wrap");
  let dragging = false;
  function seek(e) {
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const tr = FOLDERS[currentFolderIdx].tracks[currentTrackIdx];
    curTime = ratio * tr.dur;
    updateProgress();
    syncLyrics();
  }
  wrap.addEventListener("pointerdown", (e) => {
    dragging = true;
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
    seek(e);
  });
  wrap.addEventListener("pointermove", (e) => { if (dragging) seek(e); });
  wrap.addEventListener("pointerup", () => { dragging = false; });
  wrap.addEventListener("pointercancel", () => { dragging = false; });

  /* ---------- 装饰性（无法真实实现）按钮 ---------- */
  $("#btn-add-dir").addEventListener("click", () => toast("体验版不支持添加目录"));
  ["#btn-open-file", "#btn-open-folder"].forEach((s) =>
    $(s).addEventListener("click", () => toast("体验版不支持选择文件"))
  );

  /* ---------- 面板开关 ---------- */
  function openModal(sel) { $(sel).classList.remove("hidden"); }
  function closeModal(el) { el.classList.add("hidden"); }
  $("#btn-settings").addEventListener("click", () => openModal("#settings-overlay"));
  $("#btn-transcode").addEventListener("click", () => openModal("#transcode-overlay"));
  $("#btn-equalizer").addEventListener("click", () => openModal("#equalizer-overlay"));
  $("#btn-close-settings").addEventListener("click", () => closeModal($("#settings-overlay")));
  $("#btn-close-transcode").addEventListener("click", () => closeModal($("#transcode-overlay")));
  $("#btn-close-equalizer").addEventListener("click", () => closeModal($("#equalizer-overlay")));
  ["#settings-overlay", "#transcode-overlay", "#equalizer-overlay"].forEach((s) => {
    const el = $(s);
    el.addEventListener("click", (e) => { if (e.target === el) closeModal(el); });
  });

  /* ---------- 背景来源（4 选 1，柔和随机纯色） ---------- */
  const bg = $("#bg");
  // 柔光版（不刺眼，低饱和）
  const SOFT_COLORS = [
    "#f7b7c8", // 柔粉
    "#f9c5d5", // 浅粉
    "#c8e6c9", // 浅绿
    "#bfe8d8", // 薄荷绿
    "#bbd9f2", // 浅蓝
    "#b3d4ed", // 天蓝
    "#d9c7ee", // 浅紫
    "#f7e6b3", // 浅黄
    "#f8d2b8", // 浅橙
    "#bfe3e6", // 浅青
  ];
  // 标准色（清晰但不刺眼）
  const STANDARD_COLORS = [
    "#ef9a9a", // 红
    "#f48fb1", // 粉
    "#ce93d8", // 紫
    "#9fa8da", // 蓝紫
    "#90caf9", // 蓝
    "#80deea", // 青
    "#a5d6a7", // 绿
    "#ffe082", // 琥珀
    "#ffcc80", // 橙
    "#bcaaa4", // 棕灰
  ];
  const veilEl = () => $("#bg-veil");
  function randOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  // 演示「壁纸」：两团鲜明径向色块 + 深色底（无真实图片），使「模糊(Blur)」的
  // 整屏磨砂遮罩 #bg-veil 效果肉眼可见
  function applyBg() {
    const a = randOf(STANDARD_COLORS);
    const b = randOf(STANDARD_COLORS);
    const c = randOf(SOFT_COLORS);
    bg.style.background =
      `radial-gradient(circle at 22% 16%, ${a} 0, ${a} 16%, transparent 52%),` +
      `radial-gradient(circle at 84% 76%, ${b} 0, ${b} 22%, transparent 56%),` +
      `linear-gradient(150deg, ${c} 0%, #14112e 88%)`;
    if (veilEl()) veilEl().classList.toggle("off", !blurOn);
  }

  /* ---------- 纯色背景：应用内透明选色菜单 ---------- */
  const solidOverlay = $("#solid-color-overlay");
  function buildSwatches(containerId, colors) {
    const c = $(containerId);
    if (!c) return;
    c.innerHTML = "";
    colors.forEach((col) => {
      const b = document.createElement("button");
      b.className = "solid-swatch";
      b.style.background = col;
      b.title = col;
      b.addEventListener("click", () => {
        bg.style.background = col;
        if (solidOverlay) solidOverlay.classList.add("hidden");
        toast("已应用纯色：" + col);
      });
      c.appendChild(b);
    });
  }
  buildSwatches("#solid-standard", STANDARD_COLORS);
  buildSwatches("#solid-soft", SOFT_COLORS);

  $$('input[name="bgsrc"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.value === "solid") {
        if (solidOverlay) solidOverlay.classList.remove("hidden");
        const h = $("#bg-src-hint");
        if (h) h.textContent = "已打开纯色选择菜单（标准色 / 柔光版）";
        return;
      }
      applyBg();
      const h = $("#bg-src-hint");
      if (h) h.textContent = "已随机填充柔和纯色（演示，无图片）";
      toast("背景已切换（随机柔和纯色，无图片）");
    })
  );
  const solidClose = $("#solid-color-close");
  if (solidClose) solidClose.addEventListener("click", () => solidOverlay.classList.add("hidden"));
  if (solidOverlay)
    solidOverlay.addEventListener("click", (e) => {
      if (e.target === solidOverlay) solidOverlay.classList.add("hidden");
    });

  /* ---------- 设置：模糊 / 毛玻璃 / 文字颜色（视觉真实生效） ---------- */
  let blurOn = true, frostOn = true, blurVal = 10, frostVal = 8;
  function applyBlur() {
    const px = (blurOn ? blurVal : 0);
    document.documentElement.style.setProperty("--glass-blur", px + "px");
    // v2.16 壁纸模糊遮罩：关闭模糊 → 遮罩 off（壁纸清晰直出）
    if (veilEl()) veilEl().classList.toggle("off", !blurOn);
  }
  function applyFrost() {
    document.documentElement.style.setProperty("--glass-frost", frostOn ? frostVal / 100 : 0);
  }

  /* ---------- 应用标题：自定义顶栏文字 + 音符标志 ---------- */
  let appTitle = 'MusicPlayer-一切皆可自定', showLogoMark = true;
  function applyAppTitle() {
    const logoText = $("#logo-text");
    const t = (appTitle || '').trim();
    if (logoText) {
      logoText.textContent = t;
      logoText.style.display = t ? '' : 'none';   // 清空则不回退（直接隐藏文字）
    }
    const logoMark = $("#logo-mark");
    if (logoMark) logoMark.style.display = showLogoMark ? '' : 'none';
  }
  const appTitleInput = $("#set-app-title");
  if (appTitleInput) appTitleInput.addEventListener("input", function () {
    appTitle = this.value;
    const logoText = $("#logo-text");
    const t = (appTitle || '').trim();
    if (logoText) { logoText.textContent = t; logoText.style.display = t ? '' : 'none'; }
  });
  const markToggle = $("#set-logo-mark-toggle");
  if (markToggle) markToggle.addEventListener("click", function () {
    showLogoMark = !showLogoMark;
    this.classList.toggle("active", showLogoMark);
    this.textContent = showLogoMark ? "开启" : "关闭";
    const logoMark = $("#logo-mark");
    if (logoMark) logoMark.style.display = showLogoMark ? '' : 'none';
  });
  applyAppTitle();

  const COLOR_DEFAULTS = {
    titlebar: "#f1f0ff", playlist: "#f1f0ff", main: "#f1f0ff",
    transcode: "#f1f0ff", equalizer: "#f1f0ff",
  };
  Object.keys(COLOR_DEFAULTS).forEach((key) => {
    const inp = $("#set-color-" + key);
    if (inp) inp.addEventListener("input", (e) =>
      document.documentElement.style.setProperty("--text-" + key, e.target.value)
    );
  });
  $("#set-blur-toggle").addEventListener("click", function () {
    blurOn = !blurOn; this.classList.toggle("active", blurOn);
    this.textContent = blurOn ? "开启" : "关闭"; applyBlur();
  });
  $("#set-frost-toggle").addEventListener("click", function () {
    frostOn = !frostOn; this.classList.toggle("active", frostOn);
    this.textContent = frostOn ? "开启" : "关闭"; applyFrost();
  });
  $("#set-blur-slider").addEventListener("input", function () {
    blurVal = +this.value; $("#set-blur-val").textContent = blurVal + "px"; applyBlur();
  });
  $("#set-frost-slider").addEventListener("input", function () {
    frostVal = +this.value; $("#set-frost-val").textContent = frostVal + "%"; applyFrost();
  });
  $("#set-frost-minus").addEventListener("click", () => {
    frostVal = Math.max(0, frostVal - 1);
    $("#set-frost-slider").value = frostVal; $("#set-frost-val").textContent = frostVal + "%"; applyFrost();
  });
  $("#set-frost-plus").addEventListener("click", () => {
    frostVal = Math.min(100, frostVal + 1);
    $("#set-frost-slider").value = frostVal; $("#set-frost-val").textContent = frostVal + "%"; applyFrost();
  });
  $("#set-color-reset").addEventListener("click", () => {
    Object.keys(COLOR_DEFAULTS).forEach((k) => {
      const inp = $("#set-color-" + k);
      if (inp) inp.value = COLOR_DEFAULTS[k];
      document.documentElement.style.removeProperty("--text-" + k);
    });
    toast("文字颜色已恢复默认");
  });
  $("#set-reset").addEventListener("click", () => {
    blurOn = true; frostOn = true; blurVal = 10; frostVal = 8;
    appTitle = 'MusicPlayer-一切皆可自定'; showLogoMark = true;
    $("#set-blur-toggle").classList.add("active"); $("#set-blur-toggle").textContent = "开启";
    $("#set-frost-toggle").classList.add("active"); $("#set-frost-toggle").textContent = "开启";
    $("#set-blur-slider").value = 10; $("#set-blur-val").textContent = "10px";
    $("#set-frost-slider").value = 8; $("#set-frost-val").textContent = "8%";
    const ati = $("#set-app-title"); if (ati) ati.value = 'MusicPlayer-一切皆可自定';
    const mt = $("#set-logo-mark-toggle"); if (mt) { mt.classList.add("active"); mt.textContent = "开启"; }
    Object.keys(COLOR_DEFAULTS).forEach((k) => {
      const inp = $("#set-color-" + k);
      if (inp) inp.value = COLOR_DEFAULTS[k];
      document.documentElement.style.removeProperty("--text-" + k);
    });
    applyBlur(); applyFrost(); applyAppTitle();
    toast("外观已恢复默认");
  });

  /* ---------- v2.16 设置项：转码开关 / 封面旋转 / 歌词（仅视觉切换） ---------- */
  const transcodeToggle = $("#set-transcode-toggle");
  if (transcodeToggle) transcodeToggle.addEventListener("click", function () {
    const on = this.classList.toggle("active");
    this.textContent = on ? "开启" : "关闭";
    const btn = $("#btn-transcode");
    if (btn) { btn.disabled = !on; btn.classList.toggle("tc-disabled", !on); }
    toast(on ? "转码入口已开启（演示）" : "转码入口已关闭");
  });
  const coverRotToggle = $("#set-cover-rot-toggle");
  if (coverRotToggle) coverRotToggle.addEventListener("click", function () {
    coverRotOn = this.classList.toggle("active");
    this.textContent = coverRotOn ? "开启" : "关闭";
    updateCoverArt();
  });
  const lyricToggle = $("#set-lyric-toggle");
  if (lyricToggle) lyricToggle.addEventListener("click", function () {
    lyricEnabled = this.classList.toggle("active");
    this.textContent = lyricEnabled ? "开启" : "关闭";
    renderLyrics();
  });
  const lyricSizeInput = $("#set-lyric-size");
  if (lyricSizeInput) lyricSizeInput.addEventListener("change", (e) => {
    const v = Math.max(10, Math.min(28, parseInt(e.target.value, 10) || 15));
    e.target.value = v;
    lyricFontSize = v;
    document.documentElement.style.setProperty("--lyric-size", v + "px");
    lyricRefreshGeometry();   // 字号变化：重算行高/可视高并重定位
  });
  const lyricColorInput = $("#set-lyric-color");
  if (lyricColorInput) lyricColorInput.addEventListener("input", (e) =>
    document.documentElement.style.setProperty("--lyric-color", e.target.value)
  );
  const lyricRainbowToggle = $("#set-lyric-rainbow-toggle");
  if (lyricRainbowToggle) lyricRainbowToggle.addEventListener("click", function () {
    const on = this.classList.toggle("active");
    this.textContent = on ? "开启" : "关闭";
    const sec = $("#lyric-section");
    if (sec) sec.classList.toggle("rainbow", on && lyricEnabled);
  });

  /* ---------- 均衡器：滑块实时驱动可视化 ---------- */
  let eqOn = true;
  const eqToggle = $("#btn-eq-toggle");
  if (eqToggle) eqToggle.addEventListener("click", function () {
    eqOn = !eqOn; this.classList.toggle("active", eqOn);
    this.textContent = eqOn ? "开启" : "关闭";
  });
  $$("#equalizer-overlay .eq-band input").forEach((s) =>
    s.addEventListener("input", () => {
      const db = s.parentElement.querySelector(".eq-db");
      if (db) db.textContent = s.value;
    })
  );
  $("#eq-preset").addEventListener("change", () => toast("预设已选择（仅演示）"));

  const canvas = $("#eq-canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;
  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
  }
  function roundRect(c, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  const eqSliders = $$("#equalizer-overlay .eq-band input");
  function drawEQ(t) {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const n = eqSliders.length || 10;
    const gap = w / (n + 1);
    const amp = (isPlaying ? 1 : 0.4) * (eqOn ? 1 : 0.45);
    for (let i = 0; i < n; i++) {
      const v = parseFloat(eqSliders[i].value) || 0;
      const norm = (v + 12) / 24;
      const wob = amp * Math.sin(t / 280 + i * 0.6) * 0.14;
      const lvl = Math.max(0.03, Math.min(1, norm + wob));
      const bw = gap * 0.6, bh = lvl * h * 0.86, x = gap * (i + 1) - bw / 2, y = h - bh;
      const g = ctx.createLinearGradient(0, y, 0, h);
      g.addColorStop(0, "#a78bfa");
      g.addColorStop(1, "#60a5fa");
      ctx.fillStyle = g;
      roundRect(ctx, x, y, bw, bh, Math.min(6, bw / 2));
      ctx.fill();
    }
    requestAnimationFrame(drawEQ);
  }

  /* ---------- 转码（装饰） ---------- */
  const startBtn = $("#btn-start-transcode");
  if (startBtn) startBtn.disabled = false;
  $("#btn-load-ffmpeg").addEventListener("click", () => {
    $("#ffmpeg-status").className = "ffmpeg-status ready";
    $("#ffmpeg-status-text").textContent = "FFmpeg 引擎已就绪（演示）";
    toast("体验版：FFmpeg 为模拟状态");
  });
  $("#tc-drop-zone").addEventListener("click", () => toast("体验版不支持选择文件"));
  $("#tc-file-input").addEventListener("change", () => toast("体验版不支持真实转码"));
  ["#tc-format", "#tc-bitrate", "#tc-samplerate", "#tc-channels"].forEach((s) =>
    $(s).addEventListener("change", () => toast("参数已设置（仅演示）"))
  );
  $("#btn-start-transcode").addEventListener("click", () => toast("体验版不包含真实转码功能"));
  $("#btn-batch-export").addEventListener("click", () => toast("体验版不支持导出"));

  /* ---------- 初始化 ---------- */
  renderDirs();
  renderPlaylist();
  selectTrack(0);
  setPlaying(false);
  applyBlur();
  applyFrost();
  // 演示版默认开启转码入口（www 版默认关闭，此处覆盖以便展示）
  const tcBtn = $("#btn-transcode");
  if (tcBtn) { tcBtn.disabled = false; tcBtn.classList.remove("tc-disabled"); }
  const tcTg = $("#set-transcode-toggle");
  if (tcTg) { tcTg.classList.add("active"); tcTg.textContent = "开启"; }
  // 歌词初始样式变量（与 www 播放器默认一致）
  document.documentElement.style.setProperty("--lyric-size", "15px");
  document.documentElement.style.setProperty("--lyric-color", "#ffffff");
  renderLyrics();
  updateCoverArt();
  const initBg = (document.querySelector('input[name="bgsrc"]:checked') || {}).value || "live";
  applyBg();
  // 演示版：首开即弹用户协议 →（同意后）数据保存位置
  showOverlay("#agreement-overlay");
  if (canvas) {
    resizeCanvas();
    window.addEventListener("resize", () => {
      resizeCanvas();
      lyricRefreshGeometry();   // 窗口尺寸变化：歌词几何联动
    });
    requestAnimationFrame(drawEQ);
  }
  // 老用户进入体验版：立即按新机制解析设备形态布局（仅触屏生效）
  applyDeviceLayout();
})();

/* ---------- Mobile drawer (v2.18)：复刻 www/player.js 抽屉开关 ----------
   仅窄屏生效；桌面 ≥1024px 抽屉按钮不可见但逻辑保留。
   点「≡」切换 .app.drawer-open；点遮罩 / 播放列表任一首 / 目录任一项 / Esc → 关闭。
   曲目/目录项为动态重建，用容器级委托附加监听，不改写 demo 自身切换逻辑。 */
(function () {
  "use strict";
  const $m = (id) => document.getElementById(id);
  const appEl = document.querySelector(".app");
  const drawerBtn = $m("btn-drawer");
  const drawerMask = $m("drawer-mask");
  if (!appEl) return;

  const drawerIsOpen = () => appEl.classList.contains("drawer-open");
  const drawerSetOpen = (open) => appEl.classList.toggle("drawer-open", open);
  const drawerClose = () => drawerSetOpen(false);

  if (drawerBtn) {
    drawerBtn.addEventListener("click", () => drawerSetOpen(!drawerIsOpen()));
  }
  if (drawerMask) {
    drawerMask.addEventListener("click", drawerClose);
  }
  const drawerPlaylist = $m("playlist");
  if (drawerPlaylist) {
    drawerPlaylist.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest(".playlist-item")) drawerClose();
    });
  }
  const drawerDirList = $m("dir-list");
  if (drawerDirList) {
    drawerDirList.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest(".dir-item")) drawerClose();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.code === "Escape" || e.key === "Escape") drawerClose();
  });
})();
