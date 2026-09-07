# Déploiement

Music Manager en production : quatre conteneurs, un fichier `.env`, un reverse proxy devant.
Cible : un serveur Linux avec Docker. Tout ce qui suit a été exécuté tel quel sur la pile de
test de P10 (`orchestration/reports/P10-build-1.md`).

- [1. Première installation](#1-première-installation)
- [2. Le reverse proxy](#2-le-reverse-proxy)
- [3. Où sont les données](#3-où-sont-les-données)
- [4. Mise à jour](#4-mise-à-jour)
- [5. yt-dlp seul](#5-yt-dlp-seul)
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

Trois volumes, nommés par défaut — rien à créer à la main.

| Volume    | Contenu                                              | Perte = ?                                  |
| --------- | ---------------------------------------------------- | ------------------------------------------ |
| `pgdata`  | PostgreSQL : la **source de vérité** des métadonnées | catastrophique ; c'est ce qu'on sauvegarde |
| `library` | la musique, partagée avec le toolbox (et Navidrome)  | grave, mais re-téléchargeable              |
| `cache`   | le scratch du toolbox (`TMPDIR`) : recadrages, scans | aucune conséquence                         |

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
