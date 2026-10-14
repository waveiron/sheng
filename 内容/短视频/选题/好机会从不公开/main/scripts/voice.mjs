import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const COPY_PATH = resolve(
  import.meta.dirname,
  "../../main.md",
);
const OUT_DIR = resolve(import.meta.dirname, "../audio");
const ENV_PATH = "/Users/hailang/code_base/role2/server/.env";
const ENDPOINTS = [
  "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
  "wss://maas.qwencloudapi.com/api-ws/v1/inference/",
];

const SAMPLE_RATE = 24000;
const SPEECH_RATE = 1.3;
const LEAD_SILENCE = 0.18;
const PRE_ROLL = 0.03;
const TAIL = 0.55;
const PAUSE_PERIOD = 0.3;
const PAUSE_INNER = 0.14;

const PUNCT = new Set(
  Array.from("，。,.!！?？、；;：: \t\n\r　"),
);

function loadKey() {
  const text = readFileSync(ENV_PATH, "utf8");
  const line = text.split(/\n/).find((row) => row.startsWith("api_key_dashscope="));
  if (!line) throw new Error("本机配置里没有 api_key_dashscope");
  const key = line.slice("api_key_dashscope=".length).trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("api_key_dashscope 是空的");
  return key;
}

function parseCopy(raw) {
  const text = raw.replace(/\r\n/g, "\n").trim();
  const sentences = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "\n") {
      if (buf.trim() === "") continue;
      buf += "";
      continue;
    }
    buf += ch;
    if (ch === "。" || ch === ".") {
      const sentence = buf.replace(/^[ \t　]+/, "").replace(/[ \t　]+$/, "");
      if (sentence) sentences.push(sentence);
      buf = "";
    }
  }
  const rest = buf.replace(/^[ \t　]+/, "").replace(/[ \t　]+$/, "");
  if (rest) sentences.push(rest);
  return sentences;
}

function isEnglish(sentence) {
  return sentence.endsWith(".");
}

function joinForSpeech(sentences) {
  let out = "";
  for (let i = 0; i < sentences.length; i++) {
    if (i > 0 && (isEnglish(sentences[i - 1]) || isEnglish(sentences[i]))) out += " ";
    out += sentences[i];
  }
  return out;
}

function redact(message, key) {
  return String(message).split(key).join("[redacted]");
}

function synthesize(text, key, url) {
  return new Promise((resolvePromise, reject) => {
    const taskId = randomUUID();
    const chunks = [];
    const sentenceEnds = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      fail(new Error("合成超时"));
    }, 120000);

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      fail(new Error(`连接失败 ${url}`));
    });
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            model: "cosyvoice-v3-flash",
            parameters: {
              text_type: "PlainText",
              voice: "longlaobo_v3",
              format: "pcm",
              sample_rate: SAMPLE_RATE,
              volume: 50,
              rate: SPEECH_RATE,
              pitch: 1,
              enable_ssml: false,
              word_timestamp_enabled: true,
            },
            input: {},
          },
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        const buf = Buffer.from(event.data);
        chunks.push(buf);
        bytes += buf.length;
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const header = message.header || {};
      if (header.event === "task-started") {
        ws.send(
          JSON.stringify({
            header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
            payload: { input: { text } },
          }),
        );
        ws.send(
          JSON.stringify({
            header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
            payload: { input: {} },
          }),
        );
        return;
      }
      if (header.event === "result-generated") {
        const output = message.payload?.output;
        if (output?.type === "sentence-end") {
          sentenceEnds.push({
            index: output.sentence?.index ?? sentenceEnds.length,
            originalText: output.original_text || "",
            words: output.sentence?.words || [],
            audioBytes: bytes,
          });
        }
        return;
      }
      if (header.event === "task-finished") {
        clearTimeout(timer);
        ws.close();
        if (settled) return;
        settled = true;
        resolvePromise({ pcm: Buffer.concat(chunks), sentenceEnds });
        return;
      }
      if (header.event === "task-failed") {
        clearTimeout(timer);
        ws.close();
        fail(new Error(redact(header.error_message || header.error_code || "task-failed", key)));
      }
    });
  });
}

