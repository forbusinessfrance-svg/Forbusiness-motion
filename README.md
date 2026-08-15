# ForBusinessFrance — « Des leads qui convertissent. »

Publicité motion design verticale, rendue en 3D temps réel dans le navigateur,
exportable en master 4K / 60 fps.

Le visuel de référence est la source de vérité : la composition, le cadrage, la
typographie, les couleurs, la cible et la fléchette en reprennent les mesures.
L'animation ne réinterprète rien — elle met l'image en mouvement, puis revient
s'immobiliser exactement dessus.

```
node serve.mjs        →  http://localhost:5173
```

Chrome ou Edge. Le projet est autonome (three.js et les polices Inter sont
embarqués), aucune connexion réseau n'est nécessaire.

---

## Le film — 7,00 s

| temps | ce qui se passe |
| --- | --- |
| 0,15 – 0,90 | le logo apparaît : fondu et micro-déplacement vertical |
| 0,55 – 1,62 | les deux lignes du titre se révèlent sous masque, l'approche se resserre |
| 1,15 – 2,40 | la cible se matérialise et vient se poser à son échelle définitive |
| 2,44 – 2,98 | la fléchette traverse le cadre par la droite en accélérant |
| **2,98** | **impact au centre exact du cercle bleu** |
| 2,98 – 3,44 | inertie de la fléchette, vibration de la cible, secousse caméra, onde bleue |
| 3,44 – 6,40 | tout se stabilise, la caméra finit son travelling avant |
| 6,40 – 7,00 | immobilité : le cadre de référence |

Le travelling avant est une seule courbe continue du début à la fin : le film
démarre 3,4 % plus large et se pose exactement sur le cadrage de l'image de
référence à la dernière image. Le mouvement est en dessous du seuil de
perception — on ne voit pas la caméra bouger, on sent que la scène a de la
profondeur.

> **Note sur la première image.** Le brief demande à la fois une intro qui se
> construit (logo, puis texte, puis cible) et une première image confondue avec
> l'original : les deux sont incompatibles. L'interprétation retenue est que le
> film *ouvre et ferme* sur la composition de référence — la dernière image lui
> est identique, la première est la page blanche d'où elle se construit. Si tu
> préfères démarrer sur l'image complète, il suffit de mettre tous les `start` de
> `TIMING` à 0 dans `src/config.js`.

---

## Commandes

| touche | action |
| --- | --- |
| `Espace` | lecture / pause |
| `←` `→` | image par image |
| `⇧` `←` `→` | par 10 images |
| `R` | retour au début et lecture |
| `E` | exporte l'image courante en PNG master |
| `M` | coupe le son |
| `H` | masque le panneau |

Le panneau se masque avec `H` : il est en DOM, hors du canvas, donc il
n'apparaît jamais dans un export.

**Comparer avec la référence.** Glisse-dépose l'image de référence sur la page :
elle se superpose au rendu, avec un réglage d'opacité et un mode `Diff`
(différence) pour aligner au pixel près. Passe le format sur `3:4` pour la
comparaison — c'est le cadrage de l'image source.

---

## Exports

| bouton | ce que tu obtiens |
| --- | --- |
| **Render PNG sequence** | le master : 420 PNG en 2160 × 3840, 20 échantillons par image |
| **WebM + sound** | copie de visionnage temps réel, son inclus, lisible partout |
| **Still PNG · master** | l'image courante en pleine résolution |
| **WAV** | la bande son seule, 24 bits / 48 kHz |

La séquence PNG est le vrai master : chaque image est rendue hors temps réel,
sans compression et sans image perdue. Chrome demande où écrire le dossier, puis
la séquence s'y écrit directement.

Pour assembler la séquence et le son :

```bash
ffmpeg -framerate 60 -i fbf_%04d.png -i forbusinessfrance_leads.wav \
  -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 256k -shortest forbusinessfrance_leads.mp4
```

Le WebM est capturé en temps réel : si la machine ne tient pas les 60 fps,
l'export le signale au lieu de retimer la vidéo en silence.

---

## Comment le rendu est fait

**Le flou de mouvement, la profondeur de champ et l'anti-aliasing ne sont pas
trois effets — ils sont trois conséquences du même fait physique.** Une vraie
caméra intègre la lumière pendant l'ouverture de l'obturateur et sur toute la
surface du diaphragme. Chaque image de sortie est donc rendue 20 fois, à des
instants répartis dans l'obturateur (180°), depuis des points répartis sur le
diaphragme, avec des décalages sous-pixel, et sommée dans un buffer flottant.

Il en résulte un flou de mouvement 3D exact — trajectoires courbes et rotations
comprises —, un flou optique avec des bords correctement occultés, et un
anti-aliasing meilleur que le MSAA. Sans buffer de vitesse, sans halo de flou
basé sur la profondeur, et sans rien à régler.

Le décalage sur le diaphragme est appliqué comme un *cisaillement* de la
projection, pas comme une rotation : c'est ce qui garde le plan de netteté
rigoureusement fixe pendant que le point de vue se déplace.

