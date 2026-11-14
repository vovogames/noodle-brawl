// =====================================================================================================================
// fx.js — the six feel switches.
//
//   ① stop    hit-stop: on a hit both fighters freeze for a few frames (+ the finisher slow-mo on the last knockout)
//   ② shake   screen shake: a push along the punch that snaps back; amount = trauma²
//   ③ flash   the one hit turns hollow for a few frames, an ink hit star, a smear behind the fist (+ the impact frame)
//   ④ bend    the noodle body bends with the hit (springs in noodle.js)
//   ⑤ knock   knockback looks fast-then-bouncy (same end point as the rules), a little hop, dust at the feet
//   ⑥ sound   whoosh / crack / thump (sound.js)
//
// Everything here is presentation. It reads the world and each step's events and never writes battle state
// (positions, hp, states, timers) — test.cjs replays one run with all 64 switch combinations and compares N.hash.
//
// Two clocks:
//   N.fxTick(fs, cfg)                    once per displayed frame (60 Hz), including frozen frames
//   N.fxEvents(fs, world, events, cfg)   after each game step, with that step's events
// Hit-stop and slow-mo are carried out by the caller: while fs.freeze > 0 it skips N.step / N.update for that frame.
//
// cfg = { on: { stop, shake, flash, bend, knock, sound }, p: { …parameters, see FX_PARAMS } }   (N.fxDefaults())
// fs  = the effects' own state (N.fxState()).
// =====================================================================================================================
(function (global) {
  const N = global.NOODLE;
  const C = N.C;

  // the switches: [key, Chinese name, English name], in on-screen order
  N.FX_INFO = [
    ['stop', '顿帧', 'Hit-stop'],
    ['shake', '震屏', 'Screen shake'],
    ['flash', '闪白 + 命中特效', 'Flash + hit marks'],
    ['bend', '受击形变', 'Body bend'],
    ['knock', '击退', 'Knockback'],
    ['sound', '声音', 'Sound'],
  ];

  // tunable parameters: [key, switch, label (for the tuning panel), min, max, step, default]
  N.FX_PARAMS = [
    ['stopL', 'stop', '轻拳停几帧', 0, 20, 1, 4],
    ['stopH', 'stop', '重拳停几帧', 0, 30, 1, 8],
    ['stopKO', 'stop', '击倒停几帧', 0, 40, 1, 14],
    ['jitter', 'stop', '停住时被打的抖（px）', 0, 14, 1, 5],
    ['finish', 'stop', '收尾慢动作：一波最后一个倒下（秒）', 0, 1.5, 0.1, 0.6],
    ['trL', 'shake', '轻拳创伤值', 0, 1, 0.05, 0.25],
    ['trH', 'shake', '重拳创伤值', 0, 1, 0.05, 0.5],
    ['trKO', 'shake', '击倒创伤值', 0, 1, 0.05, 0.75],
    ['shakeMax', 'shake', '最大位移（px）', 0, 80, 1, 26],
    ['shakeDecay', 'shake', '每帧衰减', 0.005, 0.15, 0.005, 0.035],
    ['shakeDir', 'shake', '沿出拳方向的比例', 0, 1, 0.05, 0.7],
    ['flashF', 'flash', '闪白帧数', 0, 8, 1, 3],
    ['impact', 'flash', '冲击帧：击倒时整屏反色（帧）', 0, 6, 1, 2],
    ['star', 'flash', '命中星大小', 0, 2.5, 0.1, 1],
    ['trail', 'flash', '拖影', 0, 1, 1, 1],
    ['bendS', 'bend', '形变强度', 0, 3, 0.1, 1],
    ['soft', 'bend', '受击后身体变软', 0, 1, 0.05, 0.5],
    ['over', 'knock', '击退回弹（越大越弹）', 0, 2, 0.05, 0.6],
    ['hop', 'knock', '重拳把人打离地（px）', 0, 60, 1, 16],
    ['dust', 'knock', '脚下扬尘', 0, 1, 1, 1],
    ['vol', 'sound', '音量', 0, 1, 0.05, 0.8],
  ];

  // all switches off, every parameter at its default
  N.fxDefaults = function () {
    const on = {}, p = {};
    for (const [key] of N.FX_INFO) on[key] = false;
    for (const param of N.FX_PARAMS) p[param[0]] = param[6];
    return { on, p };
  };

  // The effects' state:
  //   t        frames shown;   freeze = frames left to hold (hit-stop / slow-mo);   frozen = id of the fighter that jitters
  //   trauma   0…1, decays every frame;   tdir = direction of the last punch
  //   flash    { id: frames left hollow };   stars / dust = live hit stars and dust puffs;   trails = { id: recent hand points }
  //   kb       { id: { heavy } } knockback style per fighter;   impact = frames of inverted picture left
  //   slow / slowN = slow-mo frames left / total;   zoom = { x, y } the point the finisher leans in on
  N.fxState = () => ({
    t: 0, freeze: 0, frozen: -1, trauma: 0, tdir: 1, flash: {}, stars: [], dust: [], kb: {}, trails: {},
    impact: 0, slow: 0, slowN: 0, zoom: null,
  });

  const isHeavy = (moveName) => N.MOVES[moveName].dmg >= 12;

  // React to one game step's events. snd = a sound player (sound.js) or null.
  N.fxEvents = function (fs, world, events, cfg, snd) {
    const on = cfg.on, p = cfg.p;

    // remember the striking hand for the smear (③), from a few frames before the hit until it ends
    if (on.flash && p.trail) {
      for (const f of world.fighters) {
        if (f.st !== 'attack') continue;
        const move = N.MOVES[f.move];
        if (f.t >= move.start - 3 && f.t < move.start + move.active) {
          const j = N.joints(world, f);
          const hand = move.pose === 'cross' ? j.hB : j.hF;
          (fs.trails[f.id] = fs.trails[f.id] || []).push({ x: hand.x, y: hand.y, t: fs.t, sx: j.sh.x, sy: j.sh.y });
        }
      }
    }

    for (const e of events) {
      if (on.sound && snd) {
        if (e.type === 'swing') snd.swing(isHeavy(e.move), e.id === 0);
        if (e.type === 'land' && e.id === 0) snd.land(e.v);
        if (e.type === 'gone') snd.scatter();
      }
      if (e.type !== 'hit') continue;

      const heavy = isHeavy(e.move);
      const target = world.fighters.find((f) => f.id === e.def);

      // ① hit-stop: hold the picture; a longer stop wins over a shorter one already running
      if (on.stop) {
        const frames = e.ko ? p.stopKO : heavy ? p.stopH : p.stopL;
        if (frames >= fs.freeze) {
          fs.freeze = frames;
          fs.frozen = e.def;
        }
      }
      // ① finisher: the last enemy standing goes down → half speed for p.finish seconds, the camera leans in on the hit
      const lastOneDown = !world.fighters.some((f) => f.team === 1 && N.alive(f));
      if (on.stop && p.finish > 0 && e.ko && e.def !== 0 && lastOneDown) {
        fs.slow = fs.slowN = Math.round(p.finish * 120);
        fs.zoom = { x: e.x, y: e.y };
      }
      // ③ impact frame: the whole picture inverts on a knockout
      if (on.flash && p.impact > 0 && e.ko) fs.impact = p.impact;
      // ② shake: add trauma, remember the punch direction
      if (on.shake) {
        fs.trauma = Math.min(1, fs.trauma + (e.ko ? p.trKO : heavy ? p.trH : p.trL));
        fs.tdir = e.dir;
      }
      // ③ flash + hit star
      if (on.flash) {
        if (p.flashF > 0) fs.flash[e.def] = p.flashF;
        fs.stars.push({ x: e.x, y: e.y, dir: e.dir, big: heavy || e.ko, t: 0, seed: e.tick * 31 + e.def });
      }
      // ④ bend
      if (on.bend && N.bendHit) N.bendHit(world, e.def, e.dir, p.bendS * (heavy ? 1.5 : 1) * (e.ko ? 1.3 : 1), p.soft);
      // ⑤ knockback style + dust
      if (on.knock) {
        fs.kb[e.def] = { heavy: heavy || e.ko };
        if (p.dust && target) fs.dust.push({ x: target.x, dir: e.dir, t: 0, big: heavy || e.ko });
      }
      // ⑥ sound
      if (on.sound && snd) snd.hit(heavy, e.ko, e.def === 0);
    }
  };

  // Advance the effects by one displayed frame.
  N.fxTick = function (fs, cfg) {
    fs.t++;
    if (fs.impact > 0) fs.impact--;
    // slow-mo runs after the hit-stop: every other frame is a held frame (the caller skips the game step while fs.freeze > 0)
    if (fs.slow > 0 && fs.freeze <= 0) {
      fs.slow--;
      if (fs.slow % 2) {
        fs.freeze = 1;
        fs.frozen = -1;
      }
    }
    fs.trauma = Math.max(0, fs.trauma - cfg.p.shakeDecay);
    for (const id in fs.flash) if (--fs.flash[id] <= 0) delete fs.flash[id];
    for (const s of fs.stars) s.t++;
    fs.stars = fs.stars.filter((s) => s.t < 9);
    for (const d of fs.dust) d.t++;
    fs.dust = fs.dust.filter((d) => d.t < 24);
    for (const id in fs.trails) {
      fs.trails[id] = fs.trails[id].filter((point) => fs.t - point.t < 7);
      if (!fs.trails[id].length) delete fs.trails[id];
    }
  };

  // Finisher zoom, 0…1: eases in over the first quarter of the slow-mo and out over the last 30%.
  N.fxZoom = function (fs, cfg) {
    if (!cfg.on.stop || !fs.zoom || fs.slowN <= 0 || fs.slow <= 0) return 0;
    const q = 1 - fs.slow / fs.slowN;
    const smooth = (x) => x * x * (3 - 2 * x);
    return smooth(Math.min(1, q / 0.25)) * (1 - smooth(Math.max(0, (q - 0.7) / 0.3)));
  };

  // Camera shake offset: amplitude = shakeMax × trauma², mostly along the punch direction, smooth pseudo-noise from fs.t
  // (no random numbers, so it replays exactly).
  N.fxShake = function (fs, cfg) {
    const p = cfg.p;
    if (!cfg.on.shake || fs.trauma <= 0) return { x: 0, y: 0 };
    const amp = p.shakeMax * fs.trauma * fs.trauma, t = fs.t;
    const nx = Math.sin(t * 2.3) * 0.6 + Math.sin(t * 3.9 + 1.3) * 0.4;
    const ny = Math.sin(t * 2.9 + 0.7) * 0.6 + Math.sin(t * 4.7 + 2.1) * 0.4;
    return { x: amp * (p.shakeDir * fs.tdir * Math.abs(nx) + (1 - p.shakeDir) * nx), y: amp * 0.55 * ny };
  };

  // Where to draw a fighter relative to where the rules put it:
  //   ⑤ knockback: the rules slide the fighter back with steady deceleration. Here it is drawn on an ease-out-back curve
  //      instead (fast, overshoot, settle) — the difference is added as an offset, which is zero again at the end, so the
  //      end point is the rules' end point. Heavy hits also lift the fighter off the ground a little.
  //   ① the fighter being hit jitters in place while frozen.
  N.fxOffset = function (fs, cfg, fighter) {
    let x = 0, y = 0;
    const p = cfg.p;
    const kb = fs.kb[fighter.id];
    const pushed = fighter.kbn > 0 && fighter.kbi <= fighter.kbn && (fighter.st === 'hurt' || fighter.st === 'ko');
    if (cfg.on.knock && kb && pushed) {
      const u = fighter.kbi / fighter.kbn; // 0…1 through the knockback
      const linear = 1 - (1 - u) ** 2; //   the rules' curve (steady deceleration)
      const c1 = 1.70158 * p.over, c3 = c1 + 1;
      const backOut = 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2; // ease-out-back
      const total = fighter.kbv * (fighter.kbn + 1) / 2; //           the full push distance
      x += (backOut - linear) * total * -fighter.face;
      if (p.kbWrong) x += 2 * linear * total * fighter.face; // film only: the "sign flipped" blooper (flies at the attacker)
      if (kb.heavy) y -= Math.sin(Math.PI * Math.min(1, u * 1.8)) * p.hop;
    }
    if (cfg.on.stop && fs.freeze > 0 && fighter.id === fs.frozen) x += (fs.freeze % 2 ? 1 : -1) * p.jitter;
    return { x, y };
  };

  // Drawn under the fighters (world coordinates): the grey smear behind a punching hand.
  N.fxDrawUnder = function (ctx, fs, cfg) {
    if (!cfg.on.flash || !cfg.p.trail) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const id in fs.trails) {
      const points = fs.trails[id];
      if (points.length < 2) continue;
      ctx.strokeStyle = 'rgba(0,0,0,.13)';
      ctx.lineWidth = 26;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  // Drawn over the fighters (world coordinates): dust puffs (⑤) and ink hit stars (③).
  N.fxDrawOver = function (ctx, fs, cfg) {
    const p = cfg.p;
    ctx.save();
    ctx.lineCap = 'round';

    // dust: three or four soft grey puffs sliding off the feet
    if (cfg.on.knock) {
      for (const d of fs.dust) {
        const k = d.t / 24, puffs = d.big ? 4 : 3;
        ctx.fillStyle = `rgba(0,0,0,${0.12 * (1 - k)})`;
        for (let i = 0; i < puffs; i++) {
          const r = (8 + i * 4) * (0.6 + k) * (d.big ? 1.3 : 1);
          ctx.beginPath();
          ctx.arc(d.x - d.dir * (10 + i * 16) * (0.5 + k), C.GY - r * 0.6 - i * 3, r, 0, 7);
          ctx.fill();
        }
      }
    }

    // hit star: a solid spiky star for frames 0–2, then radial lines flying out (longer on the punch's side), fading
    if (cfg.on.flash && p.star > 0) {
      for (const s of fs.stars) {
        const R = (s.big ? 66 : 44) * p.star, k = s.t / 9;
        const rand = N.rng(s.seed); // same star shape every time this hit is shown
        if (s.t < 3) {
          const outer = R * (0.55 + 0.25 * s.t), inner = outer * 0.38, spikes = s.big ? 10 : 8, a0 = rand() * 6;
          ctx.fillStyle = '#111';
          ctx.beginPath();
          for (let i = 0; i < spikes * 2; i++) {
            const a = a0 + i * Math.PI / spikes;
            const r = i % 2 ? inner : outer * (0.75 + rand() * 0.35);
            ctx[i ? 'lineTo' : 'moveTo'](s.x + Math.cos(a) * r, s.y + Math.sin(a) * r);
          }
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#fff'; // a white hole in the middle
          ctx.beginPath();
          ctx.arc(s.x, s.y, inner * 0.55, 0, 7);
          ctx.fill();
        }
        ctx.strokeStyle = `rgba(17,17,17,${1 - k})`;
        ctx.lineWidth = s.big ? 6 : 4;
        const lines = s.big ? 9 : 6;
        for (let i = 0; i < lines; i++) {
          const a = (i / lines) * Math.PI * 2 + rand() * 0.4;
          const forward = Math.max(0, Math.cos(a) * s.dir);
          const r0 = R * (0.5 + k * 1.2), r1 = r0 + R * (0.3 + 0.5 * forward) * (1 - k);
          ctx.beginPath();
          ctx.moveTo(s.x + Math.cos(a) * r0, s.y + Math.sin(a) * r0);
          ctx.lineTo(s.x + Math.cos(a) * r1, s.y + Math.sin(a) * r1);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  };
})(typeof window !== 'undefined' ? window : globalThis);
