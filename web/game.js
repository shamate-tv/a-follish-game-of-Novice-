/* ============================================================================
 *  novice追逐赛 —— JavaScript 移植版
 *  原作：Scratch 3 / TurboWarp 作品《神经网页源代码v2.sb3》（作者：shamate-tv）
 *
 *  这个文件把 Scratch 里的积木一块一块翻译成了 JS，对照表如下：
 *  ---------------------------------------------------------------------------
 *    Scratch 积木                        这里的代码
 *  ---------------------------------------------------------------------------
 *    当绿旗被点击                        NC.Sim.greenFlag() 里启动脚本
 *    重复执行 { ... }                    while (true) { ... ; yield 一帧 }
 *    将大小设为 (50) %                   sprite.setSize(50)
 *    将旋转模式设为 [左右翻转]            sprite.rotationStyle = 'left-right'
 *    面向 [鼠标指针]                     sprite.pointTowardsMouse()
 *    移动 (10) 步                        sprite.moveSteps(10)
 *    碰到 [鼠标指针]？                   sprite.touchingMouse()
 *    播放声音 [凯の音] 等待播完           yield* playSoundUntilDone(sprite)
 *    移到 [头像]                         sprite.goTo(avatar)
 *  ---------------------------------------------------------------------------
 *
 *  运行规则也尽量对齐 Scratch：
 *    · 舞台 480 x 360，原点在正中央，x 向右、y 向上
 *    · 30 帧 / 秒（TurboWarp 默认帧率），每帧每个「重复执行」跑一圈
 *    · 「播放声音...等待播完」期间脚本会卡住（头像会停在原地）
 *    · 「碰到鼠标指针」是逐像素判定，鼠标只当作一个点；鼠标跑出舞台会被算在边上
 *    · 左右翻转：direction < 0（朝左）时图片水平镜像
 * ========================================================================== */
'use strict';

