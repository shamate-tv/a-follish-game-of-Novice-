# -*- coding: utf-8 -*-
"""
novice追逐赛 —— Python 移植版（只用标准库 tkinter，不用装任何东西）

原作：Scratch 3 / TurboWarp 作品《神经网页源代码v2.sb3》（作者：shamate-tv）

积木 → 代码 对照表
------------------------------------------------------------------------
    Scratch 积木                        这里的代码
------------------------------------------------------------------------
    当绿旗被点击                        Game.green_flag()
    重复执行 { ... }                    while True: ... ; yield 一帧
    将大小设为 (50) %                   avatar.size = 50
    将旋转模式设为 [左右翻转]            avatar.rotation_style = 'left-right'
    面向 [鼠标指针]                     avatar.point_towards_mouse(mouse)
    移动 (10) 步                        avatar.move_steps(10)
    碰到 [鼠标指针]？                   avatar.touching_mouse(mouse)
    播放声音 [凯の音] 等待播完           yield from play_sound_until_done(...)
    移到 [头像]                         name.go_to(avatar)
------------------------------------------------------------------------

运行：
    python novice_chase.py          # 需要 Python 3.8+，tkinter 是自带的

运行规则和 Scratch 对齐：
    · 舞台 480x360，原点在正中，x 向右、y 向上
    · 30 帧/秒，每帧每个「重复执行」跑一圈
    · 「播放声音...等待播完」期间脚本卡住（头像停在原地）
    · 「碰到鼠标指针」逐像素判定，鼠标只当一个点，跑出舞台就贴在边上
    · 左右翻转：direction < 0（朝左）时图片水平镜像
"""

import math
import os
import shutil
import subprocess
import sys
import time
import tkinter as tk

# ---------------------------------------------------------------- 常量
STAGE_W, STAGE_H = 480, 360        # 舞台尺寸（Scratch 单位）
FPS = 30                           # TurboWarp 默认帧率
STEP_MS = 1000.0 / FPS
SS = 2                             # 画面放大 2 倍：1 个舞台单位 = 2 像素

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
AVATAR_PNG = os.path.join(ASSETS, "avatar.png")
SOUND_WAV = os.path.join(ASSETS, "kai.wav")

FONT_FAMILY = "Marker"             # 原作的 SVG 用的是 Marker 字体，没有的话系统会替换


# ---------------------------------------------------------------- 小工具
def scratch_direction(dx, dy):
    """两个点的位移 → Scratch 方向（0=上、90=右、180/-180=下）"""
    d = 90 - math.degrees(math.atan2(dy, dx))
    return (d + 180) % 360 - 180


def wav_duration(path):
    """读 wav 头算出时长（秒）；读不出来返回 0"""
    try:
        with open(path, "rb") as f:
            data = f.read()
        if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            return 0.0
        pos, rate, channels, bits, nbytes = 12, 0, 0, 0, 0
        while pos + 8 <= len(data):
            cid = data[pos:pos + 4]
            size = int.from_bytes(data[pos + 4:pos + 8], "little")
            body = data[pos + 8:pos + 8 + size]
            if cid == b"fmt " and len(body) >= 16:
                channels = int.from_bytes(body[2:4], "little")
                rate = int.from_bytes(body[4:8], "little")
                bits = int.from_bytes(body[14:16], "little")
            elif cid == b"data":
                nbytes = size
                break
            pos += 8 + size + (size & 1)
        if rate and channels and bits:
            return nbytes / (rate * channels * bits / 8)
    except Exception:
        pass
    return 0.0


def play_sound_async(path):
    """放一次声音就返回，不等它放完（脚本的"等待"靠数帧来做）"""
    try:
        if sys.platform.startswith("win"):
            import winsound
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
            return
        for cmd in (["afplay", path], ["paplay", path],
                    ["aplay", "-q", path],
                    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]):
            if shutil.which(cmd[0]):
                subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
    except Exception:
        pass          # 没有声卡 / 没有播放器也无所谓，脚本照样按时间等


# ---------------------------------------------------------------- 造型
class Costume:
    """造型。photo 是原始分辨率的图，drawn 是画到舞台上用的缩小版。

    bitmapResolution = 2 表示这张图是"两倍图"：显示尺寸要除以 2。
    """

    def __init__(self, photo, bitmap_resolution=1, drawn=None):
        self.photo = photo                     # 原始分辨率（用来做像素级碰撞判定）
        self.res = bitmap_resolution
        self.drawn = drawn or photo            # 画面上用的图
        self.width = photo.width()
        self.height = photo.height()
        self.w = self.width / self.res         # 逻辑尺寸：大小 100% 时占多少舞台单位
        self.h = self.height / self.res

    def is_opaque(self, px, py):
        """这个像素是不是"实心"的（用来实现「碰到鼠标指针」）"""
        if px < 0 or py < 0 or px >= self.width or py >= self.height:
            return False
        try:
            return not self.photo.transparency_get(int(px), int(py))
        except Exception:
            return True                        # 图片没有透明信息时退化成外接框


