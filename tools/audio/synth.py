#!/usr/bin/env python3
"""Render tools/audio/gen_corpus.mjs items to audio (numpy only) + room/noise/MP3 augmentation.

    nice -n 10 python3 tools/audio/synth.py tools/audio/corpus [--only dev,holdout] [--force]

Timbres (additive / physical-ish, 22050 Hz mono):
  piano    inharmonic partials f_n = n f0 sqrt(1 + B n^2), two detuned strings, per-partial exponential decay
           (faster for high partials and high notes), hammer noise, damper release
  epiano   FM-like tine: carrier + decaying 1:1 and 14:1 modulation, bell attack
  organ    drawbar partials (1, 2, 3, 4, 6, 8), fast ADSR, slight key click
  strings  band-limited saw with delayed vibrato (5.5 Hz), slow bow attack, bow noise
  voice    glottal harmonics through vowel formants (a/o/e/u), onset scoop, vibrato, breath noise
  flute    1st-3rd harmonics + breathy band noise, light vibrato
  clarinet odd-harmonic reed spectrum
Augmentation per item (spec "aug"): synthetic room IR (RT60, wet), white/pink noise at an SNR, MP3 round trip via
ffmpeg (bitrate), gain. The MP3 output is re-aligned to the original by cross-correlation so the ground-truth
times stay exact. Writes <id>.wav (16-bit PCM, 22050 Hz mono).
"""
import json, os, sys, subprocess, tempfile, wave, zlib
import numpy as np

SR = 22050


def hz(p):
    return 440.0 * 2 ** ((p - 69) / 12)


def env_adsr(n, a, d, s, r_start, r, sr=SR):
    t = np.arange(n) / sr
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = np.clip((t - r_start) / max(r, 1e-4), 0, None)
    return e * np.exp(-5 * rel) * (t < r_start + 2 * r + 0.5)


def partials(f0, amps, n, t, phase_rng, detune_cents=0.0, vib=None, decays=None, inharm=0.0):
    out = np.zeros(n)
    inst = np.ones(n) if vib is None else vib
    for k, a in enumerate(amps, start=1):
        fk = f0 * k * np.sqrt(1 + inharm * k * k) * 2 ** (detune_cents / 1200)
        if fk >= SR / 2 - 200 or a <= 0:
            continue
        ph = 2 * np.pi * np.cumsum(fk * inst) / SR + phase_rng.random() * 6.283
        part = a * np.sin(ph)
        if decays is not None:
            part *= np.exp(-t / decays[k - 1])
        out += part
    return out


