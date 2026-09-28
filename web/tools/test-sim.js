/* ============================================================================
 *  移植版逻辑自测（不需要浏览器）
 *
 *  跑法：  node tools/test-sim.js
 *  它检查"积木语义"有没有翻译对：
 *    方向换算 / 移动 N 步 / 左右翻转 / 逐像素碰到鼠标 / 播放声音时脚本卡住
 *  最后一节还会把真实的 assets/avatar.png 解出来，验证碰撞判定用的是真数据。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

require('../game.js');                  // 加载后 game.js 会把 NC 挂到 globalThis 上
const NC = globalThis.NC;

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ------------------------------------------------------------------ *
 * 造一个假造型：w x h 像素，bitmapResolution = res
 * ------------------------------------------------------------------ */
function fakeCostume({ w = 20, h = 20, res = 2, opaque = true } = {}) {
  const alpha = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) alpha[i * 4 + 3] = opaque ? 255 : 0;
  return new NC.Costume({ width: w, height: h, bitmapResolution: res, alpha });
}

/* ------------------------------------------------------------------ *
 * 极简 PNG 解码器（只够用来读测试素材，支持 8bit RGB/RGBA）
 * ------------------------------------------------------------------ */
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, bpp = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      const colorType = data[9];
      if (data[8] !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error('测试用的解码器只支持 8bit RGB/RGBA');
      }
      bpp = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = out[i * bpp];
    rgba[i * 4 + 1] = out[i * bpp + 1];
    rgba[i * 4 + 2] = out[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? out[i * bpp + 3] : 255;
  }
  return { width: w, height: h, data: rgba };
}

/* ================================================================== */
console.log('方向换算（面向...）');
ok('正右 → 90', near(NC.scratchDirection(10, 0), 90), NC.scratchDirection(10, 0));
ok('正上 → 0', near(NC.scratchDirection(0, 10), 0), NC.scratchDirection(0, 10));
ok('正下 → 180', Math.abs(NC.scratchDirection(0, -10)) === 180, NC.scratchDirection(0, -10));
ok('正左 → -90', near(NC.scratchDirection(-5, 0), -90), NC.scratchDirection(-5, 0));
ok('右下 → 135', near(NC.scratchDirection(1, -1), 135), NC.scratchDirection(1, -1));

console.log('移动 10 步');
{
  const s = new NC.Sprite('t', { x: 0, y: 0, direction: 90 });
  s.moveSteps(10); ok('朝右：x +10', near(s.x, 10) && near(s.y, 0), `(${s.x},${s.y})`);
  s.setSize(50); s.direction = 0; s.x = 0; s.y = 0;
  s.moveSteps(10); ok('朝上：y +10', near(s.x, 0) && near(s.y, 10), `(${s.x},${s.y})`);
  s.direction = -90; s.x = 0; s.y = 0;
  s.moveSteps(10); ok('朝左：x -10', near(s.x, -10), `(${s.x},${s.y})`);
}

console.log('左右翻转（旋转模式 = 左右翻转时，direction < 0 才镜像）');
{
  const s = new NC.Sprite('t', { rotationStyle: 'left-right', direction: -8.08 });
  ok('direction = -8.08 → 翻转', s.flipped === true);
  s.direction = 8.08;
  ok('direction = +8.08 → 不翻转', s.flipped === false);
  s.rotationStyle = 'all around';
  ok('其它旋转模式 → 不翻转', s.flipped === false);
}

console.log('碰到鼠标指针（逐像素）');
{
  // 造型逻辑尺寸 10x10，大小 50% → 舞台上 5x5
  const s = new NC.Sprite('t', { x: 0, y: 0, size: 50, rotationStyle: 'left-right', costume: fakeCostume() });
  NC.mouse.x = 0; NC.mouse.y = 0;
  ok('鼠标在正中心 → 碰到', s.touchingMouse() === true);
  NC.mouse.x = 2.4;
  ok('鼠标在 2.4（半宽 2.5 内）→ 碰到', s.touchingMouse() === true);
  NC.mouse.x = 2.6;
  ok('鼠标在 2.6（超出半宽）→ 没碰到', s.touchingMouse() === false);
  NC.mouse.x = 0; NC.mouse.y = 0;

  const hollow = new NC.Sprite('h', { x: 0, y: 0, size: 50, costume: fakeCostume({ opaque: false }) });
  ok('全透明造型 → 碰不到', hollow.touchingMouse() === false);

  // 只有左半边不透明的图，用来验证"镜像"这一下
  const half = new NC.Costume({
    width: 20, height: 20, bitmapResolution: 2,
    alpha: (() => {
      const a = new Uint8ClampedArray(20 * 20 * 4);
      for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) a[(y * 20 + x) * 4 + 3] = 255;
      return a;
    })(),
  });
  const hs = new NC.Sprite('h', { x: 0, y: 0, size: 50, rotationStyle: 'left-right', costume: half });
  NC.mouse.x = -2; NC.mouse.y = 0;
  ok('不透明半边在左，鼠标在左 → 碰到', hs.touchingMouse() === true);
  NC.mouse.x = 2;
  ok('不透明半边在左，鼠标在右 → 碰不到', hs.touchingMouse() === false);
  hs.direction = -45;                       // 朝左 → 镜像
  ok('翻转后鼠标在右 → 碰到', hs.touchingMouse() === true);
  NC.mouse.x = -2;
  ok('翻转后鼠标在左 → 碰不到', hs.touchingMouse() === false);
}