**La physique est analytique.** Aucune animation n'est intégrée pas à pas : les
oscillateurs amortis sont évalués en forme close. C'est une contrainte, pas un
choix esthétique — le moteur hors ligne évalue la timeline 20 fois par image, à
des instants arbitraires et dans le désordre. Une simulation pas à pas donnerait
un résultat différent à chaque rendu.

**La cible** est une vraie surface de révolution à arêtes congées. Les anneaux
sont calculés dans le shader à partir du rayon en espace objet et anti-aliasés
avec `fwidth` : aucune texture, donc des bords mathématiquement nets en 4K.
L'onde d'impact vit dans ce même shader, pilotée par le rayon de la surface —
elle ne peut donc pas se décoller de la cible ni entrer en conflit de profondeur
avec elle.

**La fléchette** est faite de quatre pièces réelles : pointe acier, fût tungstène
moleté, tige moulée, ailette à quatre pans. Le moletage est de la géométrie
tournée, pas une normal map — en 4K, c'est la différence entre du métal et une
photo de métal.

**L'éclairage** est un environnement HDR construit en code puis préfiltré : un
diffuseur au plafond, un remplissage frontal large, une key en haut à gauche
pour les reflets sur le métal, un contre-jour froid à droite. Sur du noir
brillant posé sur du blanc, ce que l'œil lit comme « matière premium » est
presque entièrement du reflet — d'où un vrai environnement plutôt que des
sources ponctuelles.

**Le fond reste exactement `#FFFFFF`.** Pas de tone mapping, et le sol ne rend
rien d'autre que de l'occlusion : l'ombre de contact est la profondeur de la
scène vue de dessus, floutée, composée en assombrissement pur. Un vrai sol
éclairé ferait dériver le blanc.

**La typographie** est rasterisée en Canvas2D à la résolution de sortie et
composée par-dessus le rendu, hors de la boucle d'échantillonnage : du texte qui
passerait dans le buffer d'accumulation se ramollirait. Les tailles sont
résolues à partir des largeurs mesurées sur la référence — la hauteur de
capitale et l'interligne en découlent au lieu d'être décrétées.

**Le son** est synthétisé, sans échantillon : souffle de la fléchette, impact
(transitoire sec, corps court, coup grave), micro-pulse numérique au centre,
sub-basse qui décroît. La même fonction alimente la lecture temps réel et le
rendu hors ligne du WAV — ce que tu entends est ce que tu exportes.

---

## Régler le rendu

Tout ce qui concerne la fidélité est dans **`src/config.js`**, en *unités W* :
des fractions de la largeur de l'image. La scène 3D partage la même unité, donc
un rayon de cible de `0.275` occupe 27,5 % de la largeur du cadre. Rien d'autre
dans le code ne fixe une position.

| à changer | où |
| --- | --- |
| bleu, noir, blanc | `BRAND` |
| marges, tailles de texte, position de la cible | `LAYOUT_BASE` |
| anneaux, épaisseur, inclinaison, matériaux | `BOARD` |
| anatomie de la fléchette, angles, trajectoire | `DART` |
| minutage de chaque étape | `TIMING` |
| objectif, ouverture, travelling, secousse | `CAMERA` |
| échantillons, obturateur, grain, ombre | `QUALITY` |

Deux formats sont fournis : `9:16` (le master de livraison) et `3:4` (le cadrage
exact de l'image de référence, pour la comparaison). Les deux sont pilotés par
les mêmes mesures ; seules les marges verticales diffèrent.

---

## Structure

```
index.html                shell de la page
serve.mjs                 serveur statique sans dépendance
src/
  config.js               toutes les mesures et tous les réglages
  main.js                 assemblage, transport, exports
  core/
    easing.js             courbes cinématiques, physique analytique, bruit
    timeline.js           sample(t) → état complet du film
  scene/
    stage.js              graphe de scène, résolution de la caméra, vol de la fléchette
    board.js              géométrie et shader de la cible
    dart.js               géométrie de la fléchette
    environment.js        environnement studio HDR procédural
    contactShadow.js      ombre de contact en occlusion pure
    impact.js             lueur et poussières lumineuses
  render/
    frameRenderer.js      accumulation : flou, profondeur de champ, AA
  overlay/
    typography.js         moteur typographique et calque de texte
  audio/
    soundDesign.js        synthèse temps réel et master WAV
  export/
    exporter.js           séquence PNG, WebM, WAV
  ui/
    panel.js              panneau de contrôle
vendor/                   three.js (MIT)
fonts/                    Inter Display / Inter (OFL)
```

`sample(t)` est le seul point de vérité de l'animation : il retourne l'état
complet du film à un instant donné, sans état résiduel. C'est pour cette raison
que la lecture, le scrubbing et le rendu hors ligne passent par le même chemin
de code et ne peuvent pas diverger.

---

## Licences

three.js — MIT (`vendor/three-LICENSE.txt`).
Inter par Rasmus Andersson — SIL Open Font License (`fonts/Inter-LICENSE.txt`).
