# novice追逐赛 · 移植版

把你那个 Scratch 作品（`神经网页源代码v2.sb3`）逐块积木翻译成了 **JavaScript** 和 **Python** 两个版本。
玩法一模一样：头像追着鼠标跑，追到就播一次「凯の音」，`novice` 这行字一直贴着头像。

![截图](preview.png)

---

## 一、先说为什么 GitHub 说你的仓库是 HTML

你的仓库里其实有三个文件：

| 文件 | 大小 | GitHub 怎么算 |
|---|---|---|
| `main.html` | 2,961,795 字节 | **算作 HTML 代码** ← 元凶 |
| `神经网页源代码v2.sb3` | 377,855 字节 | 是 zip 压缩包（二进制），**不计入统计** |
| `README.md` | 123 字节 | 算作文档，**不计入统计** |

`main.html` 不是你自己写的网页，它是**打包机生成的播放器**（文件头写着 `Created with xiaohujing.com.cn`）：
里面塞了整个 Scratch 虚拟机（约 2.3 MB 压缩后的 JS）+ 你的作品（base64 编码后塞在 `<script type="p4-project">` 里）。
真正的代码逻辑只占几百字节，剩下全是引擎。GitHub 按**字节数**猜语言，所以它理所当然是 HTML。

> 我之前已经把 `main.html` 里的作品数据解出来比对过了，它和 `神经网页源代码v2.sb3` 是**同一个工程**（积木完全一致），所以不用担心漏东西。

**想让语言标签不再是 HTML，有两个办法：**

### 办法 1（推荐）：仓库里放真正的源码

把本文件夹里的 `web/`（或 `python/`）放进去，`.js` / `.py` 的字节数就会超过 HTML，GitHub 会显示 JavaScript / Python：

```
你的仓库/
├── 神经网页源代码v2.sb3      ← 原始工程，留着（GitHub 不计入统计）
├── main.html                ← 打包产物，建议删掉或标记为 generated
├── web/                     ← JS 移植版（放这里）
│   ├── index.html
│   ├── game.js
│   └── assets/
└── python/
    └── novice_chase.py
```

顺便还能开 **GitHub Pages**：Settings → Pages → 选 `main` 分支 `/root`（或放 `web/` 的目录），
就能得到一个网址直接玩，比给别人发 3 MB 的 html 好多了。

### 办法 2：只改标签，不动文件

在仓库根目录放一个 `.gitattributes`：

```gitattributes
# 打包机生成的播放器 = 生成物，不计入语言统计
main.html linguist-generated=true

# 想让 sb3 也算进去（可选，GitHub 对二进制文件支持一般）
*.sb3 linguist-detectable=false
```

提交之后语言标签就不再是 100% HTML 了（如果整个仓库只剩它，会变成 "no language"，
所以还是建议配合办法 1）。

---

## 二、怎么跑

### JavaScript 版（`web/`）

```bash
cd web
python -m http.server 8000     # 或者用 VSCode 的 Live Server
# 浏览器打开 http://localhost:8000/
```

点「绿旗」（或按空格）开始。**别直接双击 index.html**：`file://` 下浏览器不允许读图片像素，
「碰到鼠标指针」会退化成矩形判定（功能上有，就是没那么精确）。用本地服务器打开就完全正常。

自带一个不需要浏览器的逻辑自测：

```bash
cd web && node tools/test-sim.js     # 32 项检查：方向换算/移动/翻转/逐像素碰撞/播放声音时卡住
```

### Python 版（`python/`）

```bash
cd python
python novice_chase.py         # 只用标准库 tkinter，不用装任何东西
```

（Windows / macOS / Linux 都行；Windows 用 winsound 播音，macOS 用 afplay，Linux 用 paplay/aplay。）

---

## 三、积木 → 代码 对照表

| Scratch 积木 | JavaScript (`game.js`) | Python (`novice_chase.py`) |
|---|---|---|
| 当绿旗被点击 | `Sim.greenFlag()` | `Game.green_flag()` |
| 重复执行 { … } | `while (true) { … yield; }` | `while True: … yield 1` |
| 将大小设为 (50) % | `sprite.setSize(50)` | `avatar.size = 50` |
| 将旋转模式设为 [左右翻转] | `sprite.rotationStyle = 'left-right'` | `avatar.rotation_style = 'left-right'` |
| 面向 [鼠标指针] | `sprite.pointTowardsMouse()` | `avatar.point_towards_mouse(mouse)` |
| 移动 (10) 步 | `sprite.moveSteps(10)` | `avatar.move_steps(10)` |
| 碰到 [鼠标指针]？ | `sprite.touchingMouse()` | `avatar.touching_mouse(mouse)` |
| 播放声音 [凯の音] 等待播完 | `yield* playSoundUntilDone(sprite)` | `yield from play_sound_until_done(...)` |
| 移到 [头像] | `sprite.goTo(avatar)` | `name.go_to(avatar)` |

「重复执行」在代码里就是 `while` 循环 + 每圈末尾 `yield` 一次，一次 `yield` = 一帧；
「等待播完」是靠 `yield` 若干帧（= 声音时长 × 30）实现的，这样脚本会卡住，和 Scratch 表现一致。

---

## 四、移植时特意对齐的细节

Scratch 的虚拟机源码就在你那个 `main.html` 里，我照着里面的实现来翻译的：

* **舞台 480×360**，原点在正中，x 向右、y 向上；角色坐标、造型"旋转中心"都按原值抄
* **30 帧/秒**（TurboWarp 默认值，虚拟机里就是 `setFramerate(30)`），每帧每个「重复执行」跑一圈
* **左右翻转**：虚拟机里是 `direction < 0 ? -1 : 1`，所以朝左才镜像（不是"朝右才镜像"）
* **碰到鼠标指针**：是逐像素判定（`isTouchingPoint`），鼠标只算一个点；鼠标跑出舞台会被夹到舞台边上
* **图片是"两倍图"**：`bitmapResolution = 2`，所以 362×378 的图在舞台上只占 181×189，再乘大小 50% = 90.5×94.5
* **播放声音等待播完**期间脚本卡住（47 帧 ≈ 1.557 秒），卡住时「名字」照旧跟着头像
* 脚本启动顺序：先「头像」后「名字」，所以每帧「名字」贴的是头像**移动之后**的位置

已经用两种方式验证过：`node tools/test-sim.js`（32 项）以及用 Edge 无头浏览器截图，
和用真实素材独立算出来的坐标相比误差 < 1 个屏幕像素。

---

## 五、素材说明

`assets/avatar.png`（362×378）和 `assets/kai.wav`（48 kHz、1.557 秒）是从你的 `sb3` 里原样抽出来的，
版权归你；`novice` 这行字在原作里是 SVG 造型，移植版直接画文字，字体用 `Marker`（没有就用系统兜底字体）。
