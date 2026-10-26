"""Beat map for the hero video's music: tempo, beats, downbeats, sections, the drop.

    python3 scripts/analyze_music.py public/hero/music.wav src/hero/music.json

Needs librosa (pip install librosa). Scenes read the JSON; nothing in the edit hardcodes a
time the music already knows. Also prints a check: how far each detected beat sits from
the nearest strong onset (the beat tracker's own error), in milliseconds.
"""
import json, sys
import numpy as np, librosa

path, out = sys.argv[1], sys.argv[2]
y, sr = librosa.load(path, sr=22050, mono=True)
dur = len(y) / sr
hop = 256
oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
tempo, beat_frames = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=hop)
beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
tempo = float(np.atleast_1d(tempo)[0])

# Downbeats: the beat phase (mod 4) with the strongest low-end onsets is beat one.
low = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=150, n_mels=32)
strength = low[np.minimum(beat_frames, len(low) - 1)]
phase = int(np.argmax([strength[p::4].mean() for p in range(4)]))
downbeats = beats[phase::4]

# Energy at 10 Hz, for sections and the drop.
rms = librosa.feature.rms(y=y, hop_length=2205)[0]
t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=2205)
db = 20 * np.log10(rms + 1e-9)
def level(a, b):
    m = (t >= a) & (t < b)
    return float(db[m].mean()) if m.any() else -90.0

# Entries: beats where the full band comes back after a gap or break, i.e. the first quarter
# second after the beat is 8 dB or more louder than the 0.6 s before it. The first one is the drop.
entries = [float(b) for b in beats if b > 4 and level(b, b + 0.25) - level(b - 0.6, b) >= 8]
entries = [e for i, e in enumerate(entries) if i == 0 or e - entries[i - 1] > 4]
drop = entries[0]
drop_gain = level(drop, drop + 1.0) - level(drop - 1.0, drop)
bars = [(float(d), level(d, d + 60 / tempo * 4)) for d in downbeats]
body = np.median([l for d, l in bars if d >= drop])
# The end of the music: last time the level is within 20 dB of the body.
loud = t[db > body - 20]
end = float(loud[-1]) if len(loud) else dur

# Self-check: distance from each beat to the nearest onset peak.
onsets = librosa.onset.onset_detect(onset_envelope=oenv, sr=sr, hop_length=hop, units="time")
err = np.array([np.min(np.abs(onsets - b)) for b in beats]) * 1000

data = {
    "source": path.split("/")[-1],
    "duration": round(dur, 3),
    "tempo": round(tempo, 2),
    "beats": [round(float(b), 3) for b in beats],
    "downbeats": [round(float(b), 3) for b in downbeats],
    "drop": round(drop, 3),
    "dropGainDb": round(drop_gain, 1),
    "entries": [round(e, 3) for e in entries],
    "end": round(end, 3),
    "beatOnsetErrorMs": {"median": round(float(np.median(err)), 1), "p90": round(float(np.percentile(err, 90)), 1)},
}
with open(out, "w") as f:
    json.dump(data, f, indent=1)
print(json.dumps({k: v for k, v in data.items() if k not in ("beats", "downbeats")}))
print("first downbeats", data["downbeats"][:6], "beats", len(data["beats"]))