# ---------------------------------------------------------------- 角色
class Sprite:
    def __init__(self, name, x=0.0, y=0.0, size=100.0, direction=90.0,
                 rotation_style="all around", layer_order=0,
                 costume=None, text=None, font_size=26):
        self.name = name
        self.x, self.y = x, y
        self.size = size
        self.direction = direction
        self.rotation_style = rotation_style
        self.layer_order = layer_order
        self.costume = costume
        self.text = text                       # 文字造型（原作里的「名字」）
        self.font_size = font_size
        self.flipped_image = None              # 镜像图，第一次要用时才做

    @property
    def flipped(self):
        """旋转模式 = 左右翻转 时，朝左（direction < 0）就镜像"""
        return self.rotation_style == "left-right" and self.direction < 0

    # ---- 下面这些就是"积木" ----

    def point_towards_mouse(self, mouse):
        self.direction = scratch_direction(mouse[0] - self.x, mouse[1] - self.y)

    def move_steps(self, steps):
        rad = math.radians(90 - self.direction)   # Scratch 方向 → 数学极角
        self.x += steps * math.cos(rad)
        self.y += steps * math.sin(rad)

    def go_to(self, other):
        self.x, self.y = other.x, other.y

    def touching_mouse(self, mouse):
        """碰到鼠标指针？把鼠标位置换算成造型图片里的像素，看那个点是不是实心"""
        c = self.costume
        if c is None:
            return False
        scale = self.size / 100.0
        px = ((mouse[0] - self.x) / scale + c.w / 2) * c.res    # 图片内的 x
        py = ((self.y - mouse[1]) / scale + c.h / 2) * c.res    # 图片内的 y（从上往下）
        if px < 0 or py < 0 or px >= c.width or py >= c.height:
            return False
        if self.flipped:
            px = c.width - 1 - px
        return c.is_opaque(px, py)

    def make_flipped(self, mirror):
        """做一张左右镜像的图（只做一次，之后一直用）"""
        if self.flipped_image is None:
            self.flipped_image = mirror(self.costume.drawn)
        return self.flipped_image


# ---------------------------------------------------------------- 声音积木
def play_sound_until_done(sound_frames):
    """播放声音 [凯の音] 等待播完 —— 这几帧里脚本卡在原地"""
    play_sound_async(SOUND_WAV)
    for _ in range(sound_frames):
        yield 1


# ---------------------------------------------------------------- 脚本区
def avatar_script(avatar, mouse, sound_frames):
    """角色「头像」的积木：

        当绿旗被点击
          将大小设为 50 %
          将旋转模式设为 [左右翻转]
          重复执行
            面向 [鼠标指针]
            移动 10 步
            如果 <碰到 [鼠标指针]？> 那么
              播放声音 [凯の音] 等待播完
    """
    avatar.size = 50
    avatar.rotation_style = "left-right"
    while True:                                   # 「重复执行」
        avatar.point_towards_mouse(mouse)         # 面向鼠标指针
        avatar.move_steps(10)                     # 移动 10 步
        if avatar.touching_mouse(mouse):          # 如果 碰到鼠标指针？
            yield from play_sound_until_done(sound_frames)
        yield 1                                   # ← 这一帧到此为止


def name_script(name, avatar):
    """角色「名字」的积木：

        当绿旗被点击
          将大小设为 50 %
          重复执行
            移到 [头像]
    """
    name.size = 50
    while True:                                   # 「重复执行」
        name.go_to(avatar)                        # 移到 头像
        yield 1