(function (global) {
  /* ------------------------------------------------------------------ *
   * 一、常量：和 Scratch 舞台一致
   * ------------------------------------------------------------------ */
  const STAGE_W = 480;              // 舞台宽（Scratch 单位）
  const STAGE_H = 360;              // 舞台高（Scratch 单位）
  const FPS = 30;                   // TurboWarp 默认帧率
  const STEP_MS = 1000 / FPS;
  const YIELD_FRAME = Symbol('一帧');// 相当于 Scratch 一个循环跑完后的"让出"

  /* 鼠标位置（舞台坐标）。Scratch 会把它夹在舞台范围内 */
  const mouse = { x: 0, y: 0 };

  /* 把两个点的位移换算成 Scratch 的方向：0=上、90=右、180/-180=下 */
  function scratchDirection(dx, dy) {
    let d = 90 - Math.atan2(dy, dx) * 180 / Math.PI;
    d = ((d + 180) % 360 + 360) % 360 - 180;   // 归一化到 (-180, 180]
    return d;
  }

  /* ------------------------------------------------------------------ *
   * 二、造型
   * ------------------------------------------------------------------ */
  class Costume {
    /**
     * @param {object} o
     * @param {HTMLImageElement} [o.image] 图片
     * @param {number} [o.bitmapResolution] 1 或 2（2 = 图片是"两倍图"，显示时缩一半）
     * @param {Uint8ClampedArray} [o.alpha] 图片的 RGBA 数据，用于像素级碰撞
     * @param {number} [o.width] [o.height] 图片像素尺寸
     */
    constructor(o) {
      this.image = o.image || null;
      this.res = o.bitmapResolution || 1;
      this.width = o.width != null ? o.width : (this.image ? this.image.width : 0);
      this.height = o.height != null ? o.height : (this.image ? this.image.height : 0);
      this.alpha = o.alpha || null;
      this.w = this.width / this.res;     // 造型逻辑尺寸：大小 100% 时占多少舞台单位
      this.h = this.height / this.res;
    }
    alphaAt(px, py) {
      if (!this.alpha) return true;       // 拿不到像素数据时退化成"外接框命中"
      return this.alpha[(py * this.width + px) * 4 + 3] > 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * 三、角色
   * ------------------------------------------------------------------ */
  class Sprite {
    constructor(name, o = {}) {
      this.name = name;
      this.x = o.x != null ? o.x : 0;
      this.y = o.y != null ? o.y : 0;
      this.size = o.size != null ? o.size : 100;         // 百分比
      this.direction = o.direction != null ? o.direction : 90;
      this.rotationStyle = o.rotationStyle || 'all around';
      this.visible = o.visible !== false;
      this.layerOrder = o.layerOrder != null ? o.layerOrder : 0;
      this.costume = o.costume || null;
      this.text = o.text || null;                        // 文字造型（原作的「名字」）
      this.fontSize = o.fontSize || 26;
      this.sound = o.sound || null;
    }

    /* 左右翻转：朝左（direction < 0）时镜像 */
    get flipped() {
      return this.rotationStyle === 'left-right' && this.direction < 0;
    }

    /* ---- 下面这些就是"积木" ---- */

    setSize(percent) { this.size = percent; }

    setRotationStyle(style) { this.rotationStyle = style; }

    pointTowardsMouse() {
      this.direction = scratchDirection(mouse.x - this.x, mouse.y - this.y);
    }

    moveSteps(steps) {
      const rad = (90 - this.direction) * Math.PI / 180;  // Scratch 方向 -> 数学极角
      this.x += steps * Math.cos(rad);
      this.y += steps * Math.sin(rad);
    }

    goTo(other) {
      this.x = other.x;
      this.y = other.y;
    }

    /* 碰到鼠标指针？逐像素判定：把鼠标位置换算成造型图片里的像素，看那个点是不是不透明 */
    touchingMouse() {
      const c = this.costume;
      if (!c || !c.width) return false;
      const scale = this.size / 100;
      const px = ((mouse.x - this.x) / scale + c.w / 2) * c.res;   // 造型图片内的 x
      const py = ((this.y - mouse.y) / scale + c.h / 2) * c.res;   // 造型图片内的 y（从上往下）
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) return false;
      const ix = this.flipped ? c.width - 1 - Math.floor(px) : Math.floor(px);
      return c.alphaAt(ix, Math.floor(py));
    }
  }

  /* ------------------------------------------------------------------ *
   * 四、声音积木：播放 [声音] 等待播完
   *    和 Scratch 一样，脚本会在这里停住，直到声音放完
   * ------------------------------------------------------------------ */
  function* playSoundUntilDone(sprite) {
    const snd = sprite.sound;
    if (snd) {
      try {
        snd.currentTime = 0;
        const p = snd.play();
        if (p && p.catch) p.catch(() => { /* 浏览器要求先有一次用户点击，忽略 */ });
      } catch (e) { /* 没有音频设备也无所谓，照样按时间等待 */ }
    }
    // 声音有多长，就等多少帧（时长还没读出来时按 0 处理，照常往下走）
    const dur = (snd && isFinite(snd.duration) && snd.duration > 0) ? snd.duration : 0;
    const frames = Math.round(dur * FPS);
    for (let i = 0; i < frames; i++) yield YIELD_FRAME;
  }

  /* ------------------------------------------------------------------ *
   * 五、脚本区 —— 和 Scratch 里的积木一一对应
   * ------------------------------------------------------------------ */
  /* 角色「头像」：
       当绿旗被点击
         将大小设为 50 %
         将旋转模式设为 [左右翻转]
         重复执行
           面向 [鼠标指针]
           移动 10 步
           如果 <碰到 [鼠标指针]？> 那么
             播放声音 [凯の音] 等待播完
   */
  function* avatarScript(avatar) {
    avatar.setSize(50);
    avatar.setRotationStyle('left-right');
    while (true) {                             // 「重复执行」
      avatar.pointTowardsMouse();              // 面向鼠标指针
      avatar.moveSteps(10);                    // 移动 10 步
      if (avatar.touchingMouse()) {            // 如果 碰到鼠标指针？
        yield* playSoundUntilDone(avatar);     //   播放声音 凯の音 等待播完
      }
      yield YIELD_FRAME;                       // ← 这一帧到此为止
    }
  }

  /* 角色「名字」：
       当绿旗被点击
         将大小设为 50 %
         重复执行
           移到 [头像]
   */
  function* nameScript(name, avatar) {
    name.setSize(50);
    while (true) {                             // 「重复执行」
      name.goTo(avatar);                       // 移到 头像
      yield YIELD_FRAME;
    }
  }

  /* ------------------------------------------------------------------ *
   * 六、运行时：管一帧一帧地跑脚本（对应 Scratch 的线程调度）
   * ------------------------------------------------------------------ */
  class Sim {
    constructor() {
      this.sprites = [];
      this.threads = [];
    }
    add(sprite) { this.sprites.push(sprite); return this; }   // 支持链式：sim.add(a).add(b)
    byName(n) { return this.sprites.find(s => s.name === n); }

    /* 当绿旗被点击 */
    greenFlag() {
      const avatar = this.byName('头像');
      const name = this.byName('名字');
      // Scratch 按角色顺序启动脚本：先「头像」，再「名字」
      this.threads = [
        { it: avatarScript(avatar), done: false },
        { it: nameScript(name, avatar), done: false },
      ];
    }

    /* 一帧 */
    step() {
      for (const t of this.threads) {
        if (t.done) continue;
        let guard = 1000;                      // 保险丝：防止脚本死循环卡死浏览器
        while (!t.done && guard-- > 0) {
          const r = t.it.next();
          if (r.done) { t.done = true; break; }
          if (r.value === YIELD_FRAME) break;  // 这一帧的份额用完了
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 七、把角色画到画布上
   * ------------------------------------------------------------------ */
  function drawSprite(ctx, s, toCanvas) {
    if (!s.visible) return;
    const scale = s.size / 100;
    const c = s.costume;
    const w = c ? c.w * scale : (s.text ? s.fontSize * s.text.length * 0.62 : 0);
    const h = c ? c.h * scale : (s.text ? s.fontSize * 1.25 : 0);
    const p = toCanvas(s.x, s.y);              // 角色中心（旋转中心）在画布上的位置
    const k = toCanvas.scale;                  // 舞台单位 -> 画布像素

    ctx.save();
    ctx.translate(p.x, p.y);
    if (s.flipped) ctx.scale(-1, 1);           // 左右翻转

    if (c && c.image) {
      ctx.drawImage(c.image, -w * k / 2, -h * k / 2, w * k, h * k);
    } else if (s.text) {
      ctx.font = `${s.fontSize * scale * k}px "Marker", "Comic Sans MS", cursive, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000000';
      ctx.fillText(s.text, 0, 0);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * 八、和网页接起来
   * ------------------------------------------------------------------ */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败: ' + src));
      img.src = src;
    });
  }

  /* 读出图片的 alpha 通道，供「碰到鼠标指针」做逐像素判定。
     file:// 直接打开网页时浏览器会禁止读像素，这时自动退化成外接框判定。 */
  function readAlpha(img) {
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    try {
      return g.getImageData(0, 0, cv.width, cv.height).data;
    } catch (e) {
      console.warn('[novice追逐赛] 读不到图片像素（大概是 file:// 打开的），碰撞判定退化为外接框。用本地服务器打开就正常了。');
      return null;
    }
  }

  async function start(opts = {}) {
    const canvas = opts.canvas;
    const ctx = canvas.getContext('2d');
    const SS = 2;                              // 画布用 2 倍分辨率画，缩放到页面时更清晰
    canvas.width = STAGE_W * SS;
    canvas.height = STAGE_H * SS;

    const toCanvas = (x, y) => ({ x: (x + STAGE_W / 2) * SS, y: (STAGE_H / 2 - y) * SS });
    toCanvas.scale = SS;

    /* --- 加载素材，摆好两个角色的初始状态（数值来自原项目 project.json）--- */
    const [avatarImg] = await Promise.all([loadImage(opts.avatarSrc || 'assets/avatar.png')]);

    const avatar = new Sprite('头像', {
      x: -138.0884639580204,
      y: -30.642043759657234,
      size: 50,
      direction: -8.082065674984023,
      rotationStyle: 'left-right',
      layerOrder: 1,
      costume: new Costume({ image: avatarImg, bitmapResolution: 2, alpha: readAlpha(avatarImg) }),
    });

    const name = new Sprite('名字', {
      x: -138, y: -30, size: 50, layerOrder: 2,
      text: 'novice',                          // 原项目的「名字」造型就是这行字
      fontSize: 52,                            // SVG 里的字号（大小 50% 会再减半）
    });

    if (opts.soundSrc) {
      const a = new Audio(opts.soundSrc);
      a.preload = 'auto';
      avatar.sound = a;
    }

    const sim = new Sim();
    sim.add(name).add(avatar);                 // 名字画在头像上面（layerOrder 2 > 1）

    /* --- 鼠标 --- */
    function setMouseFromEvent(e) {
      const r = canvas.getBoundingClientRect();
      // 画布像素 -> 舞台坐标，再按 Scratch 的规矩夹在舞台内
      const sx = (e.clientX - r.left) / r.width * STAGE_W - STAGE_W / 2;
      const sy = STAGE_H / 2 - (e.clientY - r.top) / r.height * STAGE_H;
      mouse.x = Math.max(-STAGE_W / 2, Math.min(STAGE_W / 2, sx));
      mouse.y = Math.max(-STAGE_H / 2, Math.min(STAGE_H / 2, sy));
    }
    window.addEventListener('pointermove', setMouseFromEvent);
    window.addEventListener('pointerdown', setMouseFromEvent);

    /* --- 画一帧 --- */
    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff';               // 原项目的背景是空白的
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const order = sim.sprites.slice().sort((a, b) => a.layerOrder - b.layerOrder);
      for (const s of order) drawSprite(ctx, s, toCanvas);
      // 画个鼠标小十字，方便看到"裁判"在哪
      const m = toCanvas(mouse.x, mouse.y);
      ctx.strokeStyle = 'rgba(255,80,80,.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(m.x - 7, m.y); ctx.lineTo(m.x + 7, m.y);
      ctx.moveTo(m.x, m.y - 7); ctx.lineTo(m.x, m.y + 7);
      ctx.stroke();
    }

    /* --- 主循环：按 30 帧/秒推进，和 Scratch 一样 --- */
    let acc = 0, last = 0, running = false, rafId = 0;
    function loop(now) {
      rafId = requestAnimationFrame(loop);
      if (!last) last = now;
      acc += Math.min(250, now - last);        // 卡顿时最多补 250ms，防止"瞬移"
      last = now;
      while (acc >= STEP_MS) {
        acc -= STEP_MS;
        if (running) sim.step();
      }
      render();
    }

    const api = {
      canvas, sim, mouse,
      get running() { return running; },
      greenFlag() { sim.greenFlag(); running = true; },
      stop() { running = false; sim.threads = []; },
      /* 方便做自动化测试/截图：直接摆好位置、原地走若干帧 */
      warp(frames = 0) { for (let i = 0; i < frames; i++) sim.step(); },
      setMouse(x, y) { mouse.x = x; mouse.y = y; },
    };

    render();
    rafId = requestAnimationFrame(loop);
    if (opts.autostart !== false) api.greenFlag();

    /* 调试用：index.html?mouse=120,-60&frames=90
       把"鼠标"钉在某个位置，并且直接快进到第 90 帧再停下来（做截图 / 录 GIF 用） */
    const q = new URLSearchParams((global.location && global.location.search) || '');
    if (q.has('mouse')) {
      const [x, y] = q.get('mouse').split(',').map(Number);
      if (isFinite(x) && isFinite(y)) api.setMouse(x, y);
    }
    if (q.has('frames')) {
      api.greenFlag();
      api.warp(Math.max(0, parseInt(q.get('frames'), 10) || 0));
      running = false;                       // 停在这一帧，方便截图对比
    }
    api.stopId = () => cancelAnimationFrame(rafId);
    return api;
  }

  global.NC = { Costume, Sprite, Sim, start, scratchDirection, mouse,
                avatarScript, nameScript, STAGE_W, STAGE_H, FPS };
})(typeof window !== 'undefined' ? window : globalThis);
