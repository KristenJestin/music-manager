# Migration v1 → v2

Procédure d'exploitation. Le _pourquoi_ est dans `../../docs/phases/P11-migration-v1.md` ;
ce document est ce qu'on suit le jour où on la lance.

La migration reprend la bibliothèque et la base de la v1 **sans rien re-télécharger** : chaque
fichier existant devient une piste v2 avec un document de métadonnées complet, re-tagué en
place ; ce que la v1 n'avait jamais téléchargé devient un import v2 prêt pour le wizard.

« Sans rien re-télécharger » ne veut pas dire hors ligne : `documents.build` a besoin de joindre
MusicBrainz pour compléter chaque document à partir des MBID que la v1 avait trouvés (et Cover
Art Archive / AcoustID selon les sources actives dans Settings). `--dry-run` ne le prouve jamais,
puisqu'il ne construit aucun document — voir §6.

---

## 1. Ce qu'il faut avant de commencer

| Prérequis                      | Pourquoi                                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Une sauvegarde**             | La migration réécrit les tags de **tous** les fichiers. Sans acquittement, la commande refuse de démarrer.                                                                                                                       |
| Base v1 joignable              | Une chaîne `postgres://…` valide. Elle est ouverte **en lecture seule** et n'est jamais modifiée.                                                                                                                                |
| Dossier v1 en lecture-écriture | Les fichiers sont re-tagués sur place et les sidecars écrits à côté.                                                                                                                                                             |
| Toolbox en marche              | `/probe`, `/tag`, `/replaygain`. `GET localhost:8100/health` doit répondre.                                                                                                                                                      |
| Worker en marche               | La file `migrate` est consommée par lui. Sans worker, le bouton de Tools met un job en file que personne ne prend.                                                                                                               |
| Accès réseau sortant           | `documents.build` interroge MusicBrainz pour chaque MBID v1 (Cover Art Archive / AcoustID selon les sources actives). Sans réseau, chaque piste échoue avec une erreur explicite plutôt que de se construire à moitié — voir §6. |

### Le point qui surprend : les deux bibliothèques n'en font qu'une

La migration **garde les chemins v1** (§ Étapes 3) parce que Navidrome identifie un fichier par
son chemin : renommer ferait perdre les compteurs de lecture et les favoris. Donc, après
migration, la bibliothèque v1 _est_ la bibliothèque v2.

Concrètement :

```
MM_LIBRARY_ROOT          = le dossier de sortie de la v1 (ProcessingSettings.OutputDirectory)
MM_TOOLBOX_LIBRARY_ROOT  = ce même dossier, vu depuis le conteneur toolbox
```

`--library` doit donc désigner `MM_LIBRARY_ROOT` ou un sous-dossier. La commande refuse tout
autre chemin avec un message qui le dit : la toolbox ne peut lire que ce qui est sous la racine
montée, et un chemin stocké en base doit être relatif à cette racine.

---

## 2. La répétition générale, sur une copie

**À faire au moins une fois.** La v1 n'a pas de bouton « annuler ».

```bash
# 1. une copie de la bibliothèque, et une copie de la base
cp -a /srv/music /srv/music-copy
pg_dump "$V1_DATABASE_URL" | psql "postgres://…/v1_copy"

# 2. pointer v2 sur la copie
export MM_LIBRARY_ROOT=/srv/music-copy
export MM_TOOLBOX_LIBRARY_ROOT=/library        # selon le montage du conteneur

# 3. l'aperçu : ne écrit rien, nulle part
bun run mm -- migrate v1 --db "postgres://…/v1_copy" --library /srv/music-copy --dry-run

# 4. la vraie chose, sur la copie
bun run mm -- migrate v1 --db "postgres://…/v1_copy" --library /srv/music-copy --i-have-a-backup
```

Puis on vérifie sur la copie, avant de toucher à l'original :

- `bun run mm -- library albums` : les albums attendus, avec leur score ;
- `bun run mm -- verify --all` : Navidrome relit bien ce qu'on a écrit ;
- **les compteurs de lecture de Navidrome sont intacts** — c'est le critère qui décide si on
  garde les chemins ou pas, et il se vérifie sur un album qu'on a beaucoup écouté.