function wordsToTimeline(sentenceEnds) {
  const words = [];
  let offset = 0;
  let absolute = true;
  for (let i = 0; i < sentenceEnds.length; i++) {
    const sentence = sentenceEnds[i];
    const list = sentence.words || [];
    if (i > 0 && list.length && list[0].begin_time < 50) absolute = false;
  }
  if (!absolute) {
    for (let i = 0; i < sentenceEnds.length; i++) {
      const list = sentenceEnds[i].words || [];
      for (const word of list) {
        words.push({
          text: word.text || "",
          begin: (offset + word.begin_time) / 1000,
          end: (offset + word.end_time) / 1000,
        });
      }
      const last = list[list.length - 1];
      const spokenEnd = last ? last.end_time : 0;
      const byteEnd = sentenceEnds[i].audioBytes;
      const prevBytes = i === 0 ? 0 : sentenceEnds[i - 1].audioBytes;
      const audioSeconds = (byteEnd - prevBytes) / (SAMPLE_RATE * 2);
      offset += Math.max(spokenEnd, Math.round(audioSeconds * 1000));
    }
    return { words, absolute: false };
  }
  for (const sentence of sentenceEnds) {
    for (const word of sentence.words || []) {
      words.push({
        text: word.text || "",
        begin: word.begin_time / 1000,
        end: word.end_time / 1000,
      });
    }
  }
  return { words, absolute: true };
}

function align(tts, words) {
  const apiChars = [];
  for (const word of words) {
    const chars = Array.from(word.text);
    if (!chars.length) continue;
    const span = (word.end - word.begin) / chars.length;
    chars.forEach((ch, index) => {
      apiChars.push({
        ch,
        begin: word.begin + span * index,
        end: word.begin + span * (index + 1),
      });
    });
  }
  const result = Array.from(tts).map((ch) => ({
    ch,
    begin: null,
    end: null,
    spoken: !PUNCT.has(ch),
  }));
  let cursor = 0;
  for (const item of result) {
    while (cursor < apiChars.length && PUNCT.has(apiChars[cursor].ch) && apiChars[cursor].ch !== item.ch) {
      cursor += 1;
    }
    if (cursor < apiChars.length && apiChars[cursor].ch === item.ch) {
      item.begin = apiChars[cursor].begin;
      item.end = apiChars[cursor].end;
      item.spoken = !PUNCT.has(item.ch);
      cursor += 1;
    }
  }
  let prevEnd = 0;
  for (const item of result) {
    if (item.begin == null) {
      item.begin = prevEnd;
      item.end = prevEnd;
    } else {
      prevEnd = item.end;
    }
  }
  const unmatched = result.filter((item) => item.spoken && item.begin === item.end).length;
  return { chars: result, apiChars, unmatchedSpoken: unmatched, consumed: cursor };
}

function groupSentences(sentences, chars) {
  const grouped = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const expected = Array.from(sentence);
    const slice = chars.slice(cursor, cursor + expected.length);
    if (slice.map((item) => item.ch).join("") !== sentence) {
      throw new Error(`分句对齐失败：${sentence}`);
    }
    cursor += expected.length;
    grouped.push({
      text: sentence,
      english: isEnglish(sentence),
      endsWithPeriod: sentence.endsWith("。") || sentence.endsWith("."),
      chars: slice,
    });
  }
  if (cursor !== chars.length) throw new Error("分句后仍有剩余字符");
  return grouped;
}

function spokenSpan(chars) {
  const spoken = chars.filter((item) => item.spoken && item.end > item.begin);
  if (!spoken.length) return null;
  return { begin: spoken[0].begin, end: spoken[spoken.length - 1].end };
}

