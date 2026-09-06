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
  });

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
  // v2.16 状态：封面旋转 / 歌词显示（含滚动行）
  let coverRotOn = true, lyricEnabled = true, lyricIdx = 0;

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

  /* ---------- v2.16 歌词区：演示歌词随播放滚动（最近 5 行） ---------- */
  const lyricRows = $$("#lyric-section .lyric-row");
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
  function renderLyrics() {
    const sec = $("#lyric-section");
    if (!sec) return;
    if (!lyricEnabled) { sec.classList.add("hidden"); return; }
    sec.classList.remove("hidden");
    lyricRows.forEach((row, ri) => {
      const line = FAKE_LYRICS[lyricIdx + ri - 2] || "";
      if (row.textContent !== line) row.textContent = line;
      row.classList.toggle("lyric-active", ri === 2);
    });
  }
  // 进度/切歌后同步歌词行（每行约 2 秒）
  function syncLyrics() {
    if (!lyricEnabled) return;
    const li = Math.max(0, Math.min(FAKE_LYRICS.length - 1, Math.floor(curTime / 2)));
    if (li !== lyricIdx) { lyricIdx = li; renderLyrics(); }
  }

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
    lyricIdx = 0;
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
    document.documentElement.style.setProperty("--lyric-size", v + "px");
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
    window.addEventListener("resize", resizeCanvas);
    requestAnimationFrame(drawEQ);
  }
})();
