import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const { REPLICATE_API_TOKEN, REPLICATE_MODEL, INPUT_EXTRA = "{}", APP_KEY, PORT = 3000 } = process.env;
const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL = "claude-sonnet-5-5" } = process.env;
if (!REPLICATE_API_TOKEN || !REPLICATE_MODEL || !ANTHROPIC_API_KEY) {
  console.error("Définis REPLICATE_API_TOKEN, REPLICATE_MODEL (ex: owner/model) et ANTHROPIC_API_KEY.");
  process.exit(1);
}

const OUT = path.resolve("out");
await fs.mkdir(OUT, { recursive: true });
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rep(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
    });
    if (r.status === 429 && attempt < 10) {
      await sleep(((Number(r.headers.get("retry-after")) || 10) + 1) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`Replicate ${r.status}: ${await r.text()}`);
    return r.json();
  }
}

// Attend la fin d'une prédiction Replicate et renvoie l'URL du fichier produit
async function waitOutput(p, label) {
  while (!["succeeded", "failed", "canceled"].includes(p.status)) {
    await sleep(3000);
    p = await rep(p.urls.get);
  }
  if (p.status !== "succeeded") throw new Error(`${label} : ${p.error || "génération échouée"}`);
  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  return typeof out === "string" ? out : out?.url || out?.audio || out;
}

// Génère un clip vidéo pour une scène
async function makeClip(scene) {
  const noText = ". Absolutely no text anywhere in the image: no letters, no words, no numbers, no Chinese characters, no captions, no subtitles, no signs, no logos, no user interface.";
  const input = { prompt: scene.prompt_video + noText, ...JSON.parse(INPUT_EXTRA) };
  const p = await rep(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  return waitOutput(p, "Clip vidéo");
}

// Génère la voix off d'une scène (voix française dynamique)
const TTS_MODEL = process.env.TTS_MODEL || "minimax/speech-2.6-hd";
const TTS_VOICE = process.env.TTS_VOICE || "French_CasualMan";
const TTS_SPEED = Number(process.env.TTS_SPEED || 1.12);
const TTS_EMOTION = process.env.TTS_EMOTION || "happy";
async function makeVoice(text) {
  const p = await rep(`https://api.replicate.com/v1/models/${TTS_MODEL}/predictions`, {
    method: "POST",
    body: JSON.stringify({
      input: { text: text.slice(0, 400), voice_id: TTS_VOICE, speed: TTS_SPEED, emotion: TTS_EMOTION, language_boost: "French" },
    }),
  });
  return waitOutput(p, "Voix off");
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Téléchargement d'un fichier Replicate impossible");
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new Error(`${cmd} introuvable : installe FFmpeg sur le serveur`)));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`${cmd} a échoué (code ${c}): ` + err.slice(-400)))));
  });
}

async function duration(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return parseFloat(out) || 5;
}

