// =====================================================================================================================
// draw.js — the camera and the picture.
//
// N.render(ctx, world, opts) draws one 1920 × 1080 frame of the world as it is right now. It never changes the rules.
// The look (Bobo: 就只有白底黑人): white paper, black figures, one black ground line, faint marks under it so you can see
// the camera move.
//
// The camera has its own small state (world.cam) and is stepped once per game step in N.camStep(world), so a replay
// films exactly the same shots.
//
// opts (all optional):
//   fx: { fs, cfg }   the feel effects (fx.js) to apply          zoom, groundY   a tighter view (the video's close-ups)
//   boxes: true       show hurtboxes (blue) and hitboxes (red)    strip: false   hide the frame strip of the current move
//   hud: false        no hp bar / wave counter / CLEAR             pills: false   hide the row of six switches
//   hpbars: false     no hp bars over hurt enemies                 go: false      no "GO →" between waves
// =====================================================================================================================
(function (global) {
  const N = global.NOODLE;
  const C = N.C;
  const VW = 1920, VH = 1080; // the canvas

  // The world is seen at ZOOM× so the figures read on a phone; the ground line sits at GROUND_Y on screen.
  const ZOOM = 1.3, GROUND_Y = 905;
  const OY = GROUND_Y - C.GY * ZOOM; // vertical offset that puts the ground at GROUND_Y
  const WW = VW / ZOOM; //              how much world fits across the screen
  N.VIEW = { w: VW, h: VH, z: ZOOM, oy: OY, ww: WW };

  // A view for a given zoom / ground position (the default one unless opts.zoom / opts.groundY are set).
  N.view = (opts = {}) => {
    const z = opts.zoom || ZOOM, gy = opts.groundY || GROUND_Y;
    return { z, oy: gy - C.GY * z, ww: VW / z };
  };

  // The left edge of the camera for a view. Tighter views (the video's close-ups) lean toward the player, so a locked
  // arena doesn't leave the player off-screen.
  N.camX = (world, view) => {
    const centre = (world.cam ? world.cam.x : 0) + WW / 2;
    if (view.z <= ZOOM + 1e-6) return centre - view.ww / 2;
    const player = world.fighters[0];
    const c = centre + (player.x + (world.cam ? world.cam.look * 0.4 : 0) - centre) * 0.7;
    return c - view.ww / 2;
  };

  const COL = {
    bg: '#ffffff', line: '#111111', mark: '#e6e6e6',
    player: { body: '#111111', back: '#111111', shadow: 'rgba(0,0,0,.10)' },
    enemy: { body: '#111111', back: '#111111', shadow: 'rgba(0,0,0,.10)' },
    hurt: '#2f7fd0', atk: '#e0402f', // debug boxes
  };
  N.COL = COL;
  const FLASH = { body: '#ffffff', back: '#ffffff', shadow: 'rgba(0,0,0,0)' }; // the white pass of the hollow flash

  // language for the few words drawn on the canvas
  N.LANG = N.LANG || 'zh';
  const T = (N.T = (en, zh) => (N.LANG === 'en' ? en : zh));

  // Step the camera: follow the player with a little look-ahead in the facing direction; in an arena, settle on it.
  N.camStep = function (world) {
    const player = world.fighters[0];
    const cam = world.cam || (world.cam = { x: player.x - WW / 2, look: 0 });
    cam.look += (player.face * 150 - cam.look) * 0.04;
    let target = Math.max(world.bounds[0] - 80, Math.min(world.bounds[1] + 80 - WW, player.x + cam.look - WW / 2));
    if (world.lock) target = world.lock[0];
    cam.x += (target - cam.x) * 0.12;
  };

  // white paper, the ground line, and faint marks under it every 160 px
  function backdrop(ctx, camX, shake, view) {
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, VW, VH);
    ctx.save();
    ctx.translate(0, view.oy);
    ctx.scale(view.z, view.z);
    ctx.translate(shake.x, shake.y);
    const width = view.ww;
    ctx.fillStyle = COL.line;
    ctx.fillRect(-100, C.GY, width + 200, 4);
    ctx.fillStyle = COL.mark;
    for (let x = Math.floor(camX / 160) * 160; x < camX + width + 160; x += 160) ctx.fillRect(x - camX, C.GY + 26, 60, 4);
    ctx.restore();
  }

  function rect(ctx, box, fill, stroke) {
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 3;
      ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    }
  }

  // Debug: the player's current (or last) move as a strip, one cell per frame: wind-up grey, active red, recovery dark.
  // (Remembers the last move in opts.last, so pass the same opts object every frame.)
  function frameStrip(ctx, world, opts) {
    const player = world.fighters[0];
    if (player.st === 'attack') opts.last = { move: player.move, t: player.t, until: world.tick + 50 };
    const shown = opts.last;
    if (!shown || world.tick > shown.until) return;
    const move = N.MOVES[shown.move];
    const cells = move.start + move.active + move.rec, cw = 22;
    const x0 = VW / 2 - cells * cw / 2, y0 = VH - 128;
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillStyle = '#555';
    ctx.textAlign = 'left';
    ctx.fillText(`${shown.move === 'LIGHT' ? 'light' : 'heavy'}  ${move.start - 1} + ${move.active} + ${move.rec}`, x0, y0 - 12);
    for (let i = 0; i < cells; i++) {
      const frame = i + 1;
      ctx.fillStyle = frame < move.start ? '#b5b5b5' : frame < move.start + move.active ? COL.atk : '#555';
      ctx.globalAlpha = frame <= shown.t ? 1 : 0.35;
      ctx.fillRect(x0 + i * cw, y0, cw - 3, 30);
    }
    ctx.globalAlpha = 1;
  }

  N.render = function (ctx, world, opts = {}) {
    const view = N.view(opts);
    const camX = Math.round(N.camX(world, view));
    const F = opts.fx;
    const shake = F ? N.fxShake(F.fs, F.cfg) : { x: 0, y: 0 };

    // ① finisher: lean in on the knockout point (scales everything but the HUD)
    const lean = F ? N.fxZoom(F.fs, F.cfg) : 0;
    ctx.save();
    if (lean > 0) {
      const fx = (F.fs.zoom.x - camX) * view.z, fy = view.oy + F.fs.zoom.y * view.z, m = 1 + 0.3 * lean;
      ctx.translate(fx, fy);
      ctx.scale(m, m);
      ctx.translate(-fx, -fy);
    }
    backdrop(ctx, camX, shake, view);

    // the world, in world coordinates
    ctx.save();
    ctx.translate(0, view.oy);
    ctx.scale(view.z, view.z);
    ctx.translate(-camX + shake.x, shake.y);
    if (F) N.fxDrawUnder(ctx, F.fs, F.cfg);
    const order = world.fighters.slice().sort((a, b) => (a.team === 0) - (b.team === 0)); // enemies first, player on top
    for (const fighter of order) {
      const col = fighter.team === 0 ? COL.player : COL.enemy;
      const offset = F ? N.fxOffset(F.fs, F.cfg, fighter) : null;
      if (offset) {
        ctx.save();
        ctx.translate(offset.x, offset.y);
      }
      if (F && F.cfg.on.flash && F.fs.flash[fighter.id] > 0) {
        // ③ flash: a black pass drawn wider, then a white pass on top → a hollow figure.
        // (flashWhite is the video's blooper: white only, which on white paper is invisible)
        if (!F.cfg.p.flashWhite) N.drawFigure(ctx, world, fighter, col, 9);
        N.drawFigure(ctx, world, fighter, FLASH, 0, true);
      } else {
        N.drawFigure(ctx, world, fighter, col);
      }
      if (offset) ctx.restore();
    }
    if (F) N.fxDrawOver(ctx, F.fs, F.cfg);
    if (opts.hpbars !== false) {
      for (const f of world.fighters) {
        if (f.team === 0 || !N.alive(f) || f.hp >= f.maxhp) continue; // hp bars only over hurt enemies
        const x = f.x - 40, y = f.y - 240;
        ctx.fillStyle = '#e6e6e6';
        ctx.fillRect(x, y, 80, 8);
        ctx.fillStyle = f.st === 'ko' ? '#bbb' : '#111';
        ctx.fillRect(x, y, 80 * f.hp / f.maxhp, 8);
      }
    }
    if (opts.boxes) {
      for (const f of world.fighters) rect(ctx, N.hurtbox(f), null, COL.hurt);
      for (const f of world.fighters) {
        const box = N.attackBox(f);
        if (box) rect(ctx, box, 'rgba(255,90,74,.35)', COL.atk);
      }
    }
    ctx.restore();
    ctx.restore();

    // screen space
    if (opts.hud !== false) hud(ctx, world, opts);
    if (F && F.cfg.on.flash && F.fs.impact > 0) { // ③ impact frame: invert the whole picture
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, VW, VH);
      ctx.restore();
    }
    if (F && opts.pills !== false) switchRow(ctx, F.cfg);
    if (opts.strip !== false) frameStrip(ctx, world, opts);
  };

  // The six switches, bottom-right: filled = on.
  function switchRow(ctx, cfg) {
    ctx.font = '600 22px system-ui, "Noto Sans SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const items = N.FX_INFO.map(([key, zh, en], i) => [key, `${i + 1} ${T(en, zh.split(' ')[0])}`]);
    let x = VW - 48;
    const y = VH - 54;
    for (let i = items.length - 1; i >= 0; i--) {
      const [key, label] = items[i];
      const width = ctx.measureText(label).width + 28;
      x -= width;
      const on = cfg.on[key];
      ctx.beginPath();
      ctx.roundRect(x, y - 19, width, 38, 19);
      if (on) {
        ctx.fillStyle = '#111';
        ctx.fill();
      } else {
        ctx.strokeStyle = '#c8c8c8';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = on ? '#fff' : '#aaa';
      ctx.fillText(label, x + 14, y + 1);
      x -= 10;
    }
    ctx.textBaseline = 'alphabetic';
  }

  // HUD: the boss bar (top), player hp + wave counter (bottom-left), "GO →" when the way is open, CLEAR at the end.
  // The top-left corner stays empty (a video platform's watermark sits there).
  function hud(ctx, world, opts = {}) {
    const player = world.fighters[0];
    const boss = world.fighters.find((f) => f.boss && f.st !== 'gone');
    if (boss) {
      const bw = 640, x = VW / 2 - bw / 2, y = 92;
      ctx.fillStyle = '#e6e6e6';
      ctx.fillRect(x, y, bw, 14);
      ctx.fillStyle = '#d9473a';
      ctx.fillRect(x, y, bw * boss.hp / boss.maxhp, 14);
      ctx.font = '700 24px system-ui, "Noto Sans SC", sans-serif';
      ctx.fillStyle = '#111';
      ctx.textAlign = 'center';
      ctx.fillText(T('THE BIG ONE', '大块头'), VW / 2, y - 12);
    }
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(48, VH - 60, 300, 12);
    ctx.fillStyle = '#111';
    ctx.fillRect(48, VH - 60, 300 * player.hp / player.maxhp, 12);
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('HP', 48, VH - 72);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#999';
    ctx.fillText(`${Math.min(world.wave + 1, world.waves.length)} / ${world.waves.length}`, 348, VH - 72);
    if (world.clear) {
      const seconds = (world.clear / 60).toFixed(1);
      ctx.fillStyle = '#111';
      ctx.textAlign = 'center';
      ctx.font = '700 96px system-ui, sans-serif';
      ctx.fillText('CLEAR', VW / 2, 330);
      ctx.font = '500 32px system-ui, sans-serif';
      ctx.fillStyle = '#777';
      ctx.fillText(`${seconds} s · ${T('R to restart', 'R 重开')}`, VW / 2, 384);
    } else if (opts.go !== false && !world.lock && world.wave > 0 && (world.tick >> 4) % 2) {
      ctx.fillStyle = '#111';
      ctx.textAlign = 'right';
      ctx.font = '700 56px system-ui, sans-serif';
      ctx.fillText('GO →', VW - 60, 300);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
