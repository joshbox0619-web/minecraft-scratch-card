/**
 * Minecraft 禮品卡刮刮樂 - p5.js 互動腳本
 * 模擬真實新台幣十元硬幣刮開虛擬封條
 */

// ============================================================
// 全域變數宣告
// ============================================================
let imgUnopened;   // 未開封禮品卡圖片
let imgOpened;     // 已開封禮品卡圖片
let imgCoin;       // 斜放新台幣十元硬幣圖片

// 畫布與卡片尺寸
let cardWidth = 380;
let cardHeight = 618;
let canvasW = 380;
let canvasH = 618;

// 虛擬封條幾何資料（相對於卡片未開封圖片的比例）
// 經量測：Left: 11.91%, Top: 77.38%, Width: 77.70%, Height: 4.76%
const SEAL_NORM = {
  x: 0.122,
  y: 0.695,
  w: 0.804,
  h: 0.073
};

// 已開封圖片中的序號對應裁切比例
const CODE_NORM = {
  x: 0.112,
  y: 0.703,
  w: 0.804,
  h: 0.073
};

// 離屏繪圖緩衝區（虛擬封條遮罩圖層）
let scratchLayer;
let sealX, sealY, sealW, sealH;

// 刮除狀態
let isScratching = false;
let isCompleted = false;
let completionAlpha = 1.0;
let scratchProgress = 0;
let lastCheckFrame = 0;
let hasInteracted = false;

// 粒子系統（銀漆碎屑與慶祝彩帶）
let particles = [];
let confetti = [];

// 硬幣設定
let coinDisplayWidth = 130;
let coinDisplayHeight = 130;
// 硬幣底端接觸點比例（基於 1024x1024 圖片）
const COIN_ANCHOR_X = 0.50;
const COIN_ANCHOR_Y = 0.914;

// 游標 / 觸控歷史位置
let prevX = null;
let prevY = null;
let currentX = null;
let currentY = null;
let pointerActive = false;

// 音效控制
let soundEnabled = true;

// ============================================================
// Web Audio API 音效引擎（無外部依賴，純原生合成）
// ============================================================
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.noiseNode = null;
    this.scratchGain = null;
    this.filter = null;
    this.isInitialized = false;
    this.isPlayingScratch = false;
  }

  init() {
    if (this.isInitialized) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();

      // 建立白噪音緩衝區（用於模擬硬幣刮拭金屬漆的沙沙摩擦聲）
      const bufferSize = this.ctx.sampleRate * 2;
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = (Math.random() * 2 - 1) * 0.7;
      }

      this.noiseNode = this.ctx.createBufferSource();
      this.noiseNode.buffer = noiseBuffer;
      this.noiseNode.loop = true;

      // 帶通濾波器（過濾出金屬刮拭的特徵頻率 2200Hz ~ 3500Hz）
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'bandpass';
      this.filter.frequency.value = 2600;
      this.filter.Q.value = 1.8;

      // 刮拭音量控制
      this.scratchGain = this.ctx.createGain();
      this.scratchGain.gain.setValueAtTime(0, this.ctx.currentTime);

      // 連接音訊節點
      this.noiseNode.connect(this.filter);
      this.filter.connect(this.scratchGain);
      this.scratchGain.connect(this.ctx.destination);

      this.noiseNode.start(0);
      this.isInitialized = true;
    } catch (e) {
      console.warn('Web Audio API not supported or blocked:', e);
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setScratchIntensity(intensity) {
    if (!this.isInitialized || !soundEnabled || !this.ctx) return;
    const targetGain = Math.min(intensity * 0.35, 0.4);
    const now = this.ctx.currentTime;
    this.scratchGain.gain.cancelScheduledValues(now);
    this.scratchGain.gain.linearRampToValueAtTime(targetGain, now + 0.03);
  }

  stopScratch() {
    if (!this.isInitialized || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.scratchGain.gain.cancelScheduledValues(now);
    this.scratchGain.gain.linearRampToValueAtTime(0, now + 0.05);
  }

  playSuccessChime() {
    if (!this.isInitialized || !soundEnabled || !this.ctx) return;
    this.resume();
    // 愉悅的和弦連音（C5, E5, G5, C6）
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const startTime = this.ctx.currentTime + idx * 0.09;
      const duration = 0.6;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.25, startTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration);
    });
  }
}

