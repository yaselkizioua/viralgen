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
  const noText = /no text/i.test(scene.prompt_video) ? "" : ", no text, no letters, no words, no numbers, no subtitles, no logos";
  const input = { prompt: scene.prompt_video + noText, ...JSON.parse(INPUT_EXTRA) };
  const p = await rep(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  return waitOutput(p, "Clip vidéo");
}

// Génère la voix off d'une scène (voix d'homme narrateur, en français)
const TTS_MODEL = process.env.TTS_MODEL || "minimax/speech-02-hd";
const TTS_VOICE = process.env.TTS_VOICE || "French_MaleNarrator";
// Styles de voix proposés dans l'interface : vitesse + émotion du modèle MiniMax
const VOICE_STYLES = {
  dynamique: { speed: Number(process.env.TTS_SPEED) || 1.15, emotion: process.env.TTS_EMOTION || "happy" },
  posee: { speed: 1.0, emotion: "neutral" },
};
// Prépare le texte pour la synthèse : "//" devient une vraie pause, les mots en MAJUSCULES restent lisibles
function ttsText(text) {
  return stripEmoji(text)
    .replace(/\s*\/\/\s*/g, " <#0.5#> ")
    .replace(/\b([A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ]{3,})\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase())
    .replace(/\s+/g, " ")
    .trim();
}
async function makeVoice(text, style = "dynamique") {
  const s = VOICE_STYLES[style] || VOICE_STYLES.dynamique;
  const p = await rep(`https://api.replicate.com/v1/models/${TTS_MODEL}/predictions`, {
    method: "POST",
    body: JSON.stringify({
      input: { text: ttsText(text).slice(0, 600), voice_id: TTS_VOICE, language_boost: "French", speed: s.speed, emotion: s.emotion },
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

// Supprime les émojis : la police du serveur ne sait pas les dessiner (ils apparaîtraient en carrés)
function stripEmoji(text) {
  return String(text || "").replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu, "").replace(/[ \t]+/g, " ").trim();
}

// Coupe le texte en lignes courtes pour l'écran vertical
function wrap(text, max = 18, maxLines = 4) {
  const lines = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + w).length > max) { lines.push(line); line = w; }
    else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const W = 720, H = 1280;
// Styles des textes incrustés (taille de police, largeur de ligne en caractères, apparence)
const STYLES = {
  titre: { size: 60, max: 16, look: "fontcolor=white:borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=3:shadowy=3" },
  accent: { size: 60, max: 16, look: "fontcolor=0xF5C542:borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=3:shadowy=3" },
  info: { size: 40, max: 24, look: "fontcolor=white:borderw=4:bordercolor=black" },
  positif: { size: 38, max: 26, look: "fontcolor=0x3DDC84:borderw=4:bordercolor=black" },
  negatif: { size: 38, max: 26, look: "fontcolor=0xFF5A5A:borderw=4:bordercolor=black" },
  message: { size: 34, max: 26, lh: 1.6, look: "fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=10" },
};

let txtCount = 0;
// Renvoie les filtres drawtext d'un texte, une ligne centrée par filtre
// (chaque ligne passe par un fichier : aucun souci d'apostrophes, de deux-points ou de %)
async function drawText(dir, lines, { size, look, y, from = 0, to = null, lh = 1.2 }) {
  const enable = to == null ? `gte(t\\,${from.toFixed(2)})` : `between(t\\,${from.toFixed(2)}\\,${to.toFixed(2)})`;
  const out = [];
  for (const [k, line] of lines.entries()) {
    const tf = path.join(dir, `txt${txtCount++}.txt`);
    await fs.writeFile(tf, line);
    const ly = Math.round(y + k * size * lh);
    out.push(`drawtext=fontfile=${FONT}:textfile=${tf}:expansion=none:fontsize=${size}:${look}:x=(w-text_w)/2:y=${ly}:enable='${enable}'`);
  }
  return out.join(",");
}

// Découpe la voix off en sous-titres de 3 à 4 mots, répartis sur la durée de la voix
function subtitleChunks(text, voiceDur) {
  const words = stripEmoji(text).replace(/\s*\/\/\s*/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += 4) chunks.push(words.slice(i, i + 4).join(" "));
  const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let t = 0;
  return chunks.map((c) => {
    const d = (c.length / total) * voiceDur;
    const item = { text: c, from: t, to: t + d };
    t += d;
    return item;
  });
}

// Durée demandée dans le script ("44-56 s" → 12), utilisée quand une scène n'a pas de voix générée
function sceneSeconds(duree) {
  const m = String(duree || "").match(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return 0;
  const d = parseFloat(m[2].replace(",", ".")) - parseFloat(m[1].replace(",", "."));
  return d > 0 && d <= 30 ? d : 0;
}

// Construit tous les filtres de texte d'une scène : bandeau, textes à l'écran, sous-titres
async function overlayFilters({ textes = [], bandeau = "", voix = "", sousTitres = true }, dir, dur, voiceDur) {
  const filters = [];
  if (bandeau) {
    filters.push(await drawText(dir, wrap(stripEmoji(bandeau), 34, 1), {
      size: 30, y: H * 0.045, look: "fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12",
    }));
  }
  // Textes à l'écran : ils apparaissent l'un après l'autre et restent jusqu'à la fin de la scène
  const items = textes
    .map((t) => ({ ...t, texte: stripEmoji(t.texte) }))
    .filter((t) => t.texte)
    .slice(0, 8);
  const groups = { haut: [], centre: [], bas: [] };
  items.forEach((t, i) => {
    const st = STYLES[t.style] || STYLES.titre;
    const pos = groups[t.position] ? t.position : "centre";
    // Apparition progressive : un nouveau texte toutes les 1,2 s au plus (le hook s'affiche donc presque d'un bloc)
    groups[pos].push({ ...t, st, from: i * Math.min(1.2, (dur * 0.75) / items.length) });
  });
  for (const [pos, list] of Object.entries(groups)) {
    if (!list.length) continue;
    // Taille réduite automatiquement si beaucoup de lignes doivent tenir à l'écran
    const prepared = list.map((t) => ({ ...t, lines: wrap(t.texte, t.st.max, 3) }));
    const height = (scale) => prepared.reduce((h, t) => h + t.lines.length * t.st.size * scale * (t.st.lh || 1.2) + 28 * scale, 0);
    const room = pos === "centre" ? H * 0.5 : H * 0.22;
    const scale = Math.min(1, room / height(1));
    // "bas" se termine au-dessus de la zone des sous-titres (qui commence à 78 % de la hauteur)
    let y = pos === "haut" ? H * 0.11 : pos === "bas" ? H * 0.77 - height(scale) : (H - height(scale)) / 2 - H * 0.04;
    for (const t of prepared) {
      const size = Math.round(t.st.size * scale);
      filters.push(await drawText(dir, t.lines, { size, look: t.st.look, lh: t.st.lh, y, from: Math.min(t.from, Math.max(0, dur - 1)) }));
      y += t.lines.length * size * (t.st.lh || 1.2) + 28 * scale;
    }
  }
  // Sous-titres synchronisés sur la voix off, en bas de l'écran
  if (sousTitres && voix && voiceDur) {
    for (const c of subtitleChunks(voix, voiceDur)) {
      filters.push(await drawText(dir, wrap(c.text, 22, 2), {
        size: 46, y: H * 0.8, from: c.from, to: c.to,
        look: "fontcolor=white:borderw=5:bordercolor=black:shadowcolor=black@0.6:shadowx=2:shadowy=2",
      }));
    }
  }
  return filters;
}

// Fabrique un segment 720x1280 : clip (bouclé si besoin) + voix off + textes à l'écran
async function buildSegment(part, dir, i) {
  const { clip, voice } = part;
  const out = path.join(dir, `seg${i}.mp4`);
  const voiceDur = voice ? await duration(voice) : 0;
  const dur = voice ? voiceDur + 0.4 : sceneSeconds(part.duree) || (await duration(clip));
  const filters = ["scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30"];
  filters.push(...(await overlayFilters(part, dir, dur, voiceDur)));
  const script = path.join(dir, `filters${i}.txt`);
  await fs.writeFile(script, filters.join(",\n"));
  const args = ["-y", "-stream_loop", "-1", "-i", clip];
  if (voice) args.push("-i", voice);
  else args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  args.push(
    "-filter_script:v", script, "-map", "0:v", "-map", "1:a", "-t", dur.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p", "-r", "30",
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

async function runJob(id, scenes, opts) {
  const job = jobs.get(id);
  try {
    const dir = path.join(OUT, id);
    await fs.mkdir(dir, { recursive: true });
    const parts = await Promise.all(
      scenes.map(async (s, i) => {
        const [clipUrl, voiceUrl] = await Promise.all([
          makeClip(s),
          s.voix ? makeVoice(s.voix, opts.voix) : Promise.resolve(null),
        ]);
        const clip = path.join(dir, `clip${i}.mp4`);
        await download(clipUrl, clip);
        let voice = null;
        if (voiceUrl) {
          voice = path.join(dir, `voice${i}.audio`);
          await download(voiceUrl, voice);
        }
        job.done += 1;
        return {
          clip, voice, voix: s.voix, duree: s.duree, textes: s.textes,
          bandeau: opts.bandeau, sousTitres: opts.sousTitres,
        };
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
- reprends les durées du brief dans "duree" (la durée du brief est prioritaire sur ${dur} s) ;
- "visuel" résume le visuel décrit dans le brief ;
- "prompt_video" (en anglais) traduit le visuel de la scène ET répète à chaque scène la direction artistique du brief (style, palette, personnage décrit à l'identique), pour que toutes les scènes se ressemblent ; AUCUN texte ne doit apparaître dans l'image générée (panneaux, téléphones, cartes et boutons dessinés sans écriture) ;
- "textes" reprend MOT POUR MOT, en français, les textes à afficher à l'écran dans cette scène (gros titres, hook, messages de téléphone, notifications, choix A/B, avantages et inconvénients, appel au vote), dans leur ordre d'apparition ; ils seront incrustés par-dessus la vidéo, donc parfaitement lisibles ;
- "bandeau" = le texte fixe affiché en haut pendant toute la vidéo s'il y en a un (sinon "") ; ne le répète pas dans "textes", et n'y mets pas non plus les sous-titres de la voix off ;
- "hook" = l'accroche de la première scène ; "script" = toutes les voix off bout à bout.`
  : `Durée : ${dur} secondes. Crée 4 à 6 scènes dont les durées totalisent ${dur} s, avec un cliffhanger ou une boucle en fin de vidéo. Dans chaque "prompt_video", répète le même style visuel et décris le personnage principal à l'identique. La scène 1 affiche le hook en gros dans "textes" ; ajoute ensuite 1 ou 2 textes courts et percutants par scène quand c'est utile.`}

Règles pour "textes" : au maximum 6 par scène, chacun court (moins de 60 caractères), en français correct avec accents.
- "position" : "haut", "centre" ou "bas" ("bas" reste au-dessus des sous-titres).
- "style" : "titre" (gros titre blanc), "accent" (gros titre jaune, pour le mot-clé ou la 2e ligne du hook), "info" (texte moyen), "positif" (avantage, en vert), "negatif" (inconvénient, en rouge), "message" (bulle blanche façon SMS ou notification).
Règles pour "voix" : écris les nombres et montants en toutes lettres (« mille huit cents euros ») pour que la voix les lise correctement ; tu peux mettre "//" pour une courte pause.

Réponds en français avec UNIQUEMENT un objet JSON de cette forme, aucun texte hors JSON :
{"hook":"...","bandeau":"...","script":"texte complet de la voix off","scenes":[{"numero":1,"duree":"0-3 s","visuel":"description du plan","voix":"texte dit","textes":[{"texte":"...","position":"centre","style":"titre"}],"prompt_video":"prompt en anglais, détaillé, format vertical 9:16, pour un générateur de vidéo IA, qui se termine toujours par : no text, no letters, no words, no numbers, no subtitles, no logos"}],"legende":"...","hashtags":["#..."]}`;
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

// Corps attendu : { scenes: [{ prompt_video, voix, duree, textes: [{ texte, position, style }] }], bandeau, hook, voix, sous_titres }
app.post("/api/videos", (req, res) => {
  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const body = req.body || {};
  const scenes = (body.scenes || [])
    .filter((s) => typeof s.prompt_video === "string" && s.prompt_video.trim())
    .map((s) => ({
      prompt_video: s.prompt_video,
      voix: str(s.voix, 600),
      duree: str(s.duree, 20),
      textes: (Array.isArray(s.textes) ? s.textes : [])
        .map((t) => ({ texte: str(t?.texte, 120), position: str(t?.position, 10), style: str(t?.style, 10) }))
        .filter((t) => t.texte)
        .slice(0, 8),
    }));
  if (!scenes.length || scenes.length > 8) return res.status(400).json({ error: "Entre 1 et 8 scènes avec prompt_video." });
  // Le hook s'affiche toujours en gros au début de la vidéo, même si le script ne l'a pas mis dans les textes
  const hook = str(body.hook, 120);
  if (hook && !scenes[0].textes.length) scenes[0].textes.push({ texte: hook, position: "centre", style: "titre" });
  const opts = {
    bandeau: str(body.bandeau, 60),
    voix: body.voix === "posee" ? "posee" : "dynamique",
    sousTitres: body.sous_titres !== false,
  };
  const id = crypto.randomUUID();
  jobs.set(id, { status: "generating", done: 0, total: scenes.length });
  runJob(id, scenes, opts);
  res.json({ id });
});

app.get("/api/videos/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  job ? res.json(job) : res.sendStatus(404);
});

app.listen(PORT, () => console.log(`ViralGen backend sur le port ${PORT}`));
