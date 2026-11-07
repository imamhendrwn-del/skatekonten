// Render halaman 3D jadi MP4 9:16 lengkap dengan suara.
// Cara kerja: audio dirender offline di dalam halaman, lalu tiap frame di-screenshot
// pada waktu yang pasti (bukan rekam layar), jadi hasilnya tajam dan tidak patah-patah.
//
// Pakai:  node render.js
// Opsional lewat env: SPOT="Kolong Cawang" HANDLE="@akunlo" W=1080 H=1920 FPS=30 OUT=out/video.mp4

import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const W = Number(process.env.W) || 1080;
const H = Number(process.env.H) || 1920;
const FPS = Number(process.env.FPS) || 30;
const TOTAL = 30; // detik, harus sama dengan 5 adegan x 6 detik di index.html
const OUT = process.env.OUT || 'out/skatepark.mp4';
const TMP = OUT.replace(/\.mp4$/, '') + '.tmp.mp4';
const WAV = path.join(path.dirname(OUT), 'audio.wav');

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const params = new URLSearchParams({ render: '1' });
if (process.env.SPOT) params.set('spot', process.env.SPOT);
if (process.env.HANDLE) params.set('handle', process.env.HANDLE);
const url = pathToFileURL(path.resolve('index.html')).href + '?' + params.toString();

const threeJs = fs.readFileSync('node_modules/three/build/three.min.js');

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Three.js diambil dari node_modules, bukan dari internet
    if (req.url().includes('three.js/r128/three.min.js')) {
      req.respond({ status: 200, contentType: 'application/javascript', body: threeJs });
    } else {
      req.continue();
    }
  });
  page.on('pageerror', (e) => console.error('[halaman error]', e.message));

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  const ready = await page.evaluate(() => window.__ready === true && typeof window.__frame === 'function');
  if (!ready) throw new Error('Halaman 3D gagal jalan (WebGL atau Three.js tidak termuat).');

  console.log('Render audio...');
  const wavB64 = await page.evaluate(() => window.__renderAudio());
  fs.writeFileSync(WAV, Buffer.from(wavB64, 'base64'));

  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-i', WAV,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-t', String(TOTAL),
      TMP,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const done = new Promise((resolve) => ff.on('close', resolve));
  ff.stdin.on('error', () => {}); // error ffmpeg kelihatan dari exit code

  const frames = TOTAL * FPS;
  console.log(`Render ${frames} frame (${W}x${H}, ${FPS} fps)...`);
  for (let i = 0; i < frames; i++) {
    await page.evaluate(
      (t, dt) => {
        window.__frame(t, dt);
        return new Promise((r) => requestAnimationFrame(() => r()));
      },
      i / FPS,
      1 / FPS,
    );
    const jpg = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(jpg)) await once(ff.stdin, 'drain');
    if (i % FPS === 0) console.log(`  detik ${i / FPS} dari ${TOTAL}`);
  }
  ff.stdin.end();

  const code = await done;
  if (code !== 0) throw new Error('ffmpeg gagal dengan kode ' + code);
  fs.renameSync(TMP, OUT);
  console.log('Selesai:', OUT);
} finally {
  await browser.close();
}
