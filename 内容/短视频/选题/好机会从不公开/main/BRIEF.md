---
workflow: general-video
flow: automation
storyboard: no
message: "好机会从不公开"
aspect: 1080x1920
language: zh
length: 24s
---

## Intent

把给定文案读成一条竖屏旁白。画面只出现文案里的字，黑底白字，字随声音逐个出现。

## Assets

- `../main.md` — 文案，内容来源
- `meta/logo/build/logo@3x.png` — 标志，裁掉透明边后宽 106
- `audio/voice.wav` — 整篇一次合成的旁白
- `audio/timestamps.json` — 逐字时间，画面按它排

## Customizations

- 声音 longlaobo_v3，模型 cosyvoice-v3-flash，语速 1.3
- 字号 66，Hiragino Sans GB W6，行宽上限 960，行距为字号的 0.32
- 标志中心在画面高度 0.80，不透明度 0.80
- 淡入淡出各 0.18 秒；句号之间的停顿收到 0.30 秒

## Notes

- 只呈现给定文案，不另写口号
- 成片写到 `render/`，不覆盖文案旁边已有的 mp4
- 不提交
