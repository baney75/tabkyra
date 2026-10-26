---
name: video-editing
description: Edit video with ffmpeg - trim, cut and join clips, captions and subtitles, b-roll and picture-in-picture, vertical crops, audio loudness, GIFs and export presets - and check each output with ffprobe and frame grabs. Use when the user asks to trim, cut, join, caption, subtitle, crop, compress or export a video, clip or screen recording, add b-roll, make a vertical short or a GIF, or normalize the audio in a recording.
license: AGPL-3.0
---

# Video editing: plan, cut with ffmpeg, then prove it

The failure this skill prevents is a file that "rendered fine" but has the wrong length,
no audio, black frames or captions out of sync. Every output gets measured and looked at.

## When to use

- Trimming, cutting, joining or reordering video clips from MP4 or MOV files.
- Captions, subtitles, b-roll, a logo or picture-in-picture.
- A vertical short for TikTok or Reels cropped from a widescreen video.
- Export presets and compression for video, or an animated GIF from a few seconds of a clip.
- Quiet or uneven audio in a video or lecture recording.

For motion graphics built in code (Remotion, After Effects), this skill only covers the
final checks and export. Never upload or post a video for the user without their yes.

## Steps

1. **Probe every input.**
   `ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate -of json in.mp4`
   Note duration, resolution, frame rate and whether audio exists.
2. **Write the edit plan.** A table: clip, in point, out point, what happens (cut, caption,
   b-roll), and the target format. Use `HH:MM:SS.mmm` timecodes. Show it to the user if the
   edit is longer than one cut.
3. **Work on copies.** Write every output to a new file name. Never overwrite an input.
4. **Cut.** Frame-accurate, re-encoded:
   `ffmpeg -ss 00:00:02 -to 00:00:06 -i in.mp4 -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k cut.mp4`
   For a fast cut on keyframes only, use `-c copy` and accept up to a second of drift.
5. **Join.** Write `list.txt` with one line per clip, `file 'cut1.mp4'`, then
   `ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4`. Clips must share codec,
   resolution and frame rate. If not, re-encode each with step 4's settings first.
6. **Caption.** Write an `.srt` file: number, `00:00:01,000 --> 00:00:03,000`, text,
   blank line. Check `ffmpeg -hide_banner -filters` for `subtitles`.
   - If present, burn in: `ffmpeg -i in.mp4 -vf "subtitles=cap.srt" -c:a copy subbed.mp4`
   - If not, add a soft track: `ffmpeg -i in.mp4 -i cap.srt -map 0 -map 1 -c:v copy -c:a copy -c:s mov_text soft.mp4`
7. **B-roll or picture-in-picture.** Show the first 3 s of clip 2 at seconds 2 to 5 of the
   main video, bottom right. `trim` picks the b-roll part, and `setpts=...+2/TB` shifts it
   to start at second 2; without the shift, overlay shows the wrong part or a frozen frame:
   `ffmpeg -i main.mp4 -i broll.mp4 -filter_complex "[1:v]trim=start=0:duration=3,setpts=PTS-STARTPTS+2/TB,scale=480:-2[pip];[0:v][pip]overlay=W-w-40:H-h-40:eof_action=pass:enable='between(t,2,5)'[v]" -map "[v]" -map 0:a? -c:v libx264 -crf 18 -c:a copy out.mp4`
   For another window, change `duration`, the `+2` and `between(t,2,5)` together. Grab
   frames just inside the start and end (2.1 s and 4.9 s) and one after (5.1 s) to check.
   For a full-frame cutaway, cut the b-roll to length and join it in step 5.
8. **Vertical short.** Center crop to 9:16:
   `ffmpeg -i in.mp4 -vf "crop=ih*9/16:ih,scale=1080:1920" -c:a copy vertical.mp4`
9. **Export with a preset** from the table below.
10. **Verify length and streams.** Run step 1's `ffprobe` on the output. Duration must
    match the plan within 0.1 s, and the audio stream must exist when the input had one.
11. **Verify loudness** for anything with speech:
    `ffmpeg -hide_banner -i out.mp4 -af ebur128 -f null -` and read `Integrated loudness`.