def render_note(inst, p, dur, vel, rng):
    f0 = hz(p)
    v = vel / 127.0
    tail = {'piano': 1.2, 'epiano': 0.9, 'organ': 0.08, 'strings': 0.25, 'voice': 0.12, 'flute': 0.1, 'clarinet': 0.1}[inst]
    n = int((dur + tail) * SR)
    t = np.arange(n) / SR
    if inst == 'piano':
        nh = int(min(24, (SR / 2 - 500) / f0))
        bright = 0.6 + 0.8 * v
        amps = [(1 / k ** 1.1) * np.exp(-k / (6 * bright)) for k in range(1, nh + 1)]
        tau0 = np.clip(4.0 * (261.6 / f0) ** 0.6, 0.4, 9.0)
        decays = [tau0 / (1 + 0.25 * (k - 1) * (f0 / 300) ** 0.3) for k in range(1, nh + 1)]
        B = 4e-5 * (f0 / 100) ** 1.2
        y = partials(f0, amps, n, t, rng, 0.6, decays=decays, inharm=B) + partials(f0, amps, n, t, rng, -0.6, decays=decays, inharm=B)
        y += 0.03 * rng.standard_normal(n) * np.exp(-t / 0.01)       # hammer
        damp = np.where(t < dur, 1.0, np.exp(-(t - dur) / (0.07 + 0.25 * (f0 < 110))))
        y *= damp * (0.4 + 0.6 * v)
    elif inst == 'epiano':
        mod = 1.2 * np.exp(-t / 0.4) * v
        bell = 0.3 * np.exp(-t / 0.05)
        y = np.sin(2 * np.pi * f0 * t + mod * np.sin(2 * np.pi * f0 * t) + bell * np.sin(2 * np.pi * 14 * f0 * t))
        y *= np.exp(-t / np.clip(2.5 * (261.6 / f0) ** 0.5, 0.4, 5)) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.12)) * (0.4 + 0.6 * v)
    elif inst == 'organ':
        amps = [1, 0.7, 0.45, 0.35, 0, 0.2, 0, 0.15]
        y = partials(f0, amps, n, t, rng) * env_adsr(n, 0.012, 0.05, 0.9, dur, 0.04)
        y += 0.02 * rng.standard_normal(n) * np.exp(-t / 0.005)
    elif inst == 'strings':
        nh = int(min(30, (SR / 2 - 500) / f0))
        vib = 1 + 0.009 * np.sin(2 * np.pi * 5.5 * t + rng.random() * 6) * np.clip((t - 0.2) / 0.3, 0, 1)
        y = partials(f0, [1 / k for k in range(1, nh + 1)], n, t, rng, vib=vib) * env_adsr(n, 0.09, 0.2, 0.85, dur, 0.12)
        y += 0.01 * rng.standard_normal(n) * env_adsr(n, 0.05, 0.1, 0.5, dur, 0.1)
    elif inst == 'voice':
        vowels = {'a': (800, 1150, 2900), 'o': (450, 800, 2830), 'e': (400, 2000, 2550), 'u': (350, 600, 2700)}
        F = vowels[rng.choice(list(vowels))]
        nh = int(min(40, (SR / 2 - 500) / f0))
        amps = []
        for k in range(1, nh + 1):
            fk = k * f0
            g = sum(np.exp(-0.5 * ((fk - Fi) / (80 + 0.06 * Fi)) ** 2) * w for Fi, w in zip(F, (1.0, 0.6, 0.25)))
            amps.append((0.15 + g) / k ** 0.9)
        scoop = 1 - 0.025 * np.exp(-t / 0.05) * (rng.random() < 0.7)
        vib = scoop * (1 + 0.017 * np.sin(2 * np.pi * (5.0 + rng.random()) * t + rng.random() * 6) * np.clip((t - 0.25) / 0.4, 0, 1))
        y = partials(f0, amps, n, t, rng, vib=vib) * env_adsr(n, 0.04, 0.15, 0.85, dur, 0.06)
        y += 0.015 * rng.standard_normal(n) * env_adsr(n, 0.03, 0.1, 0.6, dur, 0.05)
    elif inst == 'flute':
        vib = 1 + 0.006 * np.sin(2 * np.pi * 5 * t) * np.clip((t - 0.3) / 0.3, 0, 1)
        y = partials(f0, [1, 0.25, 0.1, 0.04], n, t, rng, vib=vib) * env_adsr(n, 0.05, 0.1, 0.9, dur, 0.05)
        noise = rng.standard_normal(n)
        noise = np.convolve(noise, np.ones(4) / 4, mode='same')
        y += 0.04 * noise * env_adsr(n, 0.02, 0.08, 0.5, dur, 0.05)
    else:  # clarinet
        nh = int(min(20, (SR / 2 - 500) / f0))
        y = partials(f0, [(1 / k if k % 2 else 0.08 / k) for k in range(1, nh + 1)], n, t, rng) * env_adsr(n, 0.03, 0.1, 0.9, dur, 0.05)
    return y * (0.35 + 0.65 * v)


def room_ir(rt60, rng):
    n = int(rt60 * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-6.9 * t / rt60)
    ir[: int(0.005 * SR)] *= 0.2
    lp = np.exp(-t / (rt60 / 3))          # later reflections duller
    ir = ir * (0.5 + 0.5 * lp)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    return ir