const audio = new SoundEngine();

// ============================================================
// p5.js 生命週期函式
// ============================================================
function preload() {
  // 載入未開封卡片、已開封卡片及十元硬幣
  imgUnopened = loadImage('assets/card_unopened_2.jpg');
  imgOpened = loadImage('assets/card_opened_2.jpg');
  imgCoin = loadImage('assets/coin.png');
}

function setup() {
  calculateDimensions();
  const canvas = createCanvas(canvasW, canvasH);
  canvas.parent('canvas-container');

  // 設定適應像素密度
  pixelDensity(window.devicePixelRatio || 1);

  // 初始化虛擬封條遮罩層
  initScratchLayer();

  // 註冊 UI 事件監聽
  setupUIEventListeners();
}

function windowResized() {
  calculateDimensions();
  resizeCanvas(canvasW, canvasH);
  initScratchLayer();
}

function draw() {
  background(13, 17, 23);

  // 1. 繪製禮品卡主體
  drawGiftCard();

  // 2. 處理刮卡互動邏輯
  handleScratching();

  // 3. 繪製虛擬封條遮罩層
  drawSealLayer();

  // 4. 更新並繪製物理粒子
  updateAndDrawParticles();

  // 5. 繪製十元硬幣（跟隨游標/手指）
  drawCoin();

  // 6. 刮開完成後續動畫
  if (isCompleted && completionAlpha > 0) {
    completionAlpha = max(0, completionAlpha - 0.03);
  }
}

// ============================================================
// 尺寸與佈局計算
// ============================================================
function calculateDimensions() {
  const container = document.getElementById('canvas-container');
  const maxWidth = container ? min(container.clientWidth, 440) : 380;
  
  // 保持禮品卡原始寬高比例（1024 / 688）
  cardWidth = max(maxWidth, 280);
  cardHeight = Math.round(cardWidth * (1024 / 688));

  canvasW = cardWidth;
  canvasH = cardHeight;

  // 計算虛擬封條在畫布上的絕對像素座標
  sealX = Math.round(cardWidth * SEAL_NORM.x);
  sealY = Math.round(cardHeight * SEAL_NORM.y);
  sealW = Math.round(cardWidth * SEAL_NORM.w);
  sealH = Math.round(cardHeight * SEAL_NORM.h);

  // 硬幣顯示尺寸隨卡片縮放
  coinDisplayWidth = Math.round(cardWidth * 0.32);
  coinDisplayHeight = coinDisplayWidth;
}

// ============================================================
// 虛擬封條初始化
// ============================================================
function initScratchLayer() {
  if (scratchLayer) {
    scratchLayer.remove();
  }

  scratchLayer = createGraphics(sealW, sealH);
  scratchLayer.pixelDensity(1);

  // 將未開封圖片中真實的銀色封條區域裁切並貼入 scratchLayer
  if (imgUnopened && imgUnopened.width > 0) {
    const srcX = imgUnopened.width * SEAL_NORM.x;
    const srcY = imgUnopened.height * SEAL_NORM.y;
    const srcW = imgUnopened.width * SEAL_NORM.w;
    const srcH = imgUnopened.height * SEAL_NORM.h;
    scratchLayer.image(imgUnopened, 0, 0, sealW, sealH, srcX, srcY, srcW, srcH);
  } else {
    // 備用方案：若圖片尚未加載完成，繪製金屬銀漆外觀
    scratchLayer.background(195);
    scratchLayer.stroke(140);
    scratchLayer.strokeWeight(2);
    scratchLayer.noFill();
    scratchLayer.rect(0, 0, sealW, sealH);
    scratchLayer.fill(60);
    scratchLayer.noStroke();
    scratchLayer.textAlign(CENTER, CENTER);
    scratchLayer.textSize(12);
    scratchLayer.text("SCRATCH OFF GENTLY WITH COIN", sealW / 2, sealH / 2);
  }

  // 重設進度
  if (!isCompleted) {
    scratchProgress = 0;
    updateProgressUI(0);
  }
}