function shiftAfter(sentences, time, delta) {
  for (const sentence of sentences) {
    for (const item of sentence.chars) {
      if (item.begin > time + 1e-6) item.begin += delta;
      if (item.end > time + 1e-6) item.end += delta;
    }
  }
}

function editPcm(pcm, sentences) {
  let samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const gaps = [];
  for (let i = 0; i < sentences.length - 1; i++) {
    const left = spokenSpan(sentences[i].chars);
    const right = spokenSpan(sentences[i + 1].chars);
    if (!left || !right) continue;
    gaps.push({
      from: left.end,
      to: right.begin,
      target: sentences[i].endsWithPeriod ? PAUSE_PERIOD : PAUSE_INNER,
    });
  }
  for (let i = gaps.length - 1; i >= 0; i--) {
    const gap = gaps[i];
    const start = Math.round(gap.from * SAMPLE_RATE);
    const end = Math.round(gap.to * SAMPLE_RATE);
    const have = Math.max(0, end - start);
    const want = Math.round(gap.target * SAMPLE_RATE);
    const deltaSamples = have - want;
    if (deltaSamples === 0) continue;
    const at = start + Math.floor(have / 2);
    if (deltaSamples > 0) {
      const remove = Math.min(deltaSamples, have);
      const next = new Int16Array(samples.length - remove);
      next.set(samples.subarray(0, at), 0);
      next.set(samples.subarray(at + remove), at);
      samples = next;
      shiftAfter(sentences, at / SAMPLE_RATE, -remove / SAMPLE_RATE);
    } else {
      const insert = -deltaSamples;
      const next = new Int16Array(samples.length + insert);
      next.set(samples.subarray(0, at), 0);
      next.set(samples.subarray(at), at + insert);
      samples = next;
      shiftAfter(sentences, at / SAMPLE_RATE - 1e-9, insert / SAMPLE_RATE);
    }
  }

  const first = sentences.map((sentence) => spokenSpan(sentence.chars)).find(Boolean);
  const last = [...sentences].reverse().map((sentence) => spokenSpan(sentence.chars)).find(Boolean);
  if (!first || !last) throw new Error("没有可对齐的发音");

  const firstSample = Math.round(first.begin * SAMPLE_RATE);
  const keep = Math.round(PRE_ROLL * SAMPLE_RATE);
  if (firstSample > keep) {
    const remove = firstSample - keep;
    const trimmed = new Int16Array(samples.length - remove);
    trimmed.set(samples.subarray(remove), 0);
    samples = trimmed;
    for (const sentence of sentences) {
      for (const item of sentence.chars) {
        item.begin -= remove / SAMPLE_RATE;
        item.end -= remove / SAMPLE_RATE;
      }
    }
  } else if (firstSample < keep) {
    const insert = keep - firstSample;
    const next = new Int16Array(samples.length + insert);
    next.set(samples, insert);
    samples = next;
    for (const sentence of sentences) {
      for (const item of sentence.chars) {
        item.begin += insert / SAMPLE_RATE;
        item.end += insert / SAMPLE_RATE;
      }
    }
  }

  const lastAfterHead = [...sentences].reverse().map((sentence) => spokenSpan(sentence.chars)).find(Boolean);
  const lastSample = Math.round(lastAfterHead.end * SAMPLE_RATE);
  const tailSamples = Math.round(TAIL * SAMPLE_RATE);
  const wantLength = lastSample + tailSamples;
  if (samples.length > wantLength) samples = samples.subarray(0, wantLength);
  if (samples.length < wantLength) {
    const next = new Int16Array(wantLength);
    next.set(samples, 0);
    samples = next;
  }

  const lead = Math.round(LEAD_SILENCE * SAMPLE_RATE);
  const withLead = new Int16Array(samples.length + lead);
  withLead.set(samples, lead);
  for (const sentence of sentences) {
    let prevEnd = null;
    for (const item of sentence.chars) {
      item.begin += LEAD_SILENCE;
      item.end += LEAD_SILENCE;
      if (!item.spoken) {
        const mark = prevEnd == null ? item.begin : prevEnd;
        item.begin = mark;
        item.end = mark;
      } else {
        prevEnd = item.end;
      }
    }
  }
  return withLead;
}

