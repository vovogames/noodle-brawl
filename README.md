# 面条人 Noodle Brawl

A tiny black-and-white stick-figure brawler with six game-feel switches — the game from the vovogames episode
“我做了一个面条人游戏：怎么让它打起来“爽”？ / I made a stick-figure brawler. Here’s how it learned to hit hard”.

白底黑线的面条人横版小游戏。规则（伤害、判定框、出招帧数）一个数字都不改，只靠六个开关决定打起来爽不爽：
顿帧、震屏、闪白 + 命中特效、受击形变、击退、声音。先全关打一遍，再一个个打开试试。

**Play:** https://vovogames.github.io/noodleman/

## Controls · 操作
| | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Move 移动 | A / D or ← → | stick / d-pad | ◀ ▶ |
| Jump 跳 | K / Space / W | A | 跳 Jump |
| Jab 轻拳 | J | X | 轻拳 Jab |
| Heavy 重拳 | L | Y | 重拳 Punch |
| Dash 冲刺 | Shift | B / RB | 冲 Dash |
| Switches 开关 | 1–6 | | buttons under the game |
| Restart 重开 | R | Start | |

Five waves, a boss at the end; on a clear you get a score, a grade and a best-five list kept in your browser.
五波敌人，最后有头目；通关后结算评分，填名字记录本机最佳。

## How it's built
Plain JavaScript and Canvas 2D: no dependencies, no build step. Open `index.html` from any static server
(`python3 -m http.server`, then http://localhost:8000).

```
 keyboard / gamepad / touch                        index.html (the loop, input, switches, results)
          │  one input bitmask per step
          ▼
 sim.js   N.step(world, mask)  ──events──►  fx.js    N.fxEvents / N.fxTick   (the six switches; hit-stop holds frames)
 (rules, 60 Hz, deterministic)              sound.js N.Sound()               (switch ⑥, WebAudio, no files)
          │
          ▼
 noodle.js N.update(world)   springs + IK → the noodle body
          │
          ▼
 draw.js  N.render(ctx, world, { fx })   camera, figures, effects, HUD
```

| file | what's in it |
|---|---|
| `sim.js` | **The rules.** Input bits, tuning constants, moves and frame data, fighter types, levels and waves, enemy AI (two attack tokens), hits, knockback distance. Same inputs → same fight. |
| `noodle.js` | **The body.** A target pose per state, a spring per body point (the floppiness), two-bone IK for knees and elbows, limbs drawn as curves; the bend on a hit; the break-apart of a knocked-out enemy. |
| `fx.js` | **The six switches.** Every parameter with its default (`N.FX_PARAMS`). Presentation only: they read the rules' state and never write it. |
| `draw.js` | **The picture.** Camera, paper and ground line, fighters, hit-flash and impact frame, HUD, debug boxes. |
| `sound.js` | **The sounds.** Swing, crack, thump, landing, falling apart — all synthesized. |
| `index.html` | **The page.** Fixed-step loop, input, switch buttons, language, results card and best-five. |

Start reading at `N.step` in `sim.js`, then `N.fxEvents` in `fx.js`. Every file opens with a short guide to itself.

## Credits
Made by vovogames · hi@vovo.games. The game is original; all frame counts and numbers are its own.
Inspired by talks and writing on game feel: Masahiro Sakurai on Creating Games; Squirrel Eiserloh, “Juicing Your Cameras With Math” (GDC 2016);
Jan Willem Nijman, “The Art of Screenshake” (2013); Martin Jonasson & Petri Purho, “Juice it or lose it” (2012); Steve Swink, *Game Feel* (2008);
Thomas Jakobsen, “Advanced Character Physics” (GDC 2001).
