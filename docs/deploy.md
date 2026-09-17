# Déploiement

Music Manager en production : quatre conteneurs, un fichier `.env`, un reverse proxy devant.
Cible : un serveur Linux avec Docker. Tout ce qui suit a été exécuté tel quel sur la pile de
test de P10 (`orchestration/reports/P10-build-1.md`).

- [1. Première installation](#1-première-installation)
- [2. Le reverse proxy](#2-le-reverse-proxy)
- [3. Où sont les données](#3-où-sont-les-données)
- [4. Mise à jour](#4-mise-à-jour)
- [5. yt-dlp seul](#5-yt-dlp-seul)
- [5 bis. Les sources surveillées](#5-bis-les-sources-surveillées)
- [5 ter. Cookies YouTube (vidéos avec restriction d'âge)](#5-ter-cookies-youtube-vidéos-avec-restriction-dâge)
- [5 quater. Le rythme de préparation](#5-quater-le-rythme-de-préparation)
- [5 quinquies. Adopter un fichier local comme source d'une piste](#5-quinquies-adopter-un-fichier-local-comme-source-dune-piste)
- [6. Sauvegarde et restauration](#6-sauvegarde-et-restauration)
- [7. Journaux](#7-journaux)
- [8. Navidrome](#8-navidrome)
- [9. Sécurité](#9-sécurité)
- [10. Quand ça ne marche pas](#10-quand-ça-ne-marche-pas)

---

## 1. Première installation

**Prérequis** : Docker ≥ 24 avec le plugin `compose`, `curl`, et `git` pour récupérer le dépôt.
`jq` est facultatif mais les scripts d'exploitation sont plus fiables avec (ils ont un repli
qui ne lit que des clés simples). Rien d'autre : ni Bun, ni Node, ni Python sur l'hôte — tout
vit dans les images.

```bash
git clone <dépôt> /opt/music-manager
cd /opt/music-manager

cp .env.production.example .env
chmod 600 .env
$EDITOR .env
```

Cinq valeurs n'ont **pas** de défaut, et `docker compose` refuse de démarrer tant qu'elles sont
vides — c'est délibéré : une installation qui démarre avec une clé de session devinable est
pire qu'une installation qui ne démarre pas.

| Variable               | Comment la produire                                              |
| ---------------------- | ---------------------------------------------------------------- |
| `MM_POSTGRES_PASSWORD` | `openssl rand -hex 24`                                           |
| `MM_AUTH_SECRET`       | `openssl rand -base64 32`                                        |
| `MM_WEB_URL`           | l'URL publique, schéma compris, sans `/` final                   |
| `MM_ADMIN_EMAIL`       | votre adresse — le compte unique de l'installation               |
| `MM_ADMIN_PASSWORD`    | un mot de passe ; ou laissez les deux vides et utilisez `/setup` |

Puis :

```bash
MM_GIT_SHA="$(git rev-parse HEAD)" \
MM_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
docker compose -f docker-compose.prod.yml up -d --build
```

La première montée construit les deux images (compter cinq à dix minutes : le toolbox compile
sa couche Python et récupère ffmpeg). Ensuite :

- `postgres` démarre et devient _healthy_ ;
- `toolbox` démarre, met à jour yt-dlp si `MM_YTDLP_AUTOUPDATE=1`, devient _healthy_ ;
- `web` applique les migrations Drizzle **puis** sert — c'est ce qui rend une mise à jour
  atomique du point de vue de l'exploitant ;
- `worker` démarre seulement une fois `web` _healthy_, donc après les migrations.

Vérifiez :

```bash
docker compose -f docker-compose.prod.yml ps
./scripts/smoke.sh
```

`smoke.sh` teste ce que teste un client : `/health`, les en-têtes de sécurité, la connexion, la
limite de débit, et que le toolbox n'a **aucun port publié**. Il ne fait un import que si la
pile est en mode fixtures (voir §10) — sur une installation réelle (`MM_FIXTURES=0`, le
défaut), un `./scripts/smoke.sh` nu **ne télécharge rien du tout** ; il l'annonce par une ligne
`?` plutôt que par un échec, ce qui se lit facilement comme « tout est passé » alors qu'aucun
import n'a été tenté. Pour la preuve qui compte réellement — un import bout en bout, sans mode
hors ligne — passez `--real` (dix à trente secondes le temps que MusicBrainz réponde, puis le
téléchargement) :

```bash
./scripts/smoke.sh --real                 # prend la plus vieille vidéo de YouTube par défaut
./scripts/smoke.sh --real-url 'https://…' # une autre URL
```

Le compte administrateur est créé au premier chargement d'une page, pas au démarrage du
conteneur : ouvrez `MM_WEB_URL` une fois. Si vous avez laissé `MM_ADMIN_EMAIL` vide, cette
première page est `/setup` et vous y créez le compte ; la page se ferme définitivement dès
qu'un compte existe.

> **`MM_ADMIN_PASSWORD` ne sert qu'une fois.** Le changer dans `.env` ne change pas le mot de
> passe : sinon un `compose up` remettrait l'ancien à chaque redémarrage. Pour le changer,
> passez par la Console.

---

## 2. Le reverse proxy

`web` publie du HTTP en clair sur `127.0.0.1:3200` (`MM_WEB_BIND` / `MM_WEB_PORT`). Le TLS est
le travail du proxy. Trois choses, et une seule est piégeuse :

1. **`MM_WEB_URL` doit être l'URL publique.** Better Auth compare l'en-tête `Origin` du
   navigateur à cette valeur et répond `403 Invalid origin` sinon. Le symptôme est un
   formulaire de connexion parfait qui refuse de connecter, et il ne ressemble pas à une erreur
   de configuration de proxy.
2. **`MM_BEHIND_PROXY=1`.** Le cookie de session devient `Secure` bien que ce processus ne
   parle que HTTP, `X-Forwarded-Proto` / `-Host` deviennent croyables, `Strict-Transport-Security`
   est émis, et la limite de débit peut enfin distinguer les clients (elle lit
   `X-Forwarded-For`). Sans proxy devant, laissez `0` : croire des en-têtes que n'importe qui
   peut écrire est pire que ne pas les avoir.
3. **Le proxy doit poser `X-Forwarded-Proto`, `X-Forwarded-Host` et `X-Forwarded-For`.** Caddy
   et Traefik le font tout seuls ; nginx demande de l'écrire.

### Caddy

```caddyfile
music.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3200 {
        # Caddy pose déjà X-Forwarded-{For,Proto,Host}. Rien à ajouter.
        # Le flux d'événements de la Console est du text/event-stream : pas de tampon.
        flush_interval -1
    }
}
```

Caddy obtient et renouvelle le certificat seul. C'est le chemin le plus court, et
`Strict-Transport-Security` est déjà posé par l'application.

### Traefik (labels, si Traefik est dans le même Docker)

Ajoutez à `docker-compose.prod.yml`, sur le service `web` — et retirez alors son bloc `ports:`,
puisque Traefik atteint le conteneur par le réseau Docker :

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.mm.rule=Host(`music.example.com`)"
  - "traefik.http.routers.mm.entrypoints=websecure"
  - "traefik.http.routers.mm.tls.certresolver=letsencrypt"
  - "traefik.http.services.mm.loadbalancer.server.port=3000"
```

Traefik pose les `X-Forwarded-*` par défaut ; vérifiez que l'entrypoint HTTP est bien redirigé
vers HTTPS, sinon `MM_WEB_URL` en `https://` et un accès en `http://` produisent le 403 du §2.1.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name music.example.com;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # Le suivi des jobs est en SSE. Sans ces trois lignes, la Console a l'air figée.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

---

## 3. Où sont les données

Quatre volumes, nommés par défaut — rien à créer à la main.

| Volume    | Contenu                                                        | Perte = ?                                                                        |
| --------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pgdata`  | PostgreSQL : la **source de vérité** des métadonnées           | catastrophique ; c'est ce qu'on sauvegarde                                       |
| `library` | la musique, partagée avec le toolbox (et Navidrome)            | grave, mais re-téléchargeable                                                    |
| `cache`   | le scratch du toolbox (`TMPDIR`) : recadrages, scans           | aucune conséquence                                                               |
| `cookies` | `cookies.txt` pour `cookiesMode: file` (§5 ter), lecture seule | aucune si un jar collé (`paste`) est aussi en usage — celui-là vit dans `pgdata` |

```bash
docker volume inspect music-manager_pgdata     # où c'est réellement sur le disque
docker compose -f docker-compose.prod.yml exec web ls -la /library
```

Pour poser l'un d'eux sur un chemin de l'hôte — le cas normal pour `library`, qui existe
souvent déjà — mettez un **chemin absolu** dans `.env` :

```dotenv
MM_LIBRARY_PATH=/srv/music
```

Compose lit une valeur commençant par `/` comme un bind mount et un mot simple comme le nom du
volume déclaré. Le répertoire doit appartenir à l'uid **10001** :

```bash
sudo chown -R 10001:10001 /srv/music
```

C'est l'uid des deux images (`mm` côté web/worker, `toolbox` côté Python) : elles écrivent dans
le même répertoire et un fichier créé par l'une doit être modifiable par l'autre. Un volume
nommé hérite de la bonne propriété tout seul ; un bind mount, non.

**La bibliothèque n'est pas dans les sauvegardes** (§6) : elle se compte en centaines de
gigaoctets et les fichiers sont une projection régénérable de la base.

**`<bibliothèque>/.mm-cache/images/`** contient les vignettes que la Console demande à
`/api/cover` et `/api/artist-image` (64, 160, 320, 640 px). Elles sont fabriquées à la
première demande par `POST /artwork/prepare` du toolbox et relues sur disque ensuite ; le nom
de chaque fichier contient le `mtime` de l'original, donc un re-tag en fabrique de nouvelles
sans que rien n'ait à supprimer les anciennes. Le point devant le nom garde le scanner de
Navidrome dehors, comme pour `.mm-work` et `.mm-archive`. Le répertoire est **jetable** :
le supprimer ne coûte qu'une régénération, et il n'a pas besoin d'être sauvegardé. Comptez
quelques dizaines de kilooctets par album et par taille effectivement demandée.

---

## 4. Mise à jour

### Depuis un registre (images publiées)

```bash
cd /opt/music-manager
git pull
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### En construisant sur place

```bash
cd /opt/music-manager
git pull
MM_GIT_SHA="$(git rev-parse HEAD)" \
MM_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
docker compose -f docker-compose.prod.yml up -d --build
```

Dans les deux cas, `web` applique les migrations en démarrant : il n'y a pas de commande de
migration à ne pas oublier. Ensuite `./scripts/smoke.sh`.

**Les deux images doivent venir du même commit.** Le toolbox annonce dans `GET /health` le
_hash du contrat_ qu'il implémente, et l'application compare avec celui contre lequel son
client a été généré. Une image de retard et tous les appels au toolbox échouent en
`422 extra_forbidden` alors que `/health` répond joyeusement `ok: true`. Tools → « Downloader
health » affiche la comparaison, et `MM_GIT_SHA` grave la révision dans les deux images :

```bash
docker image inspect music-manager-web:local \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

**Revenir en arrière** : `docker compose down`, remettre l'ancien tag dans `MM_WEB_IMAGE` /
`MM_TOOLBOX_IMAGE`, `up -d`. Attention : les migrations Drizzle ne sont pas réversibles, donc
un retour en arrière qui saute une migration demande de restaurer la sauvegarde prise avant la
mise à jour. Prenez-en une avant toute montée de version — c'est deux cents kilo-octets.

**Une mise à jour ne perd rien** : les volumes survivent à `down`/`up`. C'est `down -v` qui les
détruit, et c'est le seul.

---

## 5. yt-dlp seul

C'est le composant qui casse le plus souvent, et le seul qu'on met à jour sans rien
reconstruire. Trois manières, de la plus légère à la plus lourde :

```bash
# 1. Depuis la Console : Tools → « Update yt-dlp ». Sans redémarrage.

# 2. En ligne de commande, à travers l'API du toolbox (depuis le réseau compose) :
docker compose -f docker-compose.prod.yml exec toolbox \
  python -c "import urllib.request as u,json; \
    print(u.urlopen(u.Request('http://127.0.0.1:8100/ytdlp/update', method='POST'), timeout=300).read().decode())"

# 3. Au redémarrage du conteneur, si MM_YTDLP_AUTOUPDATE=1 (le défaut en production) :
docker compose -f docker-compose.prod.yml restart toolbox
```

La mise à jour est _best-effort_ : sans réseau, le conteneur démarre avec la version gravée
dans l'image plutôt que d'échouer. Vérifier la version en place :

```bash
docker compose -f docker-compose.prod.yml exec toolbox \
  python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8100/health').read().decode())"
```

Reconstruire l'image du toolbox met aussi yt-dlp à jour (`ARG YTDLP_UPDATE=1`), mais c'est cinq
minutes pour ce qu'une requête fait en dix secondes.

---

## 5 bis. Les sources surveillées

Une source surveillée est une playlist ou une chaîne YouTube que l'installation relit
périodiquement. Le cron `cron.watched-sources` (défaut `0 */6 * * *`, réglable dans
Settings → Watched sources, clé `watchedSourcesCron`) liste chaque source **à plat** — une
requête par source, pas une par vidéo — compare les identifiants vidéo à ce qu'elle a déjà vu,
et ouvre un import par vidéo nouvelle. Ces imports passent en priorité négative : un album
collé à la main reste devant.

À ne pas confondre avec `cron.refresh-sources`, qui est le rafraîchissement du cache
MusicBrainz et n'a aucun rapport. Les deux se coupent séparément.

```bash
# l'état de chaque source, depuis l'hôte
docker compose -f docker-compose.prod.yml exec web bun run mm -- watch list

# un scan tout de suite, dans le worker
docker compose -f docker-compose.prod.yml exec web bun run mm -- watch scan --queue

# une source précise, et ce qu'elle a vu
docker compose -f docker-compose.prod.yml exec web bun run mm -- watch show <id>
```

**`autoAccept` est la seule exception à « l'algorithme ne choisit jamais à ta place »**
(`docs/04-pipeline-et-matching.md`). Il est désactivé par défaut, se règle **par source**, et
même activé il ne sert que si le candidat est `safe`, non ambigu, et au-dessus du seuil
(`watchedSourcesAutoAcceptThreshold`, défaut = `safeThreshold`). Tout le reste s'arrête en
`awaiting_confirm` avec un item Inbox `source_new_video`. Chaque confirmation automatique est
tracée dans `decisions` avec `decided_by = 'watched-source'` :

```sql
select count(*) from decisions where decided_by = 'watched-source';
```

Une vidéo privée, supprimée ou géobloquée n'interrompt pas le scan : elle est marquée
`skipped` avec sa raison sur la ligne `watched_source_items`. Une source dont l'URL ne répond
plus passe `last_scan_status = 'failed'` avec l'erreur, et les autres sources sont quand même
scannées.

### Les règles d'admission

Deux interrupteurs, dans Settings → Watched sources, section « Import rules ». **Les deux sont
désactivés par défaut** : une mise à jour ne change rien pour personne. Ils s'appliquent à
_tous_ les chemins d'import — la boîte de collage, l'API, le CLI et un scan — parce qu'ils
décident si une URL devient un job, pas ce qu'un tag finira par dire.

| Réglage               | Ce qu'il refuse                                                                |
| --------------------- | ------------------------------------------------------------------------------ |
| `officialUploadsOnly` | une vidéo dont la description ne porte pas la ligne « Provided to YouTube by » |
| `requireAlbum`        | une vidéo **isolée** à laquelle aucun album n'est rattaché                     |

`officialUploadsOnly` lit la **description**, jamais le nom de la chaîne. Sur 9766 sources
réelles la ligne est présente sur 9544 et absente sur 222, tandis que le nom de chaîne est
_vide_ sur 5306 d'entre elles et ne porte le suffixe `- Topic` que sur 580 : une règle écrite
contre la chaîne refuserait plus de la moitié de la bibliothèque. La détection est celle du
parseur de description (`hasProvidedToYouTube`), insensible à la casse.

« Aucun album rattaché » est défini contre ce que l'étape `resolve` calcule déjà : ni le tag
YouTube Music `album` de l'entrée — le champ même que `resolve` compte pour distinguer un album
d'une playlist — ni la ligne d'album de la description auto-générée. « Isolée » est le `kind`
`single` de `resolve` : une entrée _dans_ une playlist n'est jamais concernée, la playlist
étant l'album.

Le refus prend trois formes selon le chemin :

- **une URL collée** est refusée, avec l'erreur typée `SOURCE_NOT_OFFICIAL` ou
  `SOURCE_NO_ALBUM` (HTTP 422). La ligne `imports` est quand même écrite, en `failed`, avec la
  même erreur : c'est la trace de ce qui a été demandé ;
- **une entrée dans une playlist** est ignorée — aucune ligne `import_tracks`, une ligne
  `resolve.skipped` dans le journal nommant la vidéo et la raison, et le reste de la playlist
  s'importe normalement. Si _toutes_ les entrées sont refusées, l'étape échoue ;
- **une vidéo trouvée par une source surveillée** est ignorée comme n'importe quel autre
  filtre : `watched_source_items.status = 'skipped'` avec la raison sur la ligne, et aucun
  import ouvert. Cela coûte une extraction complète par vidéo nouvelle (une liste à plat ne
  porte pas de description), ce qui est exactement la raison d'être de l'interrupteur par
  source `requireProvidedToYouTube` — lequel _ajoute_ à la règle globale sans jamais la lever.

Pour poser la question **avant** d'importer, sans rien créer :

```bash
curl -s -H "Authorization: Bearer $MM_API_KEY" \
  "https://<hôte>/api/v1/tools/url?url=<url>" | jq '{official, officialEntries, admissible, refusedReason, rules}'
```

---

## 5 ter. Cookies YouTube (vidéos avec restriction d'âge)

yt-dlp, anonyme, échoue sur trois cas : une vidéo avec restriction d'âge, un contrôle
anti-robot (« Sign in to confirm you're not a bot »), et certaines vidéos réservées aux
membres d'une chaîne. Le toolbox nomme les deux premiers `YTDLP_AGE` et `YTDLP_BOT_CHECK`
(`services/toolbox/src/toolbox/errors.py`) ; les deux demandent la même chose : une session
YouTube authentifiée, sous la forme d'un `cookies.txt` au format Netscape.

### Exporter les cookies d'un navigateur

Avec le navigateur **connecté au compte Google du propriétaire de l'installation** (le compte
dont l'historique YouTube tolère ce qui va être téléchargé) :

1. Installez une extension qui exporte au format Netscape — « Get cookies.txt LOCALLY »
   (Chrome, Firefox) est celle utilisée pour écrire ce paragraphe. `yt-dlp --cookies-from-browser
chrome` fonctionne aussi si `yt-dlp` tourne sur la machine qui a le navigateur, ce qui n'est
   en général pas le cas du toolbox (il tourne dans un conteneur sans profil de navigateur).
2. Ouvrez `youtube.com`, vérifiez que vous êtes connecté au bon compte.
3. Exportez : l'extension produit un fichier texte commençant par
   `# Netscape HTTP Cookie File`, une ligne par cookie, sept champs séparés par des
   tabulations (`domaine, sous-domaines, chemin, sécurisé, expiration, nom, valeur`).
4. Gardez ce fichier hors du dépôt. Ce n'est l'affaire de personne d'autre que de
   l'installation elle-même — voir l'avertissement plus bas.

### Le charger : Console ou API

Deux modes, réglés par `cookiesMode` (Settings → Downloader → Authentication, ou
`cookiesMode` dans l'API des réglages) :

| Mode    | Où vit le jar                                          | Quand l'utiliser                                                                                                     |
| ------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `paste` | Collé entier dans `cookiesText`, en base (`pgdata`)    | Le cas normal en production : personne n'a de chemin de fichier à l'intérieur du conteneur toolbox.                  |
| `file`  | Un chemin (`cookiesFile`) que le conteneur toolbox lit | Pratique en local, si vous préférez déposer un fichier sur le disque plutôt que coller un secret dans un formulaire. |

**Par la Console** — Settings → Downloader → Authentication :

- `paste` : choisissez « Paste cookies.txt », collez l'export entier dans le champ, Save. Le
  formulaire ne réaffiche jamais le contenu collé (il montre `set (…)`) ; cliquer dedans
  l'efface pour un nouveau collage, ce qui est le seul moyen de le remplacer.
- `file` : choisissez « cookies.txt file », déposez le fichier là où `cookiesFile` pointe.
  `docker-compose.dev.yml` monte `./.local/cookies` sur `/data` (lecture seule) dans le
  conteneur toolbox de développement — déposez-y `cookies.txt` et réglez `cookiesFile` sur
  `/data/cookies.txt` (c'est déjà le texte indicatif du champ). En production,
  `docker-compose.prod.yml` fait la même chose avec le volume `cookies`
  (`MM_COOKIES_PATH` dans `.env` pour un chemin hôte plutôt que le volume nommé par
  défaut) — voir §3.

**Par l'API**, avec une clé portant `settings:write` :

```bash
# coller le jar (le corps entier du cookies.txt exporté, tel quel)
curl -X PATCH https://music.example.com/api/v1/settings \
  -H "x-api-key: mm_…" -H "content-type: application/json" \
  -d "$(jq -n --arg text "$(cat cookies.txt)" \
        '{cookiesMode: "paste", cookiesText: $text}')"

# ou, en mode file, une fois le fichier déjà en place dans le volume `cookies`
curl -X PATCH https://music.example.com/api/v1/settings \
  -H "x-api-key: mm_…" -H "content-type: application/json" \
  -d '{"cookiesMode": "file", "cookiesFile": "/data/cookies.txt"}'
```

`mm settings set cookiesMode paste` / `mm settings set cookiesText "$(cat cookies.txt)"`
fait la même chose depuis `docker compose exec web sh`, pour qui préfère ne pas faire
transiter le jar par une invite de commande qui log ses arguments.

### Vérifier qu'il est chargé et valide

Tools → « Cookies » (ou `GET /api/v1/tools/cookies`, ou le bouton **Test** à côté du champ
dans Settings → Downloader) répond immédiatement, sans toucher YouTube — `/cookies/test` du
toolbox ne fait que lire et parser le fichier :

```json
{
  "ok": true,
  "cookies": 23,
  "domains": [".youtube.com"],
  "authenticated": true,
  "expiresAt": "2027-03-01T12:00:00Z",
  "expired": 0,
  "problems": []
}
```

`ok` est vrai seulement si les trois tiennent à la fois : au moins un cookie a été compris,
`authenticated` (une des six cookies de session YouTube — `SAPISID`, `__Secure-3PSID`,
`__Secure-1PSID`, `SID`, `SSID`, `HSID` — est présente) et `expired = 0`. Un `problems`
non vide donne la raison précise (« no YouTube session cookie present », « expected 7
tab-separated fields »…) — c'est un jar copié à moitié ou exporté dans le mauvais format qui
en dit le plus.

### Durée de vie, et ce que dit l'expiration

Les cookies de session Google portent en général une expiration à un ou deux ans, mais Google
peut invalider la session bien avant cette date — changement de mot de passe, déconnexion « de
partout », activité jugée suspecte. `expiresAt` est la plus proche des échéances déjà écrites
dans le jar (`null` si tous les cookies sont des cookies de session, sans expiration propre) ;
`expired` compte celles déjà passées. Rien ne prévient à l'avance : un jar qui fonctionnait
hier échoue net le jour où Google referme la session, et le symptôme est le retour de
`YTDLP_AGE` ou `YTDLP_BOT_CHECK` sur exactement les imports qui en avaient besoin. Depuis
cette page, l'erreur d'un import (`/imports/:id`) et le décodeur d'erreurs de Tools portent
tous les deux un bouton « Configure cookies » qui ramène ici — pas la peine d'aller chercher
où se trouve le formulaire. Il n'y a rien d'autre à faire que ré-exporter et recoller un jar
frais.

> **Avertissement.** Ce jar authentifie l'installation **en tant que le compte Google du
> propriétaire** — c'est un mot de passe, pas un identifiant technique. Ne le collez jamais
> dans un ticket, un commit, un message de support ou les journaux de l'application (`AGENTS.md`
> l'interdit déjà pour toute donnée sensible, et un cookie l'est autant qu'une clé d'API). Ne le
> partagez avec personne : quiconque le détient peut se faire passer pour ce compte sur
> YouTube. `.local/cookies/` est ignoré par git, et le volume `cookies` de production n'est pas
> touché par `backup.sh` (§6) — mais **un jar collé (`cookiesMode: paste`) l'est**, indirectement :
> `cookiesText` est une colonne de `settings`, et `postgres.dump` dans l'archive de sauvegarde
> est un `pg_dump` de la base entière, pas seulement d'`export.json` qui, lui, exclut les
> secrets. Traitez chaque archive de sauvegarde avec la même prudence que `.env` dès qu'un jar
> collé est en usage.

Si le jar ne passe pas, ou si vous ne voulez pas en installer un, la vidéo n'est pas perdue
pour autant : le §5 quinquies explique comment donner directement le fichier à la piste.

---

## 5 quater. Le rythme de préparation

Avant qu'un seul octet d'audio ne soit téléchargé, un import traverse trois étapes —
`resolve` (yt-dlp lit la source), `match` (MusicBrainz) et `confirm`. C'est la **préparation**,
et elle a sa propre file : `import.step`.

Le réglage `importStepConcurrency` dit combien d'imports peuvent être préparés en même temps.
Il vaut **4** par défaut, entre 1 et 8.

> **Le créneau de téléchargement, lui, reste à un.** C'est la règle sur laquelle tout le reste
> repose : une file `download` en politique `singleton`, un seul consommateur, et un toolbox qui
> répond `409 LOCKED` à un second appelant. `importStepConcurrency` ne s'en approche pas, et
> aucun réglage ne l'ouvre.

### Ce que ça change, et ce que ça ne change pas

Sur quelques centaines d'imports mis en file d'un coup, la valeur 1 — celle qui était codée en
dur — préparait environ quatre imports par minute : le dernier d'un lot de 380 attendait donc
près de deux heures avant que son téléchargement puisse seulement commencer.

Monter la concurrence **n'accélère pas linéairement**, et il vaut mieux savoir pourquoi avant
de mettre 8 : `match` est essentiellement du MusicBrainz, et MusicBrainz, c'est **une requête
par seconde pour l'installation entière**, tous processus confondus
(`apps/web/src/server/integrations/rate-gate.ts`). Les préparations parallèles font la queue
devant ce portillon ; ce qu'elles se recouvrent réellement, c'est l'extraction yt-dlp, le
travail en base et l'attente des unes pendant que les autres parlent.

Mesures faites sur la machine de développement (24 imports de l'album de 15 vidéos du jeu de
fixtures, réponses MusicBrainz déjà en cache) :

| `importStepConcurrency` | 24 imports préparés en | débit   |
| ----------------------- | ---------------------- | ------- |
| 1                       | 23,9 s                 | 60/min  |
| 2                       | 12,0 s                 | 120/min |
| 4                       | 6,2 s                  | 232/min |
| 8                       | 3,5 s                  | 415/min |

Et la mesure qui plafonne tout le reste : un `match` d'album de 15 vidéos émet **exactement 10
requêtes MusicBrainz** (relevé dans `job_steps.result.budget`, n = 24, min = max = 10). Cache
froid, cela fait **10 secondes par import qu'aucune concurrence n'enlève**. Un lot de 380
albums inconnus met donc environ une heure à se préparer quoi qu'on mette ici, contre une
heure trente à concurrence 1 ; c'est un gain d'un facteur 1,5, pas de 4. Le facteur 4, on
l'obtient sur le cas courant — un import en masse qui revisite les mêmes artistes et les mêmes
groupes de sortie, où le cache répond et où il ne reste que le travail local.

**4 est donc le compromis :** il prend l'essentiel du gain quand le cache est chaud, et
au-delà on ne fait qu'ajouter des `resolve` simultanés sur un seul conteneur toolbox pour
attendre au même portillon. Montez à 6 ou 8 si votre cache MusicBrainz est déjà bien rempli et
que la machine a les cœurs ; redescendez à 1 ou 2 si le toolbox est à l'étroit.

```bash
docker compose exec web bun run mm -- settings set importStepConcurrency 6
docker compose restart worker    # la valeur est lue au démarrage du worker
```

Le réglage voisin `localStepConcurrency` (défaut 3) gouverne l'autre moitié du pipeline —
empreinte, tags et classement, par piste. Les deux sont indépendants.

---

## 5 quinquies. Adopter un fichier local comme source d'une piste

Trois situations où le téléchargement ne se produira pas, et où le fichier existe pourtant :

- **la vidéo a été supprimée.** Le listing de la playlist la nomme encore, MusicBrainz connaît
  encore l'enregistrement, et il ne manque que l'audio — que vous avez, depuis un rip ou une
  sauvegarde. Le toolbox répond `YTDLP_UNAVAILABLE` ou `YTDLP_PRIVATE`.
- **la vidéo est derrière un contrôle d'âge** (`YTDLP_AGE`) et le jar de cookies du §5 ter ne
  passe pas, ou vous ne voulez pas en installer un.
- **vous reprenez une bibliothèque existante.** Les fichiers sont déjà sur la machine ; tout
  l'intérêt est qu'ils ne soient pas re-téléchargés.

Adopter un fichier, c'est le donner à **une piste précise d'un import déjà confirmé**. Le
fichier est déposé là où `download` l'aurait déposé, la piste reprend à l'étape suivante —
empreinte, tags, classement — et **aucun octet n'est téléchargé pour cette piste** : l'étape
`download` relit le disque avant de décider, trouve le fichier et le compte comme réutilisé.

> **Un import déjà en échec est rouvert.** Quand la piste ratée avait fait conclure l'album
> `Failed`, l'adoption remet l'import en file — sinon rien ne bougerait, le pipeline refusant
> par construction de travailler sur un job terminé. Cette reprise **retente aussi les autres
> vidéos mortes du même album**, ce qui après une intervention humaine est le bon défaut, mais
> coûte quelques minutes de tentatives yt-dlp. La réponse de l'API le dit : `reopened: true`.

> Ce n'est pas la reprise d'une bibliothèque v1 entière : celle-là, c'est
> `docs/migration-v1.md`, et elle fait bien davantage (décisions, pochettes, regroupement).
> Cette procédure-ci est piste par piste.

### Par où arrivent les octets

Deux formes, et le même contrôle pour tout le reste :

| Forme              | Quand                                                                                                                            | Ce qui voyage                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Chemin serveur** | Le fichier est déjà sur la machine qui fait tourner Music Manager : reprise de bibliothèque, montage NAS, dossier déposé en SSH. | Rien. Le fichier est copié sur place.    |
| **Téléversement**  | Le fichier est sur votre poste. C'est la forme de la Console.                                                                    | Le fichier, en base64, 64 Mo au maximum. |

### Ouvrir un dossier à la lecture : `adoptSourceRoots`

**Un chemin arrivant dans un corps de requête HTTP est une primitive de lecture de fichier.**
Sans garde-fou, `{"path": "/etc/shadow"}` copierait ce fichier dans la bibliothèque sous un nom
en `.opus` et le tagueur le relirait. Le réglage `adoptSourceRoots` est ce garde-fou : il liste
les répertoires absolus dont un chemin peut être accepté. **Il est vide par défaut**, et vide
veut dire « la bibliothèque, et rien d'autre ».

Le chemin est résolu avant d'être comparé — `..` est réduit, et les liens symboliques sont
suivis (`realpath`), de sorte qu'un lien posé dans un dossier autorisé ne peut pas pointer en
dehors. Un chemin refusé répond `ADOPT_PATH_REFUSED` (403).

```bash
docker compose exec web bun run mm -- settings set adoptSourceRoots '["/srv/ancienne-bibliotheque"]'
docker compose exec web bun run mm -- settings get adoptSourceRoots
```

Le chemin est celui que **le serveur** voit, pas celui de votre poste. Le téléversement n'est
pas concerné : il n'ouvre aucun chemin.

### Depuis la Console

1. Ouvrez l'import : **Jobs → l'import → tableau Tracks**.
2. Sur la ligne de la piste en échec (badge `Failed`, code d'erreur en dessous), deux boutons :
   **Retry track**, et à côté l'icône **« Adopt a local file »**.
3. La boîte de dialogue propose **Upload a file** (le fichier est sur votre poste) ou **A path
   on the server** (il est déjà sur la machine).
4. Validez. La piste repasse en `downloaded`, l'erreur est effacée, et l'empreinte démarre.

### Depuis l'API

```bash
# le fichier est déjà sur le serveur
curl -sS -X POST "$MM_URL/api/v1/imports/imp_01.../tracks/itr_01.../file" \
  -H "x-api-key: $MM_TOKEN" -H 'content-type: application/json' \
  -d '{"source":"path","path":"/srv/ancienne-bibliotheque/Daft Punk/Discovery/03.flac"}'

# le fichier est ici
curl -sS -X POST "$MM_URL/api/v1/imports/imp_01.../tracks/itr_01.../file" \
  -H "x-api-key: $MM_TOKEN" -H 'content-type: application/json' \
  -d "$(jq -n --arg n '03.flac' --arg c "$(base64 -w0 03.flac)" \
        '{source:"upload",filename:$n,content:$c}')"
```

La réponse donne le chemin retenu, la taille, le codec lu par ffprobe et l'étape suivante :

```json
{
  "path": ".mm-work/imp_01.../itr_01....flac",
  "bytes": 41234567,
  "codec": "flac",
  "via": "path",
  "originalName": "03.flac",
  "nextStep": "fingerprint",
  "queued": true,
  "reopened": false
}
```

Les identifiants de pistes (`itr_…`) se lisent dans `GET /api/v1/imports/{id}`, champ `tracks`.

### Depuis le CLI, et depuis un agent

```bash
# sur le serveur : par chemin
bun run mm -- adopt imp_01... itr_01... --file '/srv/ancienne-bibliotheque/.../03.flac'

# à distance : --file téléverse depuis cette machine-ci
bun run mm -- --url https://music.exemple.fr --token mm_… \
  adopt imp_01... itr_01... --file './03.flac'
# …ou --server-path pour un fichier déjà présent là-bas
```

Un agent MCP dispose du même outil, `adopt_track_file`.

### Ce que les tags diront

Le document de métadonnées dit la vérité sur la provenance, et il continue de la dire après un
re-tag : la trace est écrite dans `import_tracks.raw`, d'où le document est reconstruit.

| Champ                    | Fichier téléchargé                                   | Fichier adopté                                                                                                |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `COMMENT`                | `Source: youtu.be/… · imported … by Music Manager …` | `Adopted local file "03.flac" on 2026-09-17 · not downloaded from youtu.be/… · imported … by Music Manager …` |
| `ORIGINALFILENAME`       | `<id vidéo>.<ext>`                                   | le nom du fichier adopté                                                                                      |
| `ENCODEDBY`              | la version de yt-dlp                                 | n/a — « the file was adopted from disk, not downloaded »                                                      |
| `MUSICMANAGER_SOURCEURL` | l'URL de la vidéo                                    | **inchangé** : l'URL de la vidéo                                                                              |

`MUSICMANAGER_SOURCEURL` reste l'URL de la vidéo à dessein. C'est l'**identité** de la piste —
ce sur quoi la reprise v1, le scan de bibliothèque et le re-tag se recalent — et non une
affirmation sur l'origine des octets ; c'est `COMMENT` qui porte celle-là, en toutes lettres.

### Les refus, et ce qu'ils demandent

| Code                       | Ce qui s'est passé                                                                     | Quoi faire                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADOPT_UNSUPPORTED` (415)  | Le conteneur n'est pas de ceux où le tagueur sait écrire.                              | Convertir vers `.opus .ogg .oga .flac .mp3 .mp2 .m4a .mp4 .m4b .aac`. Un `.webm` se remuxe en `.opus` par copie de flux, sans perte : `ffmpeg -i in.webm -c copy out.opus`. |
| `ADOPT_NOT_AUDIO` (415)    | ffprobe n'a trouvé aucun flux audio.                                                   | Vérifier le fichier : une pochette, une vidéo ou une archive renommée passent l'extension, pas celle-ci. Rien n'est conservé.                                               |
| `ADOPT_CONFLICT` (409)     | La piste a déjà un fichier, dans le répertoire de travail ou dans la bibliothèque.     | **Retry track** d'abord : c'est ce qui efface le fichier existant.                                                                                                          |
| `ADOPT_PATH_REFUSED` (403) | Le chemin est hors bibliothèque et hors `adoptSourceRoots`.                            | Ajouter le dossier au réglage, ou téléverser le fichier.                                                                                                                    |
| `ADOPT_NOT_READY` (409)    | L'import est annulé, ou pas encore confirmé, ou cette vidéo n'est liée à aucune piste. | Confirmer la sortie et le mapping d'abord : sans enregistrement MusicBrainz lié, il n'y a rien à quoi rattacher le fichier.                                                 |
| `413`                      | Le téléversement dépasse 64 Mo.                                                        | Poser le fichier sur le serveur et l'adopter par chemin.                                                                                                                    |

### Reprendre une bibliothèque existante, piste par piste

1. Créez les imports depuis les URL YouTube correspondantes (`mm import --from-file`) et
   confirmez-les (`mm confirm-best`) : c'est ce qui apporte les métadonnées MusicBrainz.
2. Ouvrez le dossier source : `mm settings set adoptSourceRoots '["/srv/ancienne"]'`.
3. Pour chaque piste, `mm adopt <import> <piste> --file <chemin>` — ou bouclez sur
   `GET /api/v1/imports/{id}` depuis un agent.
4. Aucun octet n'est téléchargé pour ces pistes, et le créneau unique reste libre pour les
   albums qui, eux, en ont besoin.

---

## 6. Sauvegarde et restauration

```bash
./scripts/backup.sh                      # -> backups/music-manager-<horodatage>.tar.gz
./scripts/backup.sh -o /srv/backups      # ailleurs
```

L'archive contient trois fichiers :

- `postgres.dump` — `pg_dump -Fc` de toute la base. C'est la copie qui fait foi.
- `export.json` — la projection portable : documents de métadonnées, cache brut des sources,
  réglages non secrets. Elle survit à un changement de version majeure de PostgreSQL et se lit
  sans base de données. Aucune clé d'API n'y figure : l'archive peut être jointe à un rapport
  de bug.
- `manifest.json` — date, version de l'application, et les **comptages** que `restore.sh`
  recompare après coup.

**En cron**, tous les jours à 3 h, avec quatorze jours de rétention :

```cron
0 3 * * * cd /opt/music-manager && ./scripts/backup.sh -o /srv/backups >> /var/log/mm-backup.log 2>&1
15 3 * * * find /srv/backups -name 'music-manager-*.tar.gz*' -mtime +14 -delete
```

La sauvegarde tourne à chaud : `pg_dump` prend un instantané cohérent sans arrêter quoi que ce
soit.

**La bibliothèque n'est pas dedans.** Sauvegardez-la séparément, avec l'outil qui convient à sa
taille — `restic`, `rsync`, ou un instantané du système de fichiers :

```bash
restic -r /mnt/backup/restic backup /srv/music
```

### Restaurer

```bash
./scripts/restore.sh backups/music-manager-20260907-221142.tar.gz
```

Le script démarre **postgres seul**, supprime et recrée la base, restaure dedans, puis remonte
le reste. Cet ordre n'est pas cosmétique : `web` applique les migrations en démarrant, et un
`pg_restore` dans une base déjà migrée est un affrontement entre deux définitions des mêmes
tables. Il refait ensuite les comptages et les compare au manifeste — « pg_restore a répondu
OK » et « les lignes sont là » sont deux affirmations différentes et seule la seconde vaut
quelque chose.

Séquence complète, celle du critère d'acceptation de P10 :

```bash
./scripts/backup.sh
docker compose -f docker-compose.prod.yml down -v
./scripts/restore.sh backups/<archive>.tar.gz
./scripts/smoke.sh
```

⚠ `down -v` supprime **aussi** le volume `library`. La base revient intacte, les fichiers audio
non : après cette séquence la bibliothèque est vide et les pistes de la base pointent vers des
fichiers absents (la page Quality les signale comme `missing`, et Tools sait les
re-télécharger). Une vraie restauration ne fait pas `down -v`.

---

## 7. Journaux

Les trois services écrivent du JSON sur stdout, une ligne par événement.

```bash
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f worker
docker compose -f docker-compose.prod.yml logs --since 1h | grep '"level":"error"'
```

`web` émet une ligne par requête avec sa propre durée, ce qui rend le budget de rendu serveur
mesurable depuis les journaux :

```json
{
  "at": "2026-09-07T22:15:16.669Z",
  "source": "web",
  "level": "info",
  "msg": "request",
  "method": "GET",
  "path": "/health",
  "status": 200,
  "ms": 2
}
```

Avec `jq`, la médiane et le pire cas d'une heure :

```bash
docker compose -f docker-compose.prod.yml logs --since 1h --no-log-prefix web \
  | grep '"msg":"request"' | jq -s 'map(.ms) | sort | {p50: .[length/2|floor], max: .[-1]}'
```

`MM_LOG_LEVEL` (`debug` · `info` · `warn` · `error` · `silent`) vaut pour les trois services.
Une réponse 5xx est journalisée en `error` quel que soit le niveau, et les fichiers de build en
`debug` — sinon vingt lignes utiles disparaissent sous deux cents lignes d'assets.

**Rotation.** Elle est dans le fichier compose (`json-file`, 10 Mo × 3 par service) : sans elle,
un conteneur qui journalise une exception en boucle remplit le disque. Pour envoyer les
journaux ailleurs (journald, Loki), remplacez le bloc `x-logging` en tête de
`docker-compose.prod.yml` — il est partagé par les quatre services avec une ancre YAML.

---

## 8. Navidrome

Navidrome **n'est pas** dans `docker-compose.prod.yml` : la plupart des gens qui s'auto-hébergent
en font déjà tourner un, et un second se battrait pour le même port et la même bibliothèque. Un
service d'exemple est commenté en bas du fichier ; deux points comptent.

**Le montage est en lecture seule.** `- ${MM_LIBRARY_PATH:-library}:/music:ro`. Music Manager
possède ces fichiers et la base est la source de vérité de ce qu'ils contiennent ; un scanner
qui écrit dedans crée une dérive que la page Quality signalera sans pouvoir l'expliquer.

**Le volume, pas une copie.** Si votre Navidrome est en dehors de cette pile, faites pointer les
deux sur le même répertoire hôte (`MM_LIBRARY_PATH=/srv/music` ici, `/srv/music` là-bas).

Pour brancher la Console dessus — Tools sait alors déclencher un rescan et l'étape `verify`
relit ce que le serveur affiche réellement : Settings → Integrations, URL, utilisateur, mot de
passe. La vérification par relecture OpenSubsonic est la seule preuve de ce que Feishin et
Symfonium montreront.

**Et l'interrupteur, pas seulement les identifiants.** Le réglage `navidromeEnabled` est à
l'arrêt par défaut. Une URL et un utilisateur renseignés ne suffisent pas : tant que la bascule
« Use Navidrome » est à l'arrêt, l'étape `verify` et Discover ignorent le serveur. La page
l'annonce désormais comme tel (« configured, disabled ») au lieu de dire « connected » pendant
que Discover dit « aucun serveur configuré ».

**`ND_AUTOIMPORTPLAYLISTS: "false"`.** Navidrome importe par défaut tout `.m3u` trouvé sous le
dossier musical comme une playlist à lui. Cette installation gère ses playlists par l'API
Subsonic — Discover en pousse une, remplacée et jamais dupliquée — et l'export de la reprise v1
vit dans `<bibliothèque>/.mm-archive/v1-playlists/`, hors du champ du scanner. L'import
automatique n'a donc rien à apporter et un moyen de surprendre ; le service commenté de
`docker-compose.prod.yml` le coupe. Voir `docs/migration-v1.md` si des doublons sont déjà là.

---

## 9. Sécurité

Ce qui est en place, et ce que cela n'est pas.

- **Tout est derrière la session**, sauf `/health` et `/api/auth/*`. Un test unitaire le
  vérifie route par route, y compris les server functions.
- **Un seul compte.** L'inscription publique est fermée ; `/setup` ne répond que tant que la
  table des utilisateurs est vide.
- **Le toolbox n'a aucun port publié.** Il n'est joignable que depuis le réseau compose.
  `docker compose -f docker-compose.prod.yml ps` le montre : la ligne `toolbox` porte
  `8100/tcp` et aucune correspondance vers l'hôte. `MM_TOOLBOX_TOKEN` ajoute un jeton porteur
  si vous voulez une défense contre ce qui serait déjà à l'intérieur du réseau.
- **Postgres non plus.** Les sauvegardes passent par `docker compose exec`, pas par un port.
- **En-têtes** sur chaque réponse : `Content-Security-Policy` (pas de `unsafe-eval`,
  `frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, et
  `Strict-Transport-Security` quand `MM_BEHIND_PROXY=1`.
- **Limite de débit** : dix tentatives de connexion par tranche de cinq minutes, six cents
  requêtes API/MCP par minute (`MM_RATE_LIMIT_LOGIN`, `MM_RATE_LIMIT_API` ; `0` désactive).
  C'est un compteur **en mémoire du processus** : il repart à zéro au redémarrage et ne
  distingue les clients que si `MM_BEHIND_PROXY=1` (il lit `X-Forwarded-For`). Sur une machine
  exposée à Internet, mettez la vraie limite dans le reverse proxy — celle-là survit à un
  redémarrage.
- **Les secrets ne passent que par l'environnement.** Aucun n'entre dans une couche d'image,
  aucun n'apparaît dans un journal, aucun n'est exporté par `backup.sh`. `chmod 600 .env`.
- **Les conteneurs tournent en non-root** (uid 10001 dans les deux images).

Ce qui n'y est **pas** : pas de 2FA, pas de multi-utilisateur, pas de haute disponibilité, pas
de chiffrement au repos. C'est une application auto-hébergée à compte unique et c'est assumé
(`docs/phases/P10-production.md` § Hors périmètre).

---

## 10. Quand ça ne marche pas

**« Invalid origin » à la connexion.** `MM_WEB_URL` ne correspond pas à l'origine du navigateur.
Comparez exactement : schéma, hôte, port, pas de `/` final. `http://localhost:3200` et
`http://127.0.0.1:3200` sont deux origines différentes.

**Le conteneur `web` redémarre en boucle.** `docker compose logs web` : neuf fois sur dix c'est
la connexion à postgres ou une variable manquante, et le message le dit. Les migrations sont la
première chose qui tourne, donc une erreur de schéma apparaît avant la première requête.

**Le worker ne prend aucun job.** Il n'a pas de healthcheck Docker (il n'a pas de serveur HTTP)
— son signe de vie est un battement en base, lisible dans Tools → « Worker » et par
`get_status`. `docker compose logs worker` doit montrer `worker ready` avec la bonne URL de
toolbox.

**Un déploiement a-t-il perdu le lot en cours ?** Non, et il ne faut plus de veilleur externe
pour s'en assurer. Au démarrage le worker vide ses propres files — un `download` fantôme
tiendrait sinon l'unique créneau six heures — puis remet en file **tout import non terminé qui
n'attend pas une décision humaine**, exactement un message par import. Trois cas, et le journal
de démarrage les compte séparément :

```
{"message":"resume sweep","trigger":"boot","resumed":12,"skipped":0,
 "paused-by-shutdown":2,"waiting-upstream-due":9,"running-orphan":1}
```

- `paused-by-shutdown` — le worker précédent les avait mis en pause en s'arrêtant. Une pause
  demandée par vous (bouton Pause, `mm pause`) porte `paused_by = 'user'` et **n'est jamais**
  reprise par un redémarrage : c'est la seule différence entre les deux, et elle est en base.
- `waiting-upstream-due` — ils attendaient une source occupée. Le message différé a disparu
  avec la file ; l'attente restante est relue dans `imports.next_attempt_at`, donc une échéance
  déjà passée repart tout de suite et une échéance future repart à l'heure dite.
- `running-orphan` — le worker a été tué en plein travail. Rien ne les aurait relancés : tout
  est mis en file avec `retryLimit: 0`, pour qu'un téléchargement à moitié fait ne reparte pas
  en aveugle.

Chaque import reprend aussi une ligne de journal qui dit laquelle des trois raisons le
concerne, visible sur sa page. Le même balayage repasse toutes les deux minutes, pour le cas
d'un message perdu par un handler mort en vol ; il ne regarde que les lignes qui n'ont pas bougé
depuis dix minutes et ne remet jamais en file un import qui détient déjà un message.

**Une piste reste en `Failed` et ne se rattrapera jamais.** Regardez son code d'erreur.
`YTDLP_UNAVAILABLE` et `YTDLP_PRIVATE` disent que la vidéo n'existe plus : aucun Retry ne la
fera revenir. `YTDLP_AGE` et `YTDLP_BOT_CHECK` demandent un jar de cookies (§5 ter), et s'il ne
passe pas, la voie de sortie est la même dans les trois cas — donner directement le fichier à
la piste, §5 quinquies.

**Un lot de plusieurs centaines d'imports met des heures avant le premier téléchargement.**
C'est la préparation, pas le téléchargement. Voir §5 quater et `importStepConcurrency`.

**Tout échoue en `422` sur le toolbox.** Les deux images ne viennent pas du même commit. Voir
§4 ; Tools affiche la comparaison des hash de contrat.

**Un import `fixture://` échoue en `OFFLINE_CACHE_MISS`.** Le mode fixtures ne _fabrique_ pas
les réponses de MusicBrainz, il rejoue des enregistrements rangés dans la table `source_cache`,
et une base neuve n'en a aucun. Amorcez-la :

```bash
docker compose -f docker-compose.prod.yml exec web \
  bun /app/apps/web/src/server/integrations/seed-fixtures.ts
```

Cela ne concerne que le mode démonstration hors ligne (`MM_FIXTURES=1` **et**
`MM_TOOLBOX_FIXTURES=1`, les deux) ; une installation réelle n'en a pas besoin.

**La page Jobs n'affiche pas tous mes imports.** Elle s'ouvre sur « Active » et non sur
« All » : sur une instance qui a quelques centaines d'imports, les annulés sont la majorité des
lignes et enterrent celles qui avancent. Les puces comptent la table entière, pas la page — « All
388 · Active 70 · Cancelled 275 » — et « All » comme « Cancelled » sont à un clic. La liste est
paginée par cinquante ; le filtre et la page sont dans l'URL, donc `/imports?status=cancelled&
page=1` est un lien qu'on peut envoyer et qui survit à un rechargement. L'ordre est « ce qui
bouge d'abord » : les jobs en cours, puis ceux qui attendent une décision, puis la file, et les
annulés en dernier ; à statut égal, le plus récemment avancé passe devant.

**La carte Worker montre toujours le même import.** Elle nomme désormais l'import qui détient
réellement l'unique créneau de téléchargement (la ligne `job_steps` `download`/`running`), pas
un job « running » pris au hasard dans la file — un import déjà pris en charge reste `running`
tant qu'il attend son tour, et ils sont parfois quarante-cinq dans ce cas. Le compteur
« N queued » compte tout ce qui attend le worker, moins celui qui l'occupe. Quand rien ne
télécharge, la carte le dit ; si le worker est en train de finir un album (fingerprint, tag,
place), elle nomme le dernier import qui a bougé, avec la mention « finishing up ». La ligne
« moved … » donne l'âge du dernier mouvement : figée, c'est le worker qui est bloqué, pas la
page.

**Des imports restent en « Waiting on source ».** Ce n'est pas une panne : une source a refusé
(429, 5xx, délai dépassé) et l'import est retourné dans la file avec une attente qui double à
chaque essai. La ligne dit qui a refusé, le numéro de l'essai et l'heure du suivant ; personne
n'a rien à faire. Au-delà de `upstreamMaxAttempts` essais (six par défaut) le job se termine en
`failed` sous le code `UPSTREAM_UNAVAILABLE`, qui signifie « la source », jamais « le fichier ».
Les trois réglages : `upstreamMaxAttempts`, `upstreamBackoffBaseMs`, `upstreamBackoffMaxMs`.

**Relancer d'un coup tous les imports tués par une source.** Après une panne longue :

```bash
docker compose -f docker-compose.prod.yml exec web mm retry --failed-upstream --dry-run
docker compose -f docker-compose.prod.yml exec web mm retry --failed-upstream
```

La sélection ne retient que les échecs dus à une source — un 404 ou une réponse illisible n'est
jamais repris, il attend un humain. L'opération est idempotente : les jobs relancés ne sont plus
`failed`, donc un second appel ne reprend rien. Équivalents : `POST
/api/v1/imports/retry-failed-upstream` et le bouton « Retry source failures » de la page Jobs.

**`MB_CONTACT_MISSING` sur un import.** `MM_MB_CONTACT` (ou le réglage `mbContact`) est vide.
MusicBrainz compte les requêtes par User-Agent ; sans contact, toutes les installations de cette
application partagent le même, et c'est celui qui est le plus durement limité — donc une requête
sortante est refusée plutôt qu'envoyée anonymement. Mettez-y une adresse e-mail ou une URL. Le
cache et le mode fixtures ne sont pas concernés : le refus a lieu au moment où une requête part.

**La page Tools met huit secondes à s'afficher.** Elle sonde les sources externes
(MusicBrainz, Deezer, LRCLIB…) pendant le rendu serveur, avec un délai de garde de huit
secondes chacune. Sans réseau sortant, elles expirent toutes. Les autres pages ne font rien de
tel et répondent en quelques dizaines de millisecondes.

**Une commande dans le conteneur.** L'entrypoint accepte des rôles :

```bash
docker compose -f docker-compose.prod.yml exec web mm jobs
docker compose -f docker-compose.prod.yml exec web mm import 'https://…' --yes
docker compose -f docker-compose.prod.yml run --rm web migrate
docker compose -f docker-compose.prod.yml exec web sh
```
