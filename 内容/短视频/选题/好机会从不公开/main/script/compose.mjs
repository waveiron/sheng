import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FONT_SIZE = 66;
const MAX_WIDTH = 960;
const LINE_GAP = FONT_SIZE * 0.32;
const LOGO_WIDTH = 106;
const LOGO_OPACITY = 0.8;
const LOGO_Y = 0.8;
const FADE_IN = 0.18;
const FADE_OUT = 0.18;
const FRAME_W = 1080;
const FRAME_H = 1920;

const timing = JSON.parse(readFileSync(resolve(ROOT, "audio/timestamps.json"), "utf8"));
const shownText = timing.sentences
  .map((sentence) => sentence.chars.map((item) => item.ch).join(""))
  .join("");
const assetRun = spawnSync(
  "/tmp/hf-font/bin/python",
  [
    resolve(ROOT, "script/prepare_assets.py"),
    shownText + " ",
    String(FONT_SIZE),
    String(LOGO_WIDTH),
  ],
  { cwd: ROOT, encoding: "utf8" },
);
if (assetRun.status !== 0) {
  console.error(assetRun.stderr || assetRun.stdout);
  process.exit(1);
}
const prepared = JSON.parse(assetRun.stdout);
if (!prepared.widths) {
  console.error("字体测量失败");
  process.exit(1);
}

const widthOf = (ch) => prepared.widths[ch] ?? FONT_SIZE;
const spaceWidth = widthOf(" ");

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stripTerminalPeriod(text) {
  return text.replace(/[。.](?=$)/u, "");
}