// ============================================================
// 卡片與封條繪製
// ============================================================
function drawGiftCard() {
  // 底圖：未開封卡片
  if (imgUnopened) {
    image(imgUnopened, 0, 0, cardWidth, cardHeight);
  }

  // 在封條區域底下繪製已開封的序號
  if (imgOpened) {
    const srcX = imgOpened.width * CODE_NORM.x;
    const srcY = imgOpened.height * CODE_NORM.y;
    const srcW = imgOpened.width * CODE_NORM.w;
    const srcH = imgOpened.height * CODE_NORM.h;
    
    // 繪製序號底圖（當上層封條被擦除時顯露）
    image(imgOpened, sealX, sealY, sealW, sealH, srcX, srcY, srcW, srcH);
  }

  // 若完全刮開，已開封卡片漸變為全幅顯示
  if (isCompleted && completionAlpha < 1.0) {
    push();
    tint(255, (1.0 - completionAlpha) * 255);
    image(imgOpened, 0, 0, cardWidth, cardHeight);
    pop();
  }
}

function drawSealLayer() {
  if (completionAlpha <= 0) return;

  push();
  if (completionAlpha < 1.0) {
    tint(255, completionAlpha * 255);
  }
  // 將具有透明擦除痕跡的 scratchLayer 繪製於封條位置
  image(scratchLayer, sealX, sealY);
  pop();
}

// ============================================================
// 刮除互動處理
// ============================================================
function handleScratching() {
  if (isCompleted) {
    audio.stopScratch();
    return;
  }

  // 判斷指標是否在畫布內且處於按壓/拖曳狀態
  const isInteracting = pointerActive && currentX !== null && currentY !== null;

  if (isInteracting && prevX !== null && prevY !== null) {
    // 計算硬幣刮拭的接觸點（硬幣底邊）
    const contactX = currentX;
    const contactY = currentY;
    const prevContactX = prevX;
    const prevContactY = prevY;

    // 檢查是否在封條有效範圍內（稍微擴展容許邊距）
    const margin = 15;
    const inSealArea = (
      contactX >= sealX - margin &&
      contactX <= sealX + sealW + margin &&
      contactY >= sealY - margin &&
      contactY <= sealY + sealH + margin
    );

    const distMoved = dist(contactX, contactY, prevContactX, prevContactY);

    if (inSealArea && distMoved > 0.5) {
      isScratching = true;

      // 隱藏初始提示
      if (!hasInteracted) {
        hasInteracted = true;
        const hint = document.getElementById('interaction-hint');
        if (hint) hint.style.opacity = '0';
      }

      // 轉換為 scratchLayer 的區域相對座標
      const lx = contactX - sealX;
      const ly = contactY - sealY;
      const plx = prevContactX - sealX;
      const ply = prevContactY - sealY;

      // 使用 p5.js erase() 在遮罩層進行塗抹擦除
      scratchLayer.erase();
      scratchLayer.strokeWeight(24);
      scratchLayer.strokeCap(ROUND);
      scratchLayer.stroke(0);
      scratchLayer.line(plx, ply, lx, ly);
      scratchLayer.noErase();

      // 產生銀漆碎屑粒子
      spawnShavings(contactX, contactY, distMoved);

      // 音效反饋（根據移動速度調節刮拭聲強度）
      const intensity = constrain(distMoved / 15, 0.2, 1.0);
      audio.setScratchIntensity(intensity);

      // 週期性計算刮除進度（每 8 幀計算一次以維持 60 FPS 高流暢度）
      if (frameCount - lastCheckFrame > 8) {
        lastCheckFrame = frameCount;
        calculateProgress();
      }
    } else {
      isScratching = false;
      audio.stopScratch();
    }
  } else {
    isScratching = false;
    audio.stopScratch();
  }

  // 更新前一幀座標
  prevX = currentX;
  prevY = currentY;
}

// ============================================================
// 刮除進度計算（覆蓋率演算法）
// ============================================================
function calculateProgress() {
  if (isCompleted || !scratchLayer) return;

  // 使用取樣網格（40 x 12 個取樣點）快速統計透明度
  scratchLayer.loadPixels();
  const d = scratchLayer.pixelDensity();
  const totalCols = 40;
  const totalRows = 12;
  let clearedPoints = 0;
  const totalPoints = totalCols * totalRows;

  for (let r = 0; r < totalRows; r++) {
    const y = Math.floor((r / totalRows) * sealH);
    for (let c = 0; c < totalCols; c++) {
      const x = Math.floor((c / totalCols) * sealW);
      // 取得 RGBA 中的 Alpha 通道索引
      const idx = 4 * ((y * d) * (sealW * d) + (x * d));
      const alphaVal = scratchLayer.pixels[idx + 3];

      // Alpha 小於 80 視為已刮除露出
      if (alphaVal < 80) {
        clearedPoints++;
      }
    }
  }

  const percent = Math.min(100, Math.round((clearedPoints / totalPoints) * 100));
  scratchProgress = percent;
  updateProgressUI(percent);

  // 達到 95% 判定為完成
  if (percent >= 95 && !isCompleted) {
    triggerCompletion();
  }
}

