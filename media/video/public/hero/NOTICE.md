# music.m4a

**What it is.** An instrumental made for the Tabkyra hero video, generated on the maintainer's
own machine with ACE-Step 1.5. It is not a sample or a remix of anyone's recording. The
settings were seed 302, 60 s, no lyrics, and this prompt: "High-energy electronic trap
instrumental, 126 BPM, cinematic brass and synth lead, intro build with riser and filtered
drums, big drop with heavy 808 bass and hard-hitting drums, triumphant launch trailer energy,
steady four-on-the-floor sections, clean final hit, no vocals". It was then trimmed to 57.6 s,
peak-limited, set to about -14 LUFS and encoded as AAC.

**The model.** [ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5/tree/19671f406d603126926c1b7e2adc169acbcade22)
at revision `19671f406d603126926c1b7e2adc169acbcade22`. The repository is MIT-licensed. Every
component the generator loaded ships inside it under that license: the `acestep-v15-turbo`
diffusion model, the `acestep-5Hz-lm-1.7B` planner LM, the VAE and the bundled
`Qwen3-Embedding-0.6B` text encoder. Upstream, Qwen3-Embedding-0.6B is Apache-2.0. The MIT
license places no restriction on what the model generates. The model card, at that revision,
says of its outputs:

> Commercial-Ready: Unlike many models trained on ambiguous datasets, ACE-Step v1.5 is designed
> for creators. You can strictly use the generated music for **commercial purposes**.

([README.md at revision 19671f4](https://huggingface.co/ACE-Step/Ace-Step1.5/blob/19671f406d603126926c1b7e2adc169acbcade22/README.md))

**This file's license.** `music.m4a` is distributed with this repository under the repository's
license, AGPL-3.0, like every other asset in it. The same audio is muxed into `media/hero.mp4`
and `media/hero-vertical.mp4`.

No paid or credit-based service was used to make it.