function segmentsOf(text) {
  const body = stripTerminalPeriod(text);
  const parts = [];
  let buf = "";
  for (const ch of body) {
    if (ch === "，" || ch === ",") {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts.map((part, index) => (index > 0 ? part.replace(/^ /u, "") : part));
}

function wrapCharacters(text) {
  const lines = [];
  let line = "";
  let width = 0;
  for (const ch of text) {
    const next = widthOf(ch);
    if (line && width + next > MAX_WIDTH) {
      lines.push(line);
      line = ch;
      width = next;
    } else {
      line += ch;
      width += next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function wordsOf(text) {
  const words = [];
  let buf = "";
  for (const ch of text) {
    if (ch === " ") {
      if (buf) words.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) words.push(buf);
  return words.map((word) => ({
    text: word,
    width: Array.from(word).reduce((sum, ch) => sum + widthOf(ch), 0),
  }));
}

function linePixelWidth(words) {
  return words.reduce((sum, word, index) => sum + word.width + (index ? spaceWidth : 0), 0);
}

function wrapWords(text) {
  const words = wordsOf(text);
  if (!words.length) return [];
  let minLines = 1;
  let width = 0;
  for (const word of words) {
    if (width === 0) {
      width = word.width;
      continue;
    }
    if (width + spaceWidth + word.width > MAX_WIDTH) {
      minLines += 1;
      width = word.width;
    } else {
      width += spaceWidth + word.width;
    }
  }
  let best = null;
  const breaks = [];
  const consider = (cuts) => {
    const lines = [];
    for (let i = 0; i < cuts.length - 1; i++) lines.push(words.slice(cuts[i], cuts[i + 1]));
    if (lines.some((line) => line.length === 0)) return;
    const widths = lines.map(linePixelWidth);
    if (widths.some((value, index) => value > MAX_WIDTH && lines[index].length > 1)) return;
    const mean = widths.reduce((sum, value) => sum + value, 0) / widths.length;
    const variance = widths.reduce((sum, value) => sum + (value - mean) ** 2, 0);
    const spread = Math.max(...widths) - Math.min(...widths);
    if (
      !best ||
      variance < best.variance - 1e-6 ||
      (Math.abs(variance - best.variance) <= 1e-6 && spread < best.spread)
    ) {
      best = { lines, variance, spread };
    }
  };
  const walk = (start) => {
    if (breaks.length === minLines - 1) {
      consider([0, ...breaks, words.length]);
      return;
    }
    for (let index = start; index <= words.length - (minLines - breaks.length); index++) {
      breaks.push(index);
      walk(index + 1);
      breaks.pop();
    }
  };
  if (minLines === 1) consider([0, words.length]);
  else walk(1);
  return (best?.lines || [words]).map((line) => line.map((word) => word.text).join(" "));
}

function layoutSentence(sentence) {
  const parts = segmentsOf(sentence.text);
  const lines = [];
  for (const part of parts) {
    const wrapped = sentence.english ? wrapWords(part) : wrapCharacters(part);
    for (const line of wrapped) lines.push(line);
  }
  return lines;
}

function fades(duration, isLast) {
  let fadeIn = FADE_IN;
  let fadeOut = isLast ? 0 : FADE_OUT;
  if (fadeIn + fadeOut > duration && fadeIn + fadeOut > 0) {
    const scale = duration / (fadeIn + fadeOut);
    fadeIn *= scale;
    fadeOut *= scale;
  }
  return { fadeIn, fadeOut };
}

const duration = timing.duration;
const sentences = timing.sentences.map((sentence, index) => {
  const lines = layoutSentence(sentence);
  const visible = sentence.chars.filter((item) => item.ch !== "，" && item.ch !== "," && item.ch !== "。" && item.ch !== ".");
  const start = visible[0]?.begin ?? sentence.chars[0].begin;
  const next = timing.sentences[index + 1];
  const nextVisible = next?.chars.find((item) => item.ch !== "，" && item.ch !== "," && item.ch !== "。" && item.ch !== ".");
  const end = next ? (nextVisible?.begin ?? next.chars[0].begin) : duration;
  const fade = fades(end - start, !next);
  const timed = sentence.chars.filter((item) => !"，,。.".includes(item.ch));
  const chars = [];
  let cursor = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (lineIndex > 0 && timed[cursor]?.ch === " ") cursor += 1;
    const row = [];
    for (const ch of lines[lineIndex]) {
      const item = timed[cursor];
      if (!item || item.ch !== ch) {
        throw new Error(`排版和文案不一致：${sentence.text}`);
      }
      cursor += 1;
      row.push({ ch, on: item.begin });
    }
    chars.push(row);
  }
  if (cursor !== timed.length) throw new Error(`排版和文案不一致：${sentence.text}`);
  const widths = lines.map((line) => Array.from(line).reduce((sum, ch) => sum + widthOf(ch === " " ? " " : ch), 0));
  return { lines, chars, start, end, ...fade, widths, text: sentence.text };
});

for (const sentence of sentences) {
  for (const width of sentence.widths) {
    if (width > MAX_WIDTH + 0.5) console.log(`超宽 ${width.toFixed(1)} ${sentence.text}`);
  }
}

const lastSpoken = [...timing.sentences[timing.sentences.length - 1].chars].reverse().find((item) => item.spoken);
const htmlLines = sentences
  .map((sentence, index) => {
    const lines = sentence.chars
      .map(
        (line) =>
          `            <div class="line">${line
            .map((item) => `<span class="ch" data-on="${item.on.toFixed(3)}">${escapeHtml(item.ch)}</span>`)
            .join("")}</div>`,
      )
      .join("\n");
    return `        <div id="sentence-${index + 1}" class="clip sentence" data-start="${sentence.start.toFixed(3)}" data-duration="${(sentence.end - sentence.start).toFixed(3)}" data-track-index="2" data-fade-in="${sentence.fadeIn.toFixed(3)}" data-fade-out="${sentence.fadeOut.toFixed(3)}">
          <div class="fade">
            <div class="lines">
${lines}
            </div>
          </div>
        </div>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${FRAME_W}, height=${FRAME_H}" />
    <title>好机会从不公开</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face {
        font-family: "ShengText";
        src: url("asset/font/HiraginoSansGB-W6.otf") format("opentype");
        font-weight: 600;
        font-style: normal;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        margin: 0;
        width: ${FRAME_W}px;
        height: ${FRAME_H}px;
        overflow: hidden;
        background: #000;
      }
      #root {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
      }
      #plate { position: absolute; inset: 0; background: #000; }
      #stage { position: absolute; inset: 0; }
      #logo {
        position: absolute;
        left: 50%;
        top: ${LOGO_Y * 100}%;
        width: ${LOGO_WIDTH}px;
        height: ${prepared.logoHeight}px;
        margin-left: -${LOGO_WIDTH / 2}px;
        margin-top: -${prepared.logoHeight / 2}px;
        opacity: ${LOGO_OPACITY};
      }
      .sentence {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .fade { opacity: 0; }
      .lines {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: ${LINE_GAP}px;
      }
      .line {
        height: ${prepared.lineBox}px;
        line-height: ${prepared.lineBox}px;
        font-family: "ShengText";
        font-weight: 600;
        font-size: ${FONT_SIZE}px;
        font-variant-ligatures: none;
        color: #fff;
        white-space: pre;
      }
      .ch { opacity: 0; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${duration.toFixed(3)}"
      data-width="${FRAME_W}"
      data-height="${FRAME_H}"
      data-fps="30"
    >
      <div id="plate"></div>
      <div id="stage">
        <img id="logo" class="clip" alt="" src="asset/logo.png" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="1" />
${htmlLines}
      </div>
      <audio id="voice" src="audio/voice.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0" data-volume="1"></audio>
    </div>
    <script>
      document.fonts.ready.then(() => {
        const tl = gsap.timeline({ paused: true });
        const lastSound = ${lastSpoken.end.toFixed(3)};
        tl.fromTo("#stage", { opacity: 0 }, { opacity: 1, duration: ${FADE_IN}, ease: "none" }, 0);
        tl.to("#stage", { opacity: 0, duration: ${FADE_OUT}, ease: "none" }, lastSound);
        document.querySelectorAll(".sentence").forEach((clip) => {
          const fade = clip.querySelector(".fade");
          const start = Number(clip.dataset.start);
          const span = Number(clip.dataset.duration);
          const fadeIn = Number(clip.dataset.fadeIn);
          const fadeOut = Number(clip.dataset.fadeOut);
          tl.fromTo(fade, { opacity: 0 }, { opacity: 1, duration: fadeIn, ease: "none", immediateRender: false }, start);
          if (fadeOut > 0) {
            tl.to(fade, { opacity: 0, duration: fadeOut, ease: "none" }, start + span - fadeOut);
          }
        });
        document.querySelectorAll(".ch").forEach((ch) => {
          const on = Number(ch.dataset.on);
          tl.set(ch, { opacity: 0 }, 0);
          tl.set(ch, { opacity: 1 }, on);
        });
        window.__timelines["main"] = tl;
      });
    </script>
  </body>
</html>
`;

writeFileSync(resolve(ROOT, "index.html"), html);
console.log(`duration ${duration.toFixed(3)} lastSound ${lastSpoken.end.toFixed(3)} logoH ${prepared.logoHeight} lineBox ${prepared.lineBox}`);
for (const sentence of sentences) {
  console.log(
    `${sentence.start.toFixed(3)}-${sentence.end.toFixed(3)} fade ${sentence.fadeIn.toFixed(3)}/${sentence.fadeOut.toFixed(3)} lines ${sentence.lines.length} ${sentence.lines.map((line) => line).join(" / ")}`,
  );
}
