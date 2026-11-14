// =====================================================================================================================
// sound.js — switch ⑥: every sound is synthesized with WebAudio, there are no audio files.
//
// A hit has three layers: 呼 the swing (filtered noise sweeping up), 啪 the contact crack (a short bright burst) and
// 咚 the body thump (a low sine falling in pitch). Each hit is pitched a little differently, or a combo sounds like a
// machine gun. (The video renders the same recipes offline in numpy: pipeline/audio/sfx.py, gswing / ghit.)
//
//   const snd = NOODLE.Sound();   snd.unlock()   — call from a click / key press (browsers only allow audio after one)
//   snd.swing(heavy, isPlayer)   snd.hit(heavy, knockout, playerWasHit)   snd.land(speed)   snd.scatter()   snd.vol = 0…1
// =====================================================================================================================
(function (global) {
  const N = global.NOODLE;

  N.Sound = function () {
    let audio = null, out = null, noise = null;
    const S = { vol: 0.8 };

    // Create the audio context on first use: a master gain and one second of white noise (seeded, looped by bursts).
    function context() {
      if (!audio) {
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        if (!AudioCtx) return null;
        audio = new AudioCtx();
        out = audio.createGain();
        out.connect(audio.destination);
        noise = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
        const data = noise.getChannelData(0);
        let s = 7;
        for (let i = 0; i < data.length; i++) {
          s = (s * 16807) % 2147483647;
          data[i] = s / 1073741823.5 - 1;
        }
      }
      if (audio.state === 'suspended') audio.resume();
      out.gain.value = S.vol;
      return audio;
    }

    // volume envelope: silent → `peak` after `attack` seconds → fades out by `dur`
    function envelope(gainNode, t, attack, peak, dur) {
      gainNode.gain.setValueAtTime(0, t);
      gainNode.gain.linearRampToValueAtTime(peak, t + attack);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }

    // filtered noise whose filter frequency sweeps from f0 to f1
    function burst({ dur, f0, f1, type = 'bandpass', q = 1, gain = 0.5, a = 0.002, delay = 0 }) {
      const ctx = context();
      if (!ctx) return;
      const t = ctx.currentTime + delay;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.Q.value = q;
      filter.frequency.setValueAtTime(f0, t);
      filter.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      envelope(g, t, a, gain, dur);
      src.connect(filter).connect(g).connect(out);
      src.start(t, Math.random() * 0.5); // start somewhere in the noise, so bursts don't sound identical
      src.stop(t + dur + 0.02);
    }

    // a tone whose pitch glides from f0 to f1
    function tone({ f0, f1, dur, gain = 0.5, type = 'sine', a = 0.002, delay = 0 }) {
      const ctx = context();
      if (!ctx) return;
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      envelope(g, t, a, gain, dur);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }

    S.unlock = () => context();

    // 呼 the swing: heavier = lower and longer; the player's own swings are a bit louder than the enemies'
    S.swing = (heavy, mine) =>
      burst(heavy
        ? { dur: 0.24, f0: 380, f1: 1500, q: 1.2, gain: mine ? 0.32 : 0.2, a: 0.06 }
        : { dur: 0.12, f0: 900, f1: 2600, q: 1.4, gain: mine ? 0.22 : 0.14, a: 0.03 });

    // 啪 + 咚 a hit; when the player is the one hit it sounds duller (no bright crack on top); a knockout adds a deep boom
    S.hit = (heavy, ko, toPlayer) => {
      const v = 0.92 + Math.random() * 0.16; // ±8% pitch, different every hit
      if (!toPlayer) burst({ dur: (heavy ? 0.07 : 0.045) / v, f0: 3200 * v, f1: 1400 * v, type: 'highpass', q: 0.7, gain: heavy ? 0.7 : 0.5 });
      burst({ dur: (heavy ? 0.12 : 0.07) / v, f0: 1400 * v, f1: 500 * v, q: 0.9, gain: toPlayer ? 0.45 : 0.55 });
      tone({ f0: (heavy ? 130 : 190) * v, f1: (heavy ? 42 : 80) * v, dur: heavy ? 0.26 : 0.11, gain: heavy ? 0.95 : 0.55 });
      if (ko) {
        tone({ f0: 70, f1: 34, dur: 0.45, gain: 0.8, delay: 0.01 });
        burst({ dur: 0.3, f0: 600, f1: 120, type: 'lowpass', gain: 0.4, delay: 0.02 });
      }
    };

    // landing from a jump: a soft low tap, louder the harder you land
    S.land = (speed) => tone({ f0: 90, f1: 45, dur: 0.07, gain: Math.min(0.35, speed / 70) });

    // a knocked-out enemy falling apart: five tiny dry clicks
    S.scatter = () => {
      for (let i = 0; i < 5; i++) burst({ dur: 0.03, f0: 2400 + i * 300, f1: 1800, q: 3, gain: 0.12, delay: i * 0.045 });
    };

    return S;
  };
})(typeof window !== 'undefined' ? window : globalThis);