function updateProgressUI(percent) {
  const percentElem = document.getElementById('progress-percent');
  const fillElem = document.getElementById('progress-fill');
  if (percentElem) percentElem.textContent = `${percent}%`;
  if (fillElem) fillElem.style.width = `${percent}%`;
}

// ============================================================
// 刮開完成處理
// ============================================================
function triggerCompletion() {
  isCompleted = true;
  scratchProgress = 100;
  updateProgressUI(100);

  // 停止刮拭聲音，播放成功慶祝音效
  audio.stopScratch();
  audio.playSuccessChime();

  // 噴發慶祝彩帶
  spawnConfetti();

  // 顯示成功兌換橫幅
  const successBanner = document.getElementById('success-banner');
  if (successBanner) {
    successBanner.classList.remove('hidden');
    // 自動滾動使橫幅可見
    setTimeout(() => {
      successBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 200);
  }
}

// ============================================================
// 新台幣十元硬幣繪製（斜放立體視角）
// ============================================================
function drawCoin() {
  // 當滑鼠或手指在畫布內時顯示硬幣
  let x = currentX;
  let y = currentY;

  // 若尚未有操作，預設硬幣稍微懸停於封條右側提示
  if (x === null || y === null) {
    if (!hasInteracted && !isCompleted) {
      x = sealX + sealW * 0.85;
      y = sealY + sealH * 0.5;
    } else {
      return;
    }
  }

  push();
  // 刮拭時產生微小高頻震動與傾角變化，強化擬真物理反饋感
  let jitterAngle = 0;
  let jitterOffset = 0;
  if (isScratching) {
    jitterAngle = Math.sin(frameCount * 0.9) * 0.04;
    jitterOffset = Math.sin(frameCount * 1.5) * 1.5;
  }

  // 1. 繪製硬幣在卡片上的立體投影
  noStroke();
  fill(0, 0, 0, 70);
  ellipse(x + 12 + jitterOffset, y + 4, coinDisplayWidth * 0.45, coinDisplayHeight * 0.18);

  // 2. 繪製斜放十元硬幣
  // 將原點平移至接觸點 (x, y)，並以 (COIN_ANCHOR_X, COIN_ANCHOR_Y) 為中心對齊
  translate(x + jitterOffset, y);
  rotate(jitterAngle);

  if (imgCoin) {
    imageMode(CORNER);
    const drawX = -coinDisplayWidth * COIN_ANCHOR_X;
    const drawY = -coinDisplayHeight * COIN_ANCHOR_Y;
    image(imgCoin, drawX, drawY, coinDisplayWidth, coinDisplayHeight);
  }
  pop();
}

// ============================================================
// 粒子系統（銀漆粉屑與慶祝彩帶）
// ============================================================
function spawnShavings(x, y, intensity) {
  const count = Math.min(Math.floor(intensity * 0.8) + 1, 4);
  for (let i = 0; i < count; i++) {
    particles.push({
      x: x + random(-10, 10),
      y: y + random(-5, 5),
      vx: random(-2.5, 2.5),
      vy: random(-3.5, 0.5),
      size: random(1.5, 4),
      color: color(random(170, 220), random(170, 220), random(175, 225)),
      alpha: 255,
      life: random(20, 35)
    });
  }
}

function spawnConfetti() {
  const colors = [
    color(46, 160, 67),   // 翠綠
    color(227, 179, 65),  // 金黃
    color(88, 166, 255),  // 鑽石藍
    color(248, 81, 73),   // 紅石紅
    color(255, 255, 255)  // 純白
  ];

  for (let i = 0; i < 90; i++) {
    confetti.push({
      x: sealX + random(0, sealW),
      y: sealY + random(-10, sealH + 10),
      vx: random(-5, 5),
      vy: random(-8, -2),
      w: random(4, 9),
      h: random(3, 7),
      angle: random(TWO_PI),
      vAngle: random(-0.2, 0.2),
      color: random(colors),
      alpha: 255
    });
  }
}

function updateAndDrawParticles() {
  // 1. 更新銀漆碎屑
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.25; // 重力
    p.alpha -= 255 / p.life;

    if (p.alpha <= 0) {
      particles.splice(i, 1);
      continue;
    }

    noStroke();
    p.color.setAlpha(p.alpha);
    fill(p.color);
    circle(p.x, p.y, p.size);
  }

  // 2. 更新慶祝彩帶
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.x += c.vx;
    c.y += c.vy;
    c.vy += 0.2; // 重力
    c.vx *= 0.98;
    c.angle += c.vAngle;
    c.alpha -= 2.2;

    if (c.alpha <= 0 || c.y > height + 20) {
      confetti.splice(i, 1);
      continue;
    }

    push();
    translate(c.x, c.y);
    rotate(c.angle);
    noStroke();
    c.color.setAlpha(c.alpha);
    fill(c.color);
    rect(-c.w / 2, -c.h / 2, c.w, c.h);
    pop();
  }
}

