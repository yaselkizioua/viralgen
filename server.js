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
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`Replicate ${r.status}: ${await r.text()}`);
  return r.json();
}

// Génère un clip pour une scène, renvoie l'URL du fichier vidéo
async function makeClip(scene) {
  const input = { prompt: scene.prompt_video, ...JSON.parse(INPUT_EXTRA) };
  let p = await rep(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  while (!["succeeded", "failed", "canceled"].includes(p.status)) {
    await sleep(3000);
    p = await rep(p.urls.get);
  }
  if (p.status !== "succeeded") throw new Error(p.error || "Génération du clip échouée");
  return Array.isArray(p.output) ? p.output[0] : p.output;
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Téléchargement du clip impossible");
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
}

// Assemble les clips en une vidéo verticale 1080x1920
function assemble(files, output) {
  const args = ["-y"];
  files.forEach((f) => args.push("-i", f));
  const prep = files
    .map((_, i) => `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[v${i}]`)
    .join(";");
  const join = files.map((_, i) => `[v${i}]`).join("") + `concat=n=${files.length}:v=1:a=0[out]`;
  args.push("-filter_complex", `${prep};${join}`, "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", output);
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", () => reject(new Error("FFmpeg introuvable : installe-le sur le serveur")));
    ff.on("close", (c) => (c === 0 ? resolve() : reject(new Error("FFmpeg a échoué: " + err.slice(-300)))));
  });
}

async function runJob(id, scenes) {
  const job = jobs.get(id);
  try {
    const dir = path.join(OUT, id);
    await fs.mkdir(dir, { recursive: true });
    const files = await Promise.all(
      scenes.map(async (s, i) => {
        const url = await makeClip(s);
        const f = path.join(dir, `clip${i}.mp4`);
        await download(url, f);
        job.done += 1;
        return f;
      })
    );
    job.status = "assembling";
    await assemble(files, path.join(OUT, `${id}.mp4`));
    job.status = "done";
    job.url = `/out/${id}.mp4`;
  } catch (e) {
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
    const prompt = `Tu es un expert en vidéos courtes virales (rétention, hooks, storytelling). Idée : "${idea.slice(0, 500)}". Plateforme : ${String(platform).slice(0, 30)}. Durée : ${dur} secondes. Style : ${String(tone).slice(0, 40)}.
Réponds en français avec UNIQUEMENT un objet JSON de cette forme :
{"hook":"...","script":"texte complet de la voix off","scenes":[{"numero":1,"duree":"0-3 s","visuel":"description du plan","voix":"texte dit","texte_ecran":"texte court","prompt_video":"prompt en anglais, détaillé, format vertical 9:16, pour un générateur de vidéo IA"}],"legende":"...","hashtags":["#..."]}
Règles : 4 à 6 scènes dont les durées totalisent ${dur} s, un cliffhanger ou une boucle en fin de vidéo, aucun texte hors JSON.`;
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

// Corps attendu : { scenes: [{ prompt_video: "..." }, ...] }
app.post("/api/videos", (req, res) => {
  const scenes = (req.body?.scenes || []).filter((s) => typeof s.prompt_video === "string" && s.prompt_video.trim());
  if (!scenes.length || scenes.length > 8) return res.status(400).json({ error: "Entre 1 et 8 scènes avec prompt_video." });
  const id = crypto.randomUUID();
  jobs.set(id, { status: "generating", done: 0, total: scenes.length });
  runJob(id, scenes);
  res.json({ id });
});

app.get("/api/videos/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  job ? res.json(job) : res.sendStatus(404);
});

app.listen(PORT, () => console.log(`ViralGen backend sur le port ${PORT}`));