12. **Look at frames.** A contact sheet:
    `ffmpeg -i out.mp4 -vf "fps=1/5,scale=320:-2,tile=4x3" -frames:v 1 sheet.png`
    and single frames at each cut and caption: `ffmpeg -ss 3 -i out.mp4 -frames:v 1 f3.png`.
    Open the images. Check for black frames, wrong crops and caption timing.
13. **Hand over.** Output path, duration, resolution, size, loudness and the sheet image.

## Export presets

| Target | Command options |
| --- | --- |
| YouTube 1080p | `-c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -af loudnorm=I=-14:TP=-1:LRA=11 -movflags +faststart` |
| Phone or web, small | `-c:v libx264 -preset medium -crf 26 -vf scale=-2:720 -c:a aac -b:a 128k -movflags +faststart` |
| Archive master | `-c:v libx264 -preset slow -crf 14 -c:a pcm_s16le` into `.mov` |
| GIF preview | `-vf "fps=12,scale=480:-2:flags=lanczos" -t 6` into `.gif` |
| Podcast audio only | `-vn -c:a libmp3lame -b:a 160k -af loudnorm=I=-16:TP=-1.5` into `.mp3` |

Check the platform's current upload specs before a final export, for example
`https://support.google.com/youtube/answer/1722171`.

## Done when

- Every output was probed: duration, resolution, frame rate and audio match the plan.
- You looked at the contact sheet and a frame at every cut and caption.
- Speech is near the target loudness (about -14 LUFS for YouTube, -16 for podcasts).
- Inputs are unchanged, and the user has the output paths.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| `No such filter: 'subtitles'` | This ffmpeg lacks libass. Use the soft-track command in step 6, or an ffmpeg build with libass |
| `No option name near` on `subtitles` | Run `ffmpeg -hide_banner -filters` first. No `subtitles` line: same as the row above (ffmpeg 9 prints this message for a missing filter too). Filter present: the path broke the syntax, so copy the .srt to a plain name such as `cap.srt` |
| PiP shows the wrong part of the b-roll or a frozen frame | The b-roll timestamps weren't shifted. Use step 7's `trim` and `setpts` |
| Cut starts with a frozen or black frame | You used `-c copy`. Re-encode as in step 4 |
| Concat fails or audio drifts | Inputs differ. Re-encode all clips to the same settings, then join |
| `height not divisible by 2` | Use `-2` in `scale`, as in the commands above |
| Output has no audio | Add `-map 0:v -map 0:a?` and check the input had audio |
| Upload rejected or looks washed out | Add `-pix_fmt yuv420p` and re-export |

## Safety

- Work only on files the user gave you or names. Don't delete source footage.
- Don't upload, publish or post anywhere without the user's yes for that exact file.
- Footage of other people may be private. Ask before publishing faces or voices of
  people who aren't the user.

## Worked example

The user says: "Cut seconds 12 to 47 from talk.mp4, add these captions and make a YouTube
version."

```
ffprobe ... talk.mp4                  -> 1920x1080, 30 fps, 612 s, aac audio
ffmpeg -ss 00:00:12 -to 00:00:47 -i talk.mp4 -c:v libx264 -crf 18 -c:a aac clip.mp4
ffmpeg -hide_banner -filters          -> no subtitles filter
ffmpeg -i clip.mp4 -i cap.srt -map 0 -map 1 -c:v copy -c:a copy -c:s mov_text clip-cc.mp4
ffmpeg -i clip-cc.mp4 [YouTube preset] -c:s copy clip-yt.mp4
ffprobe ... clip-yt.mp4               -> 35.0 s, 1920x1080, audio present, subtitle track
ffmpeg -hide_banner -i clip-yt.mp4 -af ebur128 -f null -   -> I: -14.1 LUFS
ffmpeg -i clip-yt.mp4 -vf "fps=1/5,scale=320:-2,tile=4x2" -frames:v 1 sheet.png
```

Answer: `clip-yt.mp4`, 35.0 s, 1080p, -14.1 LUFS, soft captions (this ffmpeg can't burn
them in), and the contact sheet path.