def fftconv(x, h):
    n = len(x) + len(h) - 1
    N = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, N) * np.fft.rfft(h, N), N)[:len(x)]


def write_wav(path, y):
    pcm = np.clip(y * 32767, -32768, 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def read_wav(path):
    with wave.open(path, 'rb') as w:
        return np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(np.float64) / 32768


def mp3_roundtrip(y, kbps):
    with tempfile.TemporaryDirectory() as d:
        a, b, c = os.path.join(d, 'a.wav'), os.path.join(d, 'b.mp3'), os.path.join(d, 'c.wav')
        write_wav(a, y)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', a, '-codec:a', 'libmp3lame', '-b:a', f'{kbps}k', b], check=True)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', b, '-ac', '1', '-ar', str(SR), c], check=True)
        z = read_wav(c)
    # re-align (decoder delay handling differs between tools): lag maximising the correlation within ±3000 samples
    seg = slice(SR // 2, min(len(y), len(z), SR * 6))
    best, lag = -1e9, 0
    for L in range(-3000, 3001, 1):
        if seg.start + L < 0:
            continue
        v = float(np.dot(y[seg], z[seg.start + L: seg.stop + L])) if seg.stop + L <= len(z) else -1e9
        if v > best:
            best, lag = v, L
    z = z[lag:] if lag >= 0 else np.concatenate([np.zeros(-lag), z])
    out = np.zeros(len(y)); m = min(len(y), len(z)); out[:m] = z[:m]
    return out, lag


def render_item(it):
    rng = np.random.default_rng(zlib.crc32(it['id'].encode()))
    notes = it['notes']
    end = max(n['t'] + n['d'] for n in notes) + 2.0
    y = np.zeros(int(end * SR) + SR)
    inst = it['instrument']
    for n in notes:
        s = render_note(inst, n['p'], n['d'], n['v'], rng)
        i = int(round(n['t'] * SR))
        y[i:i + len(s)] += s[: len(y) - i]
    y /= (np.max(np.abs(y)) + 1e-9)
    aug = it['aug']
    if aug.get('reverb'):
        wet = fftconv(y, room_ir(aug['reverb'], rng))
        y = (1 - aug['wet']) * y + aug['wet'] * wet / (np.max(np.abs(wet)) + 1e-9)
    if aug.get('snr') is not None:
        noise = rng.standard_normal(len(y))
        if rng.random() < 0.5:   # pink-ish
            noise = np.cumsum(noise); noise -= np.convolve(noise, np.ones(64) / 64, mode='same')
        p_sig = np.mean(y[np.abs(y) > 1e-3] ** 2) if np.any(np.abs(y) > 1e-3) else 1e-6
        noise *= np.sqrt(p_sig / (10 ** (aug['snr'] / 10)) / (np.mean(noise ** 2) + 1e-12))
        y = y + noise
    y = y / (np.max(np.abs(y)) + 1e-9) * aug.get('gain', 0.8)
    lag = 0
    if aug.get('mp3'):
        y, lag = mp3_roundtrip(y, aug['mp3'])
    return y, lag


def main():
    d = sys.argv[1]
    only = None
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
    force = '--force' in sys.argv
    idx = json.load(open(os.path.join(d, 'index.json')))
    done = 0
    for e in idx:
        if only and e['split'] not in only:
            continue
        out = os.path.join(d, e['id'] + '.wav')
        if os.path.exists(out) and not force:
            continue
        it = json.load(open(os.path.join(d, e['id'] + '.json')))
        y, lag = render_item(it)
        write_wav(out, y)
        done += 1
        print(f"{e['id']} {it['instrument']} {len(y) / SR:.1f}s lag={lag}", flush=True)
    print('rendered', done)


if __name__ == '__main__':
    main()