// Garde seulement les caractères affichables proprement (lettres françaises, chiffres, ponctuation, €)
function clean(text) {
  return String(text || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{Script=Latin}\p{N}\s.,;:!?'"«»()\-–—%€$&+/=#@*]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Coupe le texte en lignes courtes pour l'écran vertical
function wrap(text, max, maxLines) {
  const lines = [];
  let line = "";
  for (const w of text.split(" ").filter(Boolean)) {
    if (line && (line + " " + w).length > max) { lines.push(line); line = w; }
    else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// Une ligne de texte net = un filtre drawtext centré, écrit par FFmpeg (pas par l'IA)
async function textFilters(text, dir, key, { size, color, y, max, maxLines }) {
  const lines = wrap(clean(text), max, maxLines);
  const out = [];
  for (let j = 0; j < lines.length; j++) {
    const tf = path.join(dir, `${key}_${j}.txt`);
    await fs.writeFile(tf, lines[j]);
    const top = Math.round(y + j * size * 1.25);
    out.push(`drawtext=fontfile=${FONT}:expansion=none:textfile=${tf}:fontsize=${size}:fontcolor=${color}:borderw=${Math.round(size / 8)}:bordercolor=black:shadowcolor=black@0.6:shadowx=3:shadowy=3:x=(w-text_w)/2:y=${top}`);
  }
  return out;
}

// Fabrique un segment 720x1280 : clip (bouclé si besoin) + voix off + titre / message à l'écran
async function buildSegment({ clip, voice, text, title }, dir, i) {
  const out = path.join(dir, `seg${i}.mp4`);
  const dur = voice ? (await duration(voice)) + 0.3 : await duration(clip);
  const filters = ["scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30"];
  if (title) filters.push(...(await textFilters(title, dir, `title${i}`, { size: 66, color: "0xFFD84D", y: 170, max: 15, maxLines: 3 })));
  if (text) filters.push(...(await textFilters(text, dir, `msg${i}`, { size: 52, color: "white", y: 760, max: 18, maxLines: 4 })));
  const args = ["-y", "-stream_loop", "-1", "-i", clip];
  if (voice) args.push("-i", voice);
  else args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  args.push(
    "-vf", filters.join(","), "-map", "0:v", "-map", "1:a", "-t", dur.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k", out
  );
  await run("ffmpeg", args);
  return out;
}

// Met les segments bout à bout sans réencoder
async function concat(segments, dir, output) {
  const list = path.join(dir, "list.txt");
  await fs.writeFile(list, segments.map((s) => `file '${s}'`).join("\n"));
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
}

async function runJob(id, scenes, hookTitle) {
  const job = jobs.get(id);
  try {
    const dir = path.join(OUT, id);
    await fs.mkdir(dir, { recursive: true });
    const parts = await Promise.all(
      scenes.map(async (s, i) => {
        const [clipUrl, voiceUrl] = await Promise.all([
          makeClip(s),
          s.voix ? makeVoice(s.voix) : Promise.resolve(null),
        ]);
        const clip = path.join(dir, `clip${i}.mp4`);
        await download(clipUrl, clip);
        let voice = null;
        if (voiceUrl) {
          voice = path.join(dir, `voice${i}.audio`);
          await download(voiceUrl, voice);
        }
        job.done += 1;
        const title = i === 0 ? hookTitle : "";
        const text = title && clean(s.texte_ecran).toLowerCase() === clean(title).toLowerCase() ? "" : s.texte_ecran;
        return { clip, voice, text, title };
      })
    );
    job.status = "assembling";
    const segments = [];
    for (let i = 0; i < parts.length; i++) segments.push(await buildSegment(parts[i], dir, i));
    await concat(segments, dir, path.join(OUT, `${id}.mp4`));
    job.status = "done";
    job.url = `/out/${id}.mp4`;
  } catch (e) {
    console.error(`Job ${id} :`, e.message);
    job.status = "error";
    job.error = e.message;
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/out", express.static(OUT));
app.use(express.static(path.resolve("public")));
app.use("/api", (req, res, next) => (APP_KEY && req.get("x-app-key") !== APP_KEY ? res.sendStatus(401) : next()));

// Corps attendu : { idea, platform, duration, tone } → renvoie hook, script, scènes, légende, hashtags
app.post("/api/script", async (req, res) => {
  try {
    const { idea, platform = "TikTok", duration = 30, tone = "Punchy et direct" } = req.body || {};
    if (!idea || typeof idea !== "string") return res.status(400).json({ error: "Idée manquante." });
    const dur = [15, 30, 60].includes(Number(duration)) ? Number(duration) : 30;
    const brief = idea.slice(0, 12000);
    const isBrief = brief.length > 400;
    const prompt = `Tu es un expert en vidéos courtes virales (rétention, hooks, storytelling). Plateforme : ${String(platform).slice(0, 30)}. Style : ${String(tone).slice(0, 40)}.

${isBrief ? "BRIEF DÉTAILLÉ DU CRÉATEUR" : "IDÉE"} :
<<<
${brief}
>>>

${isBrief
  ? `Ce texte est un brief précis. Tu dois le RESPECTER FIDÈLEMENT, pas inventer une autre histoire :
- garde exactement les mêmes scènes, dans le même ordre (8 scènes maximum) ;
- reprends MOT POUR MOT les voix off du brief dans "voix" ; si une voix off est à laisser vide, mets "voix": "" ;
- "texte_ecran" = UNIQUEMENT le gros titre / texte écran que le brief demande pour cette scène (sans emoji, 45 caractères maximum) ; ignore bandeaux, compteurs, étiquettes et sous-titres ; s'il n'y a pas de gros titre dans la scène, mets "" ;
- reprends les durées du brief dans "duree" (la durée du brief est prioritaire sur ${dur} s) ;
- "visuel" résume le visuel décrit dans le brief ;
- "prompt_video" (en anglais) traduit le visuel de la scène ET répète à chaque scène la direction artistique du brief (style, palette, personnage décrit à l'identique), pour que toutes les scènes se ressemblent ; n'y mets JAMAIS les titres, bandeaux, compteurs, chiffres ou sous-titres du brief (ils sont ajoutés à part) : la vidéo IA ne doit contenir aucun texte ;
- "hook" = l'accroche de la première scène ; "script" = toutes les voix off bout à bout.`
  : `Durée : ${dur} secondes. Crée 4 à 6 scènes dont les durées totalisent ${dur} s, avec un cliffhanger ou une boucle en fin de vidéo. Dans chaque "prompt_video", répète le même style visuel et décris le personnage principal à l'identique, sans aucun texte dans l'image. "texte_ecran" = seulement s'il apporte quelque chose (chiffre clé, question, appel à l'action), 45 caractères maximum, sans emoji ; sinon "". Au maximum 3 scènes avec du texte.`}

Règles d'écriture : "titre_hook" = le hook en version titre, très court (40 caractères maximum, sans emoji), affiché en gros au début de la vidéo. Un "texte_ecran" ne répète jamais la voix off mot pour mot. Tous les textes sont en français correct, avec accents. Les voix off sont écrites pour être lues à voix haute avec énergie : phrases courtes, ponctuation claire, nombres écrits comme on les dit (« 5 000 euros »).

Réponds en français avec UNIQUEMENT un objet JSON de cette forme, aucun texte hors JSON :
{"hook":"...","titre_hook":"...","script":"texte complet de la voix off","scenes":[{"numero":1,"duree":"0-3 s","visuel":"description du plan","voix":"texte dit","texte_ecran":"message court affiché","prompt_video":"prompt en anglais, détaillé, format vertical 9:16, pour un générateur de vidéo IA, sans aucun texte dans l'image"}],"legende":"...","hashtags":["#..."]}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 8000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const text = d.content.map((c) => c.text || "").join("");
    res.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Corps attendu : { titre_hook: "...", scenes: [{ prompt_video: "...", voix: "...", texte_ecran: "..." }, ...] }
app.post("/api/videos", (req, res) => {
  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const scenes = (req.body?.scenes || [])
    .filter((s) => typeof s.prompt_video === "string" && s.prompt_video.trim())
    .map((s) => ({ prompt_video: s.prompt_video, voix: str(s.voix, 400), texte_ecran: str(s.texte_ecran, 90) }));
  if (!scenes.length || scenes.length > 8) return res.status(400).json({ error: "Entre 1 et 8 scènes avec prompt_video." });
  const id = crypto.randomUUID();
  jobs.set(id, { status: "generating", done: 0, total: scenes.length });
  runJob(id, scenes, str(req.body?.titre_hook, 60));
  res.json({ id });
});

app.get("/api/videos/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  job ? res.json(job) : res.sendStatus(404);
});

app.listen(PORT, () => console.log(`ViralGen backend sur le port ${PORT}`));
