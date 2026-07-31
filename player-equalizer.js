/**
 * player-equalizer.js - 均衡器模块
 *
 * 来源：从 player.js 拆分而来（原 L30-48 eqState + L716-917 EQ 函数 + L931-936 自初始化）。
 *
 * 职责：
 *   - 管理 10 段图形均衡器（Web Audio API BiquadFilter 链）
 *   - 均衡器面板的打开/关闭、预设切换、滑块交互
 *   - 频谱可视化（AnalyserNode + Canvas requestAnimationFrame）
 *
 * 依赖：
 *   - DOM 元素 audio-engine（自取引用，与 player.js 指向同一节点，互不冲突）
 *   - Web Audio API（AudioContext / createMediaElementSource / createBiquadFilter）
 *
 * 独立性：不依赖 player.js 任何全局变量或函数，完全自包含、自初始化。
 * 加载顺序：在 index.html 中置于 player.js 之前（时序不敏感，均可正常工作）。
 */

'use strict';

// ==============================
// 均衡器状态
// ==============================
const eqState = {
  enabled: true,
  audioContext: null,
  source: null,
  filters: [],
  gainNode: null,
  presets: {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
    vocal: [0, 0, 0, 2, 4, 6, 4, 2, 0, 0],
    treble: [0, 0, 0, 0, 0, 0, 2, 4, 6, 8],
    electronic: [6, 4, 0, -2, 0, 2, 4, 6, 4, 2],
    rock: [5, 4, 2, 0, -2, 0, 3, 5, 4, 2],
    jazz: [0, 0, 2, 4, 3, 0, 2, 4, 3, 0],
    classical: [0, 0, 0, 2, 4, 4, 2, 0, 0, 0],
    pop: [0, 1, 2, 3, 4, 3, 2, 1, 0, 0],
  },
  frequencies: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
};

// 自取 audio 元素引用（与 player.js 中的 audio 指向同一 DOM 节点）
// 命名为 eqAudio 以避免与 player.js 顶层 const audio 在共享全局作用域中重复声明
const eqAudio = document.getElementById('audio-engine');

// ==============================
// 均衡器功能
// ==============================
function initEqualizer() {
  if (!window.AudioContext && !window.webkitAudioContext) {
    console.warn('[EQ] 浏览器不支持 Web Audio API');
    return;
  }

  // 创建音频上下文
  eqState.audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // 创建源节点（从 audio 元素）
  eqState.source = eqState.audioContext.createMediaElementSource(eqAudio);

  // 创建 10 个滤波器
  eqState.filters = [];
  let lastNode = eqState.source;

  eqState.frequencies.forEach((freq, index) => {
    const filter = eqState.audioContext.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    filter.gain.value = 0;

    // 串联连接
    lastNode.connect(filter);
    lastNode = filter;
    eqState.filters.push(filter);
  });

  // 连接到输出
  lastNode.connect(eqState.audioContext.destination);

  console.log('[EQ] 均衡器已初始化');
}

function setEQGain(index, gain) {
  if (!eqState.filters[index]) return;
  eqState.filters[index].gain.value = gain;
}

function applyEQPreset(presetName) {
  const preset = eqState.presets[presetName];
  if (!preset) return;

  const sliders = document.querySelectorAll('.eq-slider-vertical');
  sliders.forEach((slider, index) => {
    const value = preset[index] || 0;
    slider.value = value;
    updateEQDisplay(index, value);
    if (eqState.enabled) {
      setEQGain(index, value);
    }
  });
}

function updateEQDisplay(index, value) {
  const band = document.querySelector(`.eq-band[data-index="${index}"]`);
  if (band) {
    const dbLabel = band.querySelector('.eq-db');
    if (dbLabel) {
      dbLabel.textContent = value > 0 ? `+${value}` : value;
    }
    // 同时更新滑块值
    const slider = band.querySelector('.eq-slider-vertical');
    if (slider) {
      slider.value = value;
    }
  }
}

function toggleEQ(enabled) {
  eqState.enabled = enabled;
  const btn = document.getElementById('btn-eq-toggle');

  if (enabled) {
    btn.textContent = '开启';
    btn.classList.add('active');
    // 应用当前滑块值
    document.querySelectorAll('.eq-slider').forEach((slider, index) => {
      setEQGain(index, parseFloat(slider.value));
    });
  } else {
    btn.textContent = '关闭';
    btn.classList.remove('active');
    // 重置所有增益为 0
    eqState.filters.forEach(filter => {
      filter.gain.value = 0;
    });
  }
}

// ==============================
// 均衡器面板控制
// ==============================
function openEqualizer() {
  document.getElementById('equalizer-overlay')?.classList.remove('hidden');
  startEQVisualizer();
}

function closeEqualizer() {
  document.getElementById('equalizer-overlay')?.classList.add('hidden');
  stopEQVisualizer();
}

// ==============================
// 均衡器可视化
// ==============================
let eqVisualizerId = null;
let eqAnalyser = null;

function startEQVisualizer() {
  const canvas = document.getElementById('eq-canvas');
  if (!canvas || !eqState.audioContext) return;

  const ctx = canvas.getContext('2d');

  // 创建分析器
  if (!eqAnalyser && eqState.filters.length > 0) {
    eqAnalyser = eqState.audioContext.createAnalyser();
    eqAnalyser.fftSize = 256;
    // 连接到最后一级滤波器
    eqState.filters[eqState.filters.length - 1].disconnect();
    eqState.filters[eqState.filters.length - 1].connect(eqAnalyser);
    eqAnalyser.connect(eqState.audioContext.destination);
  }

  if (!eqAnalyser) return;

  const bufferLength = eqAnalyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    eqVisualizerId = requestAnimationFrame(draw);

    eqAnalyser.getByteFrequencyData(dataArray);

    ctx.fillStyle = 'rgba(20, 16, 50, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * canvas.height * 0.8;

      const gradient = ctx.createLinearGradient(0, canvas.height - barHeight, 0, canvas.height);
      gradient.addColorStop(0, '#34d399');
      gradient.addColorStop(1, 'rgba(52, 211, 153, 0.2)');

      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

      x += barWidth + 1;
    }
  }

  draw();
}

function stopEQVisualizer() {
  if (eqVisualizerId) {
    cancelAnimationFrame(eqVisualizerId);
    eqVisualizerId = null;
  }
}

// ==============================
// 均衡器事件绑定
// ==============================
function bindEqualizerEvents() {
  // 打开/关闭面板
  document.getElementById('btn-equalizer')?.addEventListener('click', openEqualizer);
  document.getElementById('btn-close-equalizer')?.addEventListener('click', closeEqualizer);

  // 点击遮罩关闭
  document.getElementById('equalizer-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'equalizer-overlay') closeEqualizer();
  });

  // 滑块事件 - 使用新的选择器
  document.querySelectorAll('.eq-slider-vertical').forEach((slider) => {
    const index = parseInt(slider.parentElement.dataset.index);
    slider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      updateEQDisplay(index, value);
      if (eqState.enabled) {
        setEQGain(index, value);
      }
    });
  });

  // 开关按钮
  document.getElementById('btn-eq-toggle')?.addEventListener('click', () => {
    toggleEQ(!eqState.enabled);
  });

  // 预设选择
  document.getElementById('eq-preset')?.addEventListener('change', (e) => {
    applyEQPreset(e.target.value);
  });
}

// ==============================
// 初始化（自包含，DOM 就绪后执行）
// ==============================
try {
  initEqualizer();
  bindEqualizerEvents();
} catch (e) {
  console.error('[EQ] 初始化失败:', e);
}