# ---------------------------------------------------------------- 舞台 / 主程序
class Game:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("novice追逐赛 · Python 移植版")
        self.root.configure(bg="#1d1d21")
        self.root.resizable(False, False)

        self.mouse = [0.0, 0.0]                   # 鼠标（舞台坐标，夹在舞台内）
        self.threads = []                         # 正在跑的脚本
        self.running = False
        self.acc, self.last = 0.0, time.perf_counter()

        # ---- 界面 ----
        self.canvas = tk.Canvas(self.root, width=STAGE_W * SS, height=STAGE_H * SS,
                                bg="white", highlightthickness=0)
        self.canvas.pack(padx=10, pady=(10, 6))
        bar = tk.Frame(self.root, bg="#1d1d21")
        bar.pack(fill="x", padx=10)
        tk.Button(bar, text="🏳 绿旗", command=self.green_flag,
                  bg="#2b6b2b", fg="white", activebackground="#3a8a3a",
                  relief="flat", padx=10).pack(side="left")
        self.status = tk.Label(bar, text="点「绿旗」开始", bg="#1d1d21", fg="#eeeeee")
        self.status.pack(side="left", padx=10)
        tk.Label(self.root, bg="#1d1d21", fg="#aaaaaa", justify="center",
                 text="鼠标跑到哪，「头像」就追到哪；追到你就播一次「凯の音」。\n"
                      "原作是 Scratch 作品《神经网页源代码v2.sb3》，这份代码是逐块积木翻译过来的。"
                 ).pack(pady=(0, 10))

        # ---- 素材 ----
        full = tk.PhotoImage(file=AVATAR_PNG)
        drawn = full.subsample(2)                 # 两倍图 → 画面上再缩一半
        costume = Costume(full, bitmap_resolution=2, drawn=drawn)

        # 初始状态照抄原项目 project.json 里的数值
        self.avatar = Sprite("头像", x=-138.0884639580204, y=-30.642043759657234,
                             size=50, direction=-8.082065674984023,
                             rotation_style="left-right", layer_order=1, costume=costume)
        self.name = Sprite("名字", x=-138.0, y=-30.0, size=50, layer_order=2,
                           text="novice", font_size=52)
        self.sprites = sorted([self.avatar, self.name], key=lambda s: s.layer_order)

        self.sound_frames = round(wav_duration(SOUND_WAV) * FPS)   # 1.557s → 47 帧
        print(f"声音时长 {wav_duration(SOUND_WAV):.3f}s → 播放时脚本卡 {self.sound_frames} 帧")

        # ---- 画面元素（只建一次，之后每帧移动它）----
        self.item_avatar = self.canvas.create_image(0, 0, image=drawn)
        self.item_name = self.canvas.create_text(
            0, 0, text="novice", anchor="center", fill="#000000",
            font=(FONT_FAMILY, -round(52 * 0.5 * SS)))     # 大小 50% → 字号减半
        self.item_cross_h = self.canvas.create_line(0, 0, 0, 0, fill="#ff5050")
        self.item_cross_v = self.canvas.create_line(0, 0, 0, 0, fill="#ff5050")

        # ---- 事件 ----
        self.canvas.bind("<Motion>", self.on_mouse)
        self.canvas.bind("<Button-1>", self.on_mouse)
        self.root.bind("<space>", lambda e: self.green_flag())
        self.root.bind("<Escape>", lambda e: self.root.destroy())

        self.draw()
        self.root.after(16, self.tick)

    # ---- 鼠标 ----
    def on_mouse(self, event):
        sx = event.x / SS - STAGE_W / 2
        sy = STAGE_H / 2 - event.y / SS
        # Scratch 里鼠标跑出舞台就夹在边上
        self.mouse[0] = max(-STAGE_W / 2, min(STAGE_W / 2, sx))
        self.mouse[1] = max(-STAGE_H / 2, min(STAGE_H / 2, sy))

    # ---- 当绿旗被点击 ----
    def green_flag(self):
        self.threads = [
            {"it": avatar_script(self.avatar, self.mouse, self.sound_frames), "done": False},
            {"it": name_script(self.name, self.avatar), "done": False},
        ]
        self.running = True
        self.status.config(text="追逐中…（点绿旗重来）")

    # ---- 一帧 ----
    def step(self):
        for t in self.threads:
            if t["done"]:
                continue
            try:
                next(t["it"])                     # 跑到下一个 yield（= 让出一帧）
            except StopIteration:
                t["done"] = True

    # ---- 画面 ----
    def to_canvas(self, x, y):
        return (x + STAGE_W / 2) * SS, (STAGE_H / 2 - y) * SS

    def mirror(self, photo):
        """左右镜像一张图"""
        w, h = photo.width(), photo.height()
        out = tk.PhotoImage(width=w, height=h)
        for y in range(h):
            row = "{" + " ".join("#%02x%02x%02x" % photo.get(x, y)
                                 for x in range(w - 1, -1, -1)) + "}"
            out.put(row, (0, y))
        return out

    def draw(self):
        for s in self.sprites:
            cx, cy = self.to_canvas(s.x, s.y)
            if s.costume is not None:
                img = s.costume.drawn
                if s.flipped:
                    img = s.make_flipped(self.mirror)
                self.canvas.coords(self.item_avatar, cx, cy)
                self.canvas.itemconfigure(self.item_avatar, image=img)
            elif s.text:
                # 文字造型：字号 = 造型字号 x 大小%
                self.canvas.itemconfigure(
                    self.item_name, font=(FONT_FAMILY, -round(s.font_size * s.size / 100 * SS)))
                self.canvas.coords(self.item_name, cx, cy)
        mx, my = self.to_canvas(self.mouse[0], self.mouse[1])
        self.canvas.coords(self.item_cross_h, mx - 7, my, mx + 7, my)
        self.canvas.coords(self.item_cross_v, mx, my - 7, mx, my + 7)

    # ---- 主循环：按 30 帧/秒推进，和 Scratch 一样 ----
    def tick(self):
        now = time.perf_counter()
        self.acc += min(250.0, (now - self.last) * 1000.0)
        self.last = now
        while self.acc >= STEP_MS:
            self.acc -= STEP_MS
            if self.running:
                self.step()
        self.draw()
        self.root.after(16, self.tick)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    if not os.path.exists(AVATAR_PNG):
        sys.exit("找不到素材：" + AVATAR_PNG)
    if not (sys.version_info >= (3, 8)):
        sys.exit("需要 Python 3.8 或更新版本")
    Game().run()