function wavBytes(samples) {
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.concat([header, body]);
}

async function main() {
  const key = loadKey();
  const sentences = parseCopy(readFileSync(COPY_PATH, "utf8"));
  const tts = joinForSpeech(sentences);
  console.log(`sentences ${sentences.length} ttsChars ${Array.from(tts).length}`);
  let synthesized = null;
  let usedUrl = "";
  let lastError = null;
  for (const url of ENDPOINTS) {
    try {
      synthesized = await synthesize(tts, key, url);
      usedUrl = url;
      break;
    } catch (error) {
      lastError = error;
      console.log(`endpoint failed ${url} ${redact(error.message, key)}`);
    }
  }
  if (!synthesized) throw lastError || new Error("合成失败");
  console.log(`endpoint ${usedUrl} pcmBytes ${synthesized.pcm.length} sentencesReturned ${synthesized.sentenceEnds.length}`);
  for (const sentence of synthesized.sentenceEnds) {
    const words = sentence.words || [];
    const first = words[0];
    const last = words[words.length - 1];
    console.log(
      `seg ${sentence.index} bytes ${sentence.audioBytes} words ${words.length} t0 ${first?.begin_time} t1 ${last?.end_time} text ${sentence.originalText}`,
    );
  }
  const timeline = wordsToTimeline(synthesized.sentenceEnds);
  console.log(`timestamps ${timeline.absolute ? "absolute" : "relative"} words ${timeline.words.length}`);
  const aligned = align(tts, timeline.words);
  console.log(`aligned consumed ${aligned.consumed}/${aligned.apiChars.length} flatSpoken ${aligned.unmatchedSpoken}`);
  if (aligned.unmatchedSpoken > 0) {
    throw new Error(`有 ${aligned.unmatchedSpoken} 个发音字没有对上时间戳`);
  }
  const grouped = groupSentences(sentences, aligned.chars);
  const samples = editPcm(synthesized.pcm, grouped);
  mkdirSync(OUT_DIR, { recursive: true });
  const wavPath = resolve(OUT_DIR, "voice.wav");
  writeFileSync(wavPath, wavBytes(samples));
  const duration = samples.length / SAMPLE_RATE;
  const payload = {
    voice: "longlaobo_v3",
    model: "cosyvoice-v3-flash",
    speechRate: SPEECH_RATE,
    sampleRate: SAMPLE_RATE,
    duration,
    leadSilence: LEAD_SILENCE,
    preRoll: PRE_ROLL,
    tail: TAIL,
    pausePeriod: PAUSE_PERIOD,
    pauseInner: PAUSE_INNER,
    sentences: grouped.map((sentence) => ({
      text: sentence.text,
      english: sentence.english,
      endsWithPeriod: sentence.endsWithPeriod,
      chars: sentence.chars.map((item) => ({
        ch: item.ch,
        begin: round3(item.begin),
        end: round3(item.end),
        spoken: item.spoken && item.end > item.begin,
      })),
    })),
  };
  writeFileSync(resolve(OUT_DIR, "timestamps.json"), JSON.stringify(payload, null, 2));
  const first = payload.sentences[0].chars.find((item) => item.spoken);
  const lastSentence = payload.sentences[payload.sentences.length - 1];
  const last = [...lastSentence.chars].reverse().find((item) => item.spoken);
  console.log(`wav ${wavPath} duration ${duration.toFixed(3)} first ${first.begin} last ${last.end}`);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "合成失败");
  process.exit(1);
});