---

## 3. La commande

```
mm migrate v1 --db <postgres v1> --library <dossier v1>
              [--dry-run] [--rename-to-template] [--limit N] [--resume]
              [--i-have-a-backup] [--verify] [--json] [--verbose]
```

| Option                 | Effet                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`            | Inventaire, recoupement, plan — **zéro écriture** hors `migration_v1*`. Le rapport porte un compteur d'écritures.   |
| `--i-have-a-backup`    | Acquitte la sauvegarde, une fois pour toutes (`app_meta`). Sans lui, une exécution réelle refuse de démarrer.       |
| `--rename-to-template` | Applique le gabarit v2 au lieu de garder les chemins v1. **Perd les statistiques Navidrome.** Averti à chaque fois. |
| `--limit N`            | Ne lit que les N premières lignes de `Songs`. Pour un premier essai sur une grosse base.                            |
| `--resume`             | Reprend le dernier run laissé `running` au lieu d'en ouvrir un nouveau.                                             |
| `--verify`             | Relit chaque album migré via Navidrome (§ Étapes 6). Demande un Navidrome configuré.                                |
| `--json`               | Le rapport, pour un script.                                                                                         |

`V1_DATABASE_URL` et `V1_LIBRARY_PATH` sont lus quand les deux drapeaux sont absents.

Autres sous-commandes :

```bash
bun run mm -- migrate runs              # les exécutions passées
bun run mm -- migrate show <run id>     # le rapport de l'une d'elles
```

### Depuis la Console

Tools › **Migrate from v1** : le même formulaire, le même aperçu, la progression en direct
(SSE) et le même rapport. Le run part sur la file `migrate` du worker — fermer l'onglet
n'interrompt rien. La chaîne de connexion est un champ mot de passe et **ne revient jamais** :
ce que la page réaffiche est l'étiquette expurgée que le serveur a stockée.

---

## 4. Ce que la migration fait, dans l'ordre

1. **Inventaire.** Lecture de `Songs`, `SongForceMetadata`, `UserPlaylists`,
   `UserPlaylistSongs` sur une connexion **read-only** (`default_transaction_read_only`, posé à
   la connexion, re-posé sur la session, puis relu — sinon la commande refuse de continuer).
   Puis parcours du dossier et `/probe` de chaque fichier.
2. **Recoupement.** Fichier ↔ ligne par `FinalFilePath`, puis par MBID d'enregistrement
   (`MUSICBRAINZ_TRACKID`), puis par l'id YouTube du commentaire `Source: <url>`. Tout écart est
   listé dans le rapport : fichier déplacé, ligne `Present` sans fichier, fichier orphelin,
   deux lignes qui réclament le même fichier.
3. **Pistes présentes.** `library_albums` / `library_tracks`, un document amorcé depuis la v1
   (source `v1`, confiance basse ; **verrouillé** pour les champs de `SongForceMetadata`, les
   MBID forcés et les lignes marquées d'un drapeau de traitement — voir §4 bis), puis
   `documents.build` avec les MBID v1, re-tag en place au schéma courant,
   sidecars, ReplayGain par album — et les documents sont reconstruits une dernière fois pour
   que la mesure de loudness y entre aussi.
4. **Pistes non présentes.** Un import v2 par playlist parente, statut `paused` (« en file, à
   l'arrêt ») ou `awaiting_review`, les MBID forcés en présélection. **Rien n'est téléchargé.**
5. **Playlists.** Un `.m3u8` par `UserPlaylist` dans `<bibliothèque>/_archive/v1-playlists/` (ou `MM_PLAYLIST_EXPORT_DIR`) ; le dossier est créé et son accès en écriture vérifié **avant** le premier re-tag.
   Aucune donnée de playlist n'entre en v2.
6. **Vérification** (`--verify`) et items Inbox pour les écarts.
7. **Rapport** : compteurs, écarts, erreurs, en JSON sur `migration_v1_runs.report`.

### 4 bis. Les décisions de la v1 qui sont respectées

La v1 avait quatre façons de dire « n'y touche plus ». Toutes les quatre sont honorées, et la
règle est la même dans les quatre cas : le champ arrive en v2 **verrouillé**, à confiance 1,
source `v1`, et aucune source ne l'écrase jamais.

| Ce que la v1 tenait                | Ce que la v2 en fait                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SongForceMetadata`                | Un verrou par champ surchargé. Une ligne dont le champ n'a pas d'équivalent v2 est **signalée** dans le rapport (`ignoredForces`), jamais perdue en silence.                                                                                                                                                                                                 |
| `MusicBrainzForced` + les `*Force` | Les MBID d'enregistrement et de **sortie** forcés gagnent, et le MBID de sortie forcé est celui que porte l'import de l'album — pas la colonne ordinaire, souvent vide sur les albums où quelqu'un a justement dû forcer.                                                                                                                                    |
| `ForceSongMetadata`                | La v1 disait : « saute MusicBrainz, prends la ligne `Songs` telle quelle ». Tous les champs repris de cette ligne sont donc verrouillés — titre, artistes, artistes d'album, album, année, genres, numéros, label, MBID. Un champ que la v1 n'avait pas est tout de même rempli par les sources : forcer protège ce qui existe, cela n'aveugle pas le reste. |
| `ForceSourceMetadata`              | La v1 analysait la description YouTube, **réécrivait le résultat dans la ligne `Songs`** et effaçait les MBID. La ligne contient donc déjà les valeurs utilisées ; la v2 verrouille exactement les champs que cette branche affectait (titre, artistes, artistes d'album, album, année, label). Les deux drapeaux ensemble : `ForceSongMetadata` l'emporte.  |

### 4 ter. Les pochettes

C'est le point qui a coûté le plus cher, alors il est décrit en détail.

- **Un re-tag ne retire jamais l'image d'un fichier.** Le bloc de tags est réécrit en entier
  (`clear`), et sur un fichier Opus l'image _est_ un tag (`METADATA_BLOCK_PICTURE`) : la
  toolbox relit donc les images avant d'effacer et les remet si l'appelant n'en fournit pas
  (`keep_pictures`, actif par défaut). Cela vaut pour la migration comme pour le re-tag de fond
  de `docs/03-metadonnees.md` §8.
- **`SongForceMetadata.CoverArtBytes` est migré.** C'était la seule pochette que cette piste ait
  jamais eue ; elle arrive en `front_cover` verrouillé, source `v1`, et c'est elle qui est
  écrite dans le fichier.
- **La miniature YouTube reste le dernier échelon**, comme en v1 : la ligne v1 ne stockait pas
  d'URL de miniature, mais l'adresse se déduit de l'identifiant de la vidéo, et la v2 la
  reconstitue pour que l'échelon final de `docs/03-metadonnees.md` §4 fonctionne aussi sur une
  bibliothèque migrée.
- **Un fichier dont l'image n'est explicable par aucune source** — ni Cover Art Archive, ni
  miniature — ouvre un item Inbox `cover_missing`. Rien n'est perdu : l'image reste dans le
  fichier. Mais elle n'est plus reproductible, et c'est une question qui appartient à une
  personne.
- Les échecs de préparation d'image ne sont plus silencieux : ils passent par le journal de la
  migration.

### 4 quater. Les noms d'artistes

MusicBrainz tient deux noms par crédit : celui **imprimé sur cette sortie** et celui de
l'artiste. La v1 écrivait toujours le second, la v2 écrit le premier par défaut. Le réglage
_Réglages › Métadonnées › Noms d'artistes_ (`artistNameSource`) choisit :

- `credited` (défaut) — le nom crédité, ce que fait Picard ;
- `canonical` — le nom de l'artiste, **ce que reproduit la v1**. À choisir si les noms
  d'artistes d'une bibliothèque migrée doivent rester ceux que la v1 avait écrits.

Les liaisons (« feat. », « & ») viennent de MusicBrainz dans les deux cas.

### Reprise et idempotence

L'état vit dans `migration_v1`, une ligne par chanson v1, avec l'identifiant v1 **et** le chemin
où elle a fini. Une deuxième exécution sur une bibliothèque inchangée ne fait rien du tout ;
une exécution interrompue reprend là où elle s'est arrêtée. Une ligne déjà migrée dont le
fichier a bougé depuis n'est **pas** considérée comme faite — c'est tout l'intérêt d'avoir le
chemin dans la clé.

---

## 5. Après

```bash
bun run mm -- migrate show <run id>     # relire le rapport
bun run mm -- scan run                  # orphelins, manquants, dérives
bun run mm -- verify --all              # ce que Navidrome voit vraiment
bun run mm -- jobs                      # les imports créés, en pause
```

Les imports créés sont **en pause** : rien ne se télécharge tant qu'on ne les relance pas, un
par un ou en masse. C'est voulu — une migration qui lancerait vingt mille téléchargements est
une migration qu'on ne peut pas surveiller.

Les playlists exportées sont dans `_archive/v1-playlists/`. Pour les retrouver dans Navidrome,
il faut lui indiquer ce dossier (`ND_PLAYLISTSPATH`) ou copier les `.m3u8` dans la
bibliothèque.

---

## 6. Ce qui peut mal se passer

| Symptôme                                                                                        | Cause et remède                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `does not look like a v1 database`                                                              | La chaîne pointe sur la base v2, ou sur une base vide. La v1 a une table `"Songs"` en PascalCase quoté.                                                                                                      |
| `must be the v2 library root, or a directory inside it`                                         | `MM_LIBRARY_ROOT` ne désigne pas la bibliothèque v1. Voir §1.                                                                                                                                                |
| `Confirm you have a backup`                                                                     | `--i-have-a-backup`, ou la case dans Tools. C'est la seule barrière avant une réécriture de tous les fichiers.                                                                                               |
| Beaucoup de `orphan_file`                                                                       | Des fichiers que la v1 n'a jamais écrits (copies manuelles). Ils ne sont pas adoptés ; un item Inbox les liste.                                                                                              |
| Beaucoup de `missing_file`                                                                      | Des lignes `Present` dont le fichier a disparu. Elles deviennent des imports ; rien n'est perdu.                                                                                                             |
| Documents à ~90 % au lieu de 100 %                                                              | Voir « ce qui reste » ci-dessous.                                                                                                                                                                            |
| Le bouton de Tools ne fait rien                                                                 | Le worker ne tourne pas. `bun run worker`.                                                                                                                                                                   |
| `Offline: musicbrainz "release/<mbid>?inc=releaseFull" has never been fetched` sur chaque piste | Pas d'accès réseau sortant à musicbrainz.org (proxy, pare-feu). Chaque MBID v1 doit être relu une fois pour construire le document ; `--dry-run` ne le révèle jamais, puisqu'il ne construit aucun document. |

### Ce qui reste, et pourquoi

- **`acoustid`** (champ recommandé) manque sur les pistes migrées : il demande une empreinte du
  fichier et un appel AcoustID, et la migration ne fait ni l'un ni l'autre — empreinter une
  bibliothèque entière est une passe de plusieurs heures, qui enrichit plutôt qu'elle ne migre.
  Le rapport le compte explicitement (`recommendedGaps`) plutôt que de l'escamoter.
- **Les albums sans MBID en v1** gardent un document construit depuis la seule v1 : titre,
  artiste, album, genres, et les surcharges verrouillées. C'est un plancher, pas un plafond —
  le re-tag de fond (`docs/03-metadonnees.md` §8) les reprendra dès qu'une source répondra.
- **Les images intégrées par la v1** sont remplacées par celles du Cover Art Archive quand il en
  a, sinon par la miniature YouTube reconstituée ; et si aucune source ne répond, le fichier
  garde exactement ce que la v1 y avait mis, avec un item Inbox `cover_missing` pour le dire.
  Voir §4 ter.

---

## 7. Le jeu d'essai

Tout est reproductible hors ligne :

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres toolbox
bun run e2e-migrate
```

Ce script charge `fixtures/v1/dump.sql` (30 lignes `Songs`, 8 surcharges, 2 playlists) dans une
base jetable, fabrique la bibliothèque v1 en taguant des copies de l'échantillon de la toolbox
**avec le jeu de tags de la v1**, puis migre, re-migre (no-op) et imprime le rapport.

`fixtures/v1/dataset.ts` est la source unique ; `dump.sql` en est engendré
(`bun run fixtures:v1`) et ne s'édite pas à la main.