// ============================================================
// 觸控與滑鼠事件處理
// ============================================================
function touchStarted() {
  audio.init();
  audio.resume();

  // 檢查是否在畫布範圍內
  if (mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height) {
    pointerActive = true;
    currentX = mouseX;
    currentY = mouseY;
    prevX = mouseX;
    prevY = mouseY;
    return false; // 防止行動裝置預設手勢（如頁面縮放或滾動）
  }
}

function touchMoved() {
  if (pointerActive) {
    currentX = mouseX;
    currentY = mouseY;
    return false; // 防止頁面滾動
  }
}

function touchEnded() {
  pointerActive = false;
  currentX = null;
  currentY = null;
  prevX = null;
  prevY = null;
  audio.stopScratch();
}

function mousePressed() {
  return touchStarted();
}

function mouseDragged() {
  return touchMoved();
}

function mouseReleased() {
  touchEnded();
}

// ============================================================
// UI 按鈕與外部事件綁定
// ============================================================
function setupUIEventListeners() {
  // 重新刮卡按鈕
  const btnReset = document.getElementById('btn-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      resetScratchCard();
    });
  }

  // 音效開關按鈕
  const btnSound = document.getElementById('btn-sound');
  const soundIcon = document.getElementById('sound-icon');
  const soundText = document.getElementById('sound-text');
  if (btnSound) {
    btnSound.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      if (soundIcon) soundIcon.textContent = soundEnabled ? '🔊' : '🔇';
      if (soundText) soundText.textContent = soundEnabled ? '音效開' : '靜音';
      if (!soundEnabled) {
        audio.stopScratch();
      }
    });
  }

  // 複製序號按鈕
  const btnCopy = document.getElementById('btn-copy');
  const copyText = document.getElementById('copy-text');
  const redeemCode = document.getElementById('redeem-code');
  if (btnCopy && redeemCode) {
    btnCopy.addEventListener('click', () => {
      const code = redeemCode.textContent.trim();
      navigator.clipboard.writeText(code).then(() => {
        if (copyText) {
          copyText.textContent = '已複製 ✓';
          setTimeout(() => {
            copyText.textContent = '複製';
          }, 2000);
        }
      }).catch(() => {
        // 備用複製方案
        const input = document.createElement('input');
        input.value = code;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        if (copyText) {
          copyText.textContent = '已複製 ✓';
          setTimeout(() => {
            copyText.textContent = '複製';
          }, 2000);
        }
      });
    });
  }
}

// 重設刮刮卡狀態
function resetScratchCard() {
  isCompleted = false;
  completionAlpha = 1.0;
  scratchProgress = 0;
  hasInteracted = false;
  particles = [];
  confetti = [];
  updateProgressUI(0);

  // 重新初始化封條遮罩層
  initScratchLayer();

  // 隱藏成功橫幅
  const successBanner = document.getElementById('success-banner');
  if (successBanner) {
    successBanner.classList.add('hidden');
  }

  // 恢復初始提示
  const hint = document.getElementById('interaction-hint');
  if (hint) {
    hint.style.opacity = '1';
  }
}
