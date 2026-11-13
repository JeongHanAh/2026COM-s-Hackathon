import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const localTools = fileURLToPath(new URL('../.tools/', import.meta.url));
const windows = process.platform === 'win32';
const suffix = windows ? '.exe' : '';
const outputTypes = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  txt: 'text/plain; charset=utf-8',
  zip: 'application/zip',
};
export const recordingLimits = Object.freeze({
  audio: Object.freeze({ maxMs: 10000, minMs: 1, toleranceMs: 250 }),
  video: Object.freeze({ maxMs: 3000, minMs: 100, toleranceMs: 1500 }),
});
const failedTranscript = { status: 'failed', text: '' };
const subtitleFontCandidates = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf',
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
  '/System/Library/Fonts/AppleSDGothicNeo.ttc',
];

function mediaError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function programName(command) {
  return command && /[\\/]/.test(command) ? resolve(command) : command;
}

function ffmpegProgram(name) {
  const encoder = programName(process.env.FFMPEG_PATH);
  const configured = name === 'ffmpeg' ? encoder : programName(process.env.FFPROBE_PATH);
  const sibling = name === 'ffprobe' && isAbsolute(encoder ?? '')
    ? join(dirname(encoder), `${name}${suffix}`)
    : null;
  const bundled = join(localTools, 'ffmpeg', `${name}${suffix}`);
  return configured || [sibling, bundled].find((file) => file && existsSync(file)) || name;
}

function whisperPrograms() {
  const folder = join(localTools, 'whisper');
  const command = programName(process.env.WHISPER_COMMAND || process.env.WHISPER_PATH) ||
    findWhisperCommand(folder) || 'whisper-cli';
  const model = (process.env.WHISPER_MODEL && resolve(process.env.WHISPER_MODEL)) ||
    ['ggml-base.bin', 'ggml-base-q8_0.bin', 'ggml-base-q5_1.bin', 'ggml-tiny.bin']
    .map((name) => join(folder, name)).find((file) => existsSync(file));
  return { command, model };
}

function findWhisperCommand(folder) {
  const direct = join(folder, `whisper-cli${suffix}`);
  if (existsSync(direct)) return direct;
  const extracted = join(folder, 'bin');
  if (!existsSync(extracted)) return undefined;
  const cli = readdirSync(extracted, { recursive: true, withFileTypes: true })
    .find((entry) => entry.isFile() && entry.name === `whisper-cli${suffix}`);
  return cli && join(cli.parentPath, cli.name);
}