console.log('整段脚本：追鼠标 + 名字跟着跑 + 播声音时卡住');
{
  // 用和真实素材同样尺寸的造型（362x378，两倍图 → 逻辑 181x189，大小 50% → 90.5x94.5）
  const avatar = new NC.Sprite('头像', {
    x: -138.0884639580204, y: -30.642043759657234, size: 50, direction: -8.082065674984023,
    rotationStyle: 'left-right', layerOrder: 1, costume: fakeCostume({ w: 362, h: 378, res: 2 }),
  });
  // 假装这段声音长 1 秒 → 应该卡住 30 帧
  avatar.sound = { duration: 1, currentTime: 0, played: 0, play() { this.played++; return Promise.resolve(); } };
  const name = new NC.Sprite('名字', { x: 0, y: 0, size: 50, layerOrder: 2, text: 'novice' });

  const sim = new NC.Sim();
  sim.add(name).add(avatar);
  sim.greenFlag();
  ok('绿旗后有两个脚本在跑', sim.threads.length === 2 && !sim.threads[0].done);

  NC.mouse.x = 200; NC.mouse.y = 150;              // 鼠标放在右上角
  const dist = () => Math.hypot(NC.mouse.x - avatar.x, NC.mouse.y - avatar.y);
  const d0 = dist();
  sim.step();
  ok('每帧朝鼠标走 10 步', near(dist(), d0 - 10, 1e-9), `${d0.toFixed(3)} → ${dist().toFixed(3)}`);
  sim.step();
  ok('再走 10 步', near(dist(), d0 - 20, 1e-9), dist().toFixed(3));
  ok('「名字」每帧结束时都贴在头像上', near(name.x, avatar.x) && near(name.y, avatar.y),
     `名字(${name.x.toFixed(2)},${name.y.toFixed(2)}) 头像(${avatar.x.toFixed(2)},${avatar.y.toFixed(2)})`);

  // 鼠标挪到头像下方一点点，下一帧必然"追到"
  NC.mouse.x = avatar.x; NC.mouse.y = avatar.y - 3;
  sim.step();                                      // 走 10 步冲过去 → 碰到 → 开始放声音
  ok('追到后开始播声音', avatar.sound.played === 1, 'e.play 调用次数=' + avatar.sound.played);
  const frozen = { x: avatar.x, y: avatar.y, dir: avatar.direction };
  let stillFrozen = 0;
  for (let i = 0; i < 29; i++) {
    sim.step();
    if (near(avatar.x, frozen.x) && near(avatar.y, frozen.y) && avatar.direction === frozen.dir) stillFrozen++;
  }
  ok('声音没放完时脚本卡住（头像不动、也不转向）', stillFrozen === 29, `29 帧里只卡住 ${stillFrozen} 帧`);
  ok('卡住期间「名字」照旧跟着头像', near(name.x, avatar.x) && near(name.y, avatar.y));
  // Scratch 的规矩：声音放完 → 把这一圈「重复执行」走到末尾 → 下一帧才继续动
  let moved = false;
  for (let i = 0; i < 3 && !moved; i++) {
    sim.step();
    moved = !(near(avatar.x, frozen.x) && near(avatar.y, frozen.y));
  }
  ok('放完声音后头像继续动', moved, `(${avatar.x.toFixed(2)},${avatar.y.toFixed(2)})`);
}

console.log('用真实素材 assets/avatar.png 验一遍');
{
  const file = path.join(__dirname, '..', 'assets', 'avatar.png');
  if (!fs.existsSync(file)) {
    console.log('  (跳过：找不到 ' + file + ')');
  } else {
    const png = decodePNG(fs.readFileSync(file));
    ok('PNG 尺寸 362x378', png.width === 362 && png.height === 378, `${png.width}x${png.height}`);
    const costume = new NC.Costume({
      width: png.width, height: png.height, bitmapResolution: 2, alpha: png.data,
    });
    ok('逻辑尺寸 181x189（两倍图缩一半）', near(costume.w, 181) && near(costume.h, 189));
    const s = new NC.Sprite('头像', { x: 0, y: 0, size: 50, rotationStyle: 'left-right', costume });
    NC.mouse.x = 0; NC.mouse.y = 0;
    ok('鼠标压在图片中心 → 碰到', s.touchingMouse() === true);
    NC.mouse.x = 300; NC.mouse.y = 200;
    ok('鼠标在很远的地方 → 碰不到', s.touchingMouse() === false);
    let opaque = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 0) opaque++;
    const ratio = opaque / (png.width * png.height);
    console.log(`  · 不透明像素占 ${(ratio * 100).toFixed(1)}%`);
    ok('alpha 数据看起来正常', ratio > 0.01 && ratio < 1);
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
