// Synthesized spy soundtrack + event SFX. No external assets, works offline.
export class SpyAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private droneOscs: OscillatorNode[] = [];
  public muted = false;

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * 0.4);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this._startAmbience();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.04);
    }
  }

  private _startAmbience(): void {
    if (!this.ctx || !this.master) return;
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = 0.05;
    g.connect(this.master);

    const o1 = c.createOscillator();
    const o2 = c.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = 55;
    o2.type = 'sine';
    o2.frequency.value = 82.5;

    const lfo = c.createOscillator();
    const lg = c.createGain();
    lfo.frequency.value = 0.08;
    lg.gain.value = 0.025;
    lfo.connect(lg);
    lg.connect(g.gain);

    o1.connect(g);
    o2.connect(g);
    o1.start();
    o2.start();
    lfo.start();
    this.droneOscs = [o1, o2, lfo];
  }

  private _tone(
    freq: number,
    dur: number,
    type: OscillatorType = 'sine',
    gain = 0.2,
    slide: number | null = null,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master) return;
    const c = this.ctx;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) {
      o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private _burst(freq: number, dur: number, gain: number, q = 1): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const c = this.ctx;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  footstep(run: boolean): void {
    this._burst(run ? 260 : 180, run ? 0.10 : 0.13, run ? 0.22 : 0.13, 1.2);
  }

  pickup(): void {
    this._tone(660, 0.12, 'triangle', 0.22);
    this._tone(990, 0.20, 'triangle', 0.18, null, 0.09);
  }

  unlock(): void {
    [523, 659, 784, 1046].forEach((f, i) => this._tone(f, 0.26, 'triangle', 0.16, null, i * 0.08));
  }

  alert(intensity: number): void {
    this._tone(880 + intensity * 260, 0.09, 'square', 0.10 + intensity * 0.06);
  }

  ui(): void {
    this._tone(420, 0.05, 'square', 0.07);
  }

  win(): void {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      this._tone(f, 0.42, 'triangle', 0.2, null, i * 0.11),
    );
  }

  lose(): void {
    [440, 349, 262, 175].forEach((f, i) =>
      this._tone(f, 0.5, 'sawtooth', 0.16, f * 0.7, i * 0.14),
    );
  }

  dispose(): void {
    for (const o of this.droneOscs) {
      try {
        o.stop();
      } catch {
        // already stopped
      }
    }
    this.droneOscs = [];
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.master = null;
  }
}