async function run(program, args, options = {}) {
  try {
    return await exec(program, args, {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const unavailable = ['ENOENT', 'EACCES', 3221225781, -1073741515].includes(error.code);
    throw mediaError(
      unavailable ? 'MEDIA_UNAVAILABLE' : 'MEDIA_FAILED',
      unavailable ? '미디어 처리 프로그램을 찾을 수 없습니다.' : '미디어 파일을 처리하지 못했습니다.',
      error,
    );
  }
}

function ffmpeg(args, options) {
  return run(ffmpegProgram('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], options);
}

function ffprobe(args) {
  return run(ffmpegProgram('ffprobe'), ['-v', 'error', ...args]);
}

async function withScratch(task) {
  const directory = await mkdtemp(join(tmpdir(), 'our-days-media-'));
  try {
    return await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const recordKind = (record) => record.kind ?? record.type;

async function inspect(file) {
  const { stdout } = await ffprobe([
    '-show_entries', 'stream=codec_type,codec_name,duration:format=format_name,duration',
    '-of', 'json', file,
  ]);
  return JSON.parse(stdout);
}

async function packetDuration(file, kind) {
  // A MediaRecorder WebM can omit a duration and still contain timed packets.
  const { stdout } = await ffprobe([
    '-select_streams', kind === 'video' ? 'v:0' : 'a:0', '-show_entries',
    'packet=pts_time,duration_time', '-of', 'csv=p=0', file,
  ]);
  let start = Infinity;
  let end = -Infinity;
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [timestamp, length] = line.split(',').map(Number);
    if (!Number.isFinite(timestamp)) continue;
    start = Math.min(timestamp, start);
    end = Math.max(timestamp + (Number.isFinite(length) ? length : 0), end);
  }
  return end - Math.max(0, start);
}

async function getDuration(info, file, kind) {
  const stream = info.streams.find((item) => item.codec_type === kind);
  const declared = [stream?.duration, info.format?.duration].map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (kind === 'video' && declared.length) return declared[0];

  const measured = await packetDuration(file, kind);
  if (kind === 'video') return measured;
  // Verify the packet span even when audio metadata claims a shorter duration.
  if (!Number.isFinite(measured) || measured <= 0) return NaN;
  return Math.max(measured, ...declared);
}

export async function validateMedia(file, kind) {
  try {
    const info = await inspect(file);
    const streams = info.streams ?? [];
    const formats = (info.format?.format_name ?? '').split(',');
    const hasVideo = streams.some((stream) => stream.codec_type === 'video');
    const audioTracks = streams.filter((stream) => stream.codec_type === 'audio').length;
    if ((kind === 'audio' && (audioTracks !== 1 || hasVideo)) || (kind === 'video' && !hasVideo)) {
      throw mediaError('BAD_MEDIA', '선택한 기록 종류와 미디어 파일이 일치하지 않습니다.');
    }
    const durationMs = Math.round(await getDuration(info, file, kind) * 1000);
    const { maxMs, minMs, toleranceMs } = recordingLimits[kind];
    if (!Number.isFinite(durationMs) || durationMs < minMs || durationMs > maxMs + toleranceMs) {
      throw mediaError('BAD_MEDIA', '기록의 길이를 확인해 주세요.');
    }
    if (formats.includes('webm')) return { durationMs, mimeType: `${kind}/webm` };
    if (formats.includes('mp4')) return { durationMs, mimeType: `${kind}/mp4` };
    if (formats.includes('ogg')) return { durationMs, mimeType: `${kind}/ogg` };
    if (formats.includes('wav') && kind === 'audio') return { durationMs, mimeType: 'audio/wav' };
    if (formats.includes('mp3') && kind === 'audio') return { durationMs, mimeType: 'audio/mpeg' };
    throw mediaError('BAD_MEDIA', '지원하지 않는 미디어 형식입니다.');
  } catch (error) {
    if (['BAD_MEDIA', 'MEDIA_UNAVAILABLE'].includes(error.code)) throw error;
    throw mediaError('BAD_MEDIA', '미디어 파일을 읽을 수 없습니다.', error);
  }
}

export async function getMediaCapabilities() {
  const { command, model } = whisperPrograms();
  const [encoder, probe, recognizer] = await Promise.allSettled([
    run(ffmpegProgram('ffmpeg'), ['-version']),
    run(ffmpegProgram('ffprobe'), ['-version']),
    model && existsSync(model) ? run(command, ['--help']) : null,
  ]);
  const conversion = encoder.status === 'fulfilled' && probe.status === 'fulfilled';
  const recognized = recognizer.status === 'fulfilled' && recognizer.value !== null;
  return { conversion, transcription: conversion && recognized };
}

export async function transcribeAudio(file) {
  const { command, model } = whisperPrograms();
  if (!model) return { ...failedTranscript };

  try {
    return await withScratch(async (directory) => {
      const wav = join(directory, 'speech.wav');
      const output = join(directory, 'transcript');
      await ffmpeg(['-i', file, '-map', '0:a:0', '-t', '10', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      await run(command, ['-m', model, '-f', 'speech.wav', '-l', 'auto', '-otxt', '-of', 'transcript', '-np'], { cwd: directory });
      const text = (await readFile(`${output}.txt`, 'utf8')).trim();
      const containsWords = /[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)/g, ''));
      return containsWords ? { status: 'ready', text } : { ...failedTranscript };
    });
  } catch {
    return { ...failedTranscript };
  }
}

function localTimestamp(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const { year, month, day, hour, minute, second } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function makeText(records, timeZone) {
  const sentences = new Intl.Segmenter('ko', { granularity: 'sentence' });
  const lines = [];
  for (const record of records) {
    const prefix = `[${localTimestamp(record.capturedAt, timeZone)}] ${record.authorName} — `;
    const transcript = typeof record.transcript === 'string' ? record.transcript : record.transcript?.text;
    const status = record.transcript?.status;
    if (!transcript?.trim() || (status && status !== 'ready' && status !== 'edited')) {
      const pending = status === 'pending' || status === 'processing';
      lines.push(`${prefix}${pending ? '[인식 대기]' : '[인식 실패]'}`);
      continue;
    }
    for (const { segment } of sentences.segment(transcript.trim())) {
      const line = segment.replace(/\s+/g, ' ').trim();
      if (line) lines.push(`${prefix}${line}`);
    }
  }
  return Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
}

async function normalizeAudio(record, output, codec = 'pcm_s16le') {
  await ffmpeg([
    // The duration option is a ceiling. Short recordings end with their source stream.
    '-i', record.path, '-map', '0:a:0', '-vn', '-t', String(recordingLimits.audio.maxMs / 1000), '-c:a', codec,
    '-ar', '48000', '-ac', '2', ...(codec === 'aac' ? ['-b:a', '128k', '-movflags', '+faststart'] : []), output,
  ]);
}

async function concatList(directory, names) {
  await writeFile(join(directory, 'sequence.txt'), names.map((name) => `file '${name}'`).join('\n'));
  return 'sequence.txt';
}

async function makeAudio(records, directory) {
  const names = [];
  for (const record of records) {
    const name = `voice-${names.length}.wav`;
    await normalizeAudio(record, join(directory, name));
    names.push(name);
  }
  const output = join(directory, 'recordings.m4a');
  await ffmpeg([
    '-f', 'concat', '-safe', '1', '-i', await concatList(directory, names), '-vn',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
  ], { cwd: directory });
  return readFile(output);
}

let encoderCommand;
let encoderChoice;

async function h264Encoder() {
  const program = ffmpegProgram('ffmpeg');
  if (program !== encoderCommand) {
    encoderCommand = program;
    encoderChoice = run(program, ['-hide_banner', '-encoders']).then(({ stdout }) => {
      if (/\blibx264\s/.test(stdout)) return ['-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'veryfast', '-crf', '22'];
      if (/\blibopenh264\s/.test(stdout)) return ['-c:v', 'libopenh264', '-profile:v', 'constrained_baseline', '-b:v', '1200k'];
      throw mediaError('MEDIA_UNAVAILABLE', 'FFmpeg에서 H.264 인코더를 찾을 수 없습니다.');
    }).catch((error) => {
      encoderCommand = undefined;
      throw error;
    });
  }
  return encoderChoice;
}

const frame = '720x960';
const frameRate = '24';

async function voiceCard(record, directory, timeZone) {
  const date = localTimestamp(record.capturedAt, timeZone).slice(0, 10).replaceAll('-', '. ');
  const output = join(directory, 'voice-card.png');
  const author = record.authorName;
  if (windows) {
    const script = await readFile(new URL('./media-card.ps1', import.meta.url), 'utf8');
    const dataFile = join(directory, 'voice-card.json');
    await writeFile(dataFile, JSON.stringify({ date, author, output }), 'utf8');
    await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { env: { ...process.env, OUR_DAYS_CARD_DATA: dataFile } });
    return output;
  }

  const font = process.env.MEDIA_KOREAN_FONT || subtitleFontCandidates.find((candidate) => existsSync(candidate));
  if (!font) throw mediaError('MEDIA_UNAVAILABLE', '음성 화면에 사용할 한글 글꼴을 찾을 수 없습니다.');
  await Promise.all([
    copyFile(font, join(directory, 'voice-font')),
    writeFile(join(directory, 'voice-author.txt'), author),
    writeFile(join(directory, 'voice-date.txt'), date),
    writeFile(join(directory, 'voice-label.txt'), '목소리 기록'),
  ]);
  const drawText = (file, size, color, y) =>
    `drawtext=fontfile=voice-font:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=${color}:x=(w-tw)/2:y=${y}`;
  const filters = [
    'drawbox=x=96:y=166:w=528:h=628:color=0xfffbf3:t=fill',
    drawText('voice-label.txt', 27, '0x817268', 347),
    drawText('voice-author.txt', 52, '0x284339', 439),
    drawText('voice-date.txt', 29, '0x817268', 528),
  ].join(',');
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=0xf3ece2:s=${frame}`, '-vf', filters, '-frames:v', '1', '-threads', '1', output], { cwd: directory });
  return output;
}

async function normalizeVideo(record, output, directory, timeZone) {
  const kind = recordKind(record);
  const info = await inspect(record.path);
  const duration = Math.min(await getDuration(info, record.path, kind), recordingLimits[kind].maxMs / 1000);
  const encoder = await h264Encoder();
  let input;
  let videoFilter;
  let timing;
  if (kind === 'audio') {
    input = ['-loop', '1', '-framerate', frameRate, '-i', await voiceCard(record, directory, timeZone), '-i', record.path, '-map', '0:v:0', '-map', '1:a:0'];
    videoFilter = 'setsar=1';
    timing = ['-shortest'];
  } else {
    const withAudio = info.streams.some((stream) => stream.codec_type === 'audio');
    const audioInput = withAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
    input = ['-i', record.path, ...audioInput, '-map', '0:v:0', '-map', withAudio ? '0:a:0' : '1:a:0'];
    videoFilter = 'scale=720:960:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:960:(ow-iw)/2:(oh-ih)/2:color=0x221f1c,setsar=1';
    timing = ['-af', 'apad'];
  }
  if (!Number.isFinite(duration) || duration <= 0) throw mediaError('BAD_MEDIA', '기록의 길이를 확인할 수 없습니다.');
  await ffmpeg([
    '-filter_threads', '2', ...input, '-vf', `${videoFilter},fps=${frameRate}`, ...timing,
    '-t', duration.toFixed(3), ...encoder, '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', output,
  ]);
}

async function makeVideo(records, directory, timeZone) {
  const names = [];
  for (const record of records) {
    const name = `part-${names.length}.mp4`;
    await normalizeVideo(record, join(directory, name), directory, timeZone);
    names.push(name);
  }
  const output = join(directory, 'film.mp4');
  await ffmpeg([
    '-f', 'concat', '-safe', '1', '-i', await concatList(directory, names),
    '-c', 'copy', '-movflags', '+faststart', output,
  ], { cwd: directory });
  return readFile(output);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

function zipFiles(files) {
  const content = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    crc = (crc ^ 0xffffffff) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    content.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.reduce((length, entry) => length + entry.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...content, ...directory, end]);
}

const result = (data, extension) => ({ data, extension, contentType: outputTypes[extension] });

export async function renderArchive(records, { format, includeAudio = true, timeZone = 'Asia/Seoul' }) {
  if (!Object.hasOwn(outputTypes, format)) throw mediaError('BAD_FORMAT', '지원하지 않는 파일 형식입니다.');
  const ordered = [...records].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const audio = ordered.filter((record) => recordKind(record) === 'audio');
  const video = includeAudio ? ordered : ordered.filter((record) => recordKind(record) === 'video');
  if ((format === 'mp4' && !video.length) ||
      (['txt', 'm4a'].includes(format) && !audio.length) || (format === 'zip' && !ordered.length)) {
    throw mediaError('EMPTY_EXPORT', '선택한 기간에 이 파일에 포함할 기록이 없습니다.');
  }
  if (format === 'txt') return result(makeText(audio, timeZone), format);
  return withScratch(async (directory) => {
    if (format === 'm4a') return result(await makeAudio(audio, directory), format);
    if (format === 'mp4') return result(await makeVideo(video, directory, timeZone), format);

    const files = [];
    if (video.length) files.push({ name: '우리의-일상.mp4', data: await makeVideo(video, directory, timeZone) });
    if (audio.length) {
      files.push({ name: '목소리.m4a', data: await makeAudio(audio, directory) });
      files.push({ name: '목소리.txt', data: makeText(audio, timeZone) });
    }
    return result(zipFiles(files), format);
  });
}

export async function renderIndividualAudio(record) {
  if (recordKind(record) !== 'audio') throw mediaError('BAD_MEDIA', '음성 기록만 내려받을 수 있습니다.');
  return withScratch(async (directory) => {
    const file = join(directory, 'voice.m4a');
    await normalizeAudio(record, file, 'aac');
    return result(await readFile(file), 'm4a');
  });
}
