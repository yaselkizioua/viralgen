# ViralGen backend

Reçoit les scènes, génère un clip par scène avec un modèle sur Replicate, assemble le tout en MP4 vertical (1080x1920).

## Prérequis
- Node 18+
- FFmpeg installé sur le serveur
- Un compte Replicate et son token (replicate.com/account/api-tokens)

## Variables d'environnement
```
REPLICATE_API_TOKEN=r8_...
REPLICATE_MODEL=owner/nom-du-modele     # un modèle texte → vidéo choisi sur replicate.com
ANTHROPIC_API_KEY=sk-ant-...            # génère le script et les scènes (console.anthropic.com)
ANTHROPIC_MODEL=claude-sonnet-5-5       # optionnel
INPUT_EXTRA={"aspect_ratio":"9:16"}     # paramètres propres au modèle (optionnel)
APP_KEY=une-cle-secrete                 # protège ton API, envoyée dans l'en-tête x-app-key
ALLOWED_ORIGIN=https://ton-site.com     # ton site front (optionnel)
```

## Lancer
```
npm install
npm start
```

## Interface
Le serveur sert `public/index.html` à la racine : ouvre simplement l'adresse du serveur. Le code d'accès demandé sur la page est la valeur de `APP_KEY`.

## API
- `POST /api/script` avec `{"idea":"...","platform":"TikTok","duration":30,"tone":"..."}` renvoie hook, script, scènes, légende et hashtags
- `POST /api/videos` avec `{"scenes":[{"prompt_video":"..."}]}` renvoie `{"id":"..."}`
- `GET /api/videos/:id` renvoie `{status, done, total, url}` (status : generating, assembling, done, error)
- La vidéo finale est servie sur `/out/<id>.mp4`

## À savoir
- Chaque scène est facturée par Replicate : teste avec 2 scènes d'abord.
- Les noms de paramètres changent selon le modèle (durée, format, résolution) : regarde l'onglet API du modèle et mets-les dans INPUT_EXTRA.
- Les jobs sont gardés en mémoire : un redémarrage du serveur les efface.
- Hébergement possible : Railway ou Render (installe FFmpeg dans l'image).
