# 13 · Eigene Videos auswerten

## Der kurze Weg: Video hineinziehen

```bash
cd engine
node --experimental-strip-types tools/fetch-models.ts   # einmalig, ca. 24 MB
node --experimental-strip-types tools/serve.ts
```

Dann `http://localhost:8080/` öffnen, das Video hineinziehen, Körpergröße und
Schlaghand eintragen, **Posen erkennen** klicken. Anschließend auf das Bild
spulen, in dem der Ball die Saiten berührt, **Treffpunkt hier setzen**,
**Auswerten**. Der Bericht ist derselbe wie überall sonst — es ist dieselbe
`analyse()`-Funktion, die auch die Testsuite durchläuft.

Warum ein lokaler Server und kein Doppelklick auf die HTML-Datei: Browser
verweigern WebAssembly aus einer `file://`-Seite. Der Server ist
abhängigkeitsfrei und liefert nur das Prüfstands-Verzeichnis aus.

Was dabei im Browser passiert:

1. Der Browser dekodiert das Video — deshalb kein ffmpeg, kein Python.
2. **MediaPipe Pose** schätzt in jedem Bild 33 Landmarks und eine
   wurzelrelative 3D-Position in Metern. Beides läuft lokal; das Video verlässt
   Ihren Rechner nicht.
3. Daraus entsteht dieselbe Clip-Struktur, die auch das Kommandozeilen-Skript
   schreibt, und die geht unverändert in die Messkette.

Getestet ist der Weg mit einem echten Personenvideo: 70 Bilder, in 100 % davon
eine Person erkannt, Skelett sauber auf den Körper gelegt. Was **nicht** getestet
ist, weil hier kein Tennisvideo vorliegt: wie gut MediaPipe einen Aufschlag
trifft. Der Schlagarm bewegt sich mit über 30 m/s und verschwindet in
Bewegungsunschärfe — erwarten Sie dort die größten Ausfälle, und der Bericht
sagt Ihnen unter „Pose-Tracking“, wie schlimm es war.

### Grenzen des Browser-Wegs

* **Videoformat.** Chrome und Safari lesen H.264-MP4 und WebM. HEVC aus dem
  iPhone oft nicht — in der Foto-App als „Kompatibel“ exportieren oder
  `ffmpeg -i clip.mov -c:v libx264 clip.mp4`.
* **Länge.** Ausgewertet werden die ersten 900 Bilder. Ein Aufschlag braucht
  keine zwei Sekunden; schneiden Sie das Video vorher zu.
* **Bildwinkel.** Der Browser kennt ihn nicht. Ohne Eingabe wird er geschätzt,
  und jede Längenangabe wird unsicherer.
* **Zeitlupe.** Ist die Datei mit 30 fps abgespielte 240-fps-Aufnahme, gehört
  240 in das Feld „Aufnahmerate“ — davon hängt ab, ob Zeitmessungen überhaupt
  zulässig sind.

## Der Weg über die Kommandozeile

```bash
pip install mediapipe opencv-python

python engine/tools/extract-pose.py aufschlag.mp4 clip.json \
    --height-cm 185 --hand right --level high_performance \
    --hfov 62 --capture-fps 240 --contact-frame 276
```

MediaPipe liefert 33 Landmarks **und** `pose_world_landmarks`, eine
wurzelrelative 3D-Schätzung in Metern. Das Skript schreibt sie als Tiefenspur
mit — genau das, was die Rekonstruktion braucht, um die Tiefenrichtung
aufzulösen.

Alternativ mit YOLO-Pose (robuster bei kleinen, schnellen Figuren, aber nur 2D):

```bash
pip install ultralytics opencv-python
python engine/tools/extract-pose.py aufschlag.mp4 clip.json --backend ultralytics \
    --height-cm 185 --hand right --level high_performance --contact-frame 276
```

Den Treffpunkt findet kein Skript für Sie. Im Player Bild für Bild bis zum
Moment, in dem der Ball die Saiten berührt, Bildnummer ablesen, als
`--contact-frame` übergeben. Ein Klick pro Aufschlag.

## Clip-Datei auswerten

```bash
cd engine
node --experimental-strip-types tools/analyse-clip.ts ../clip.json
```

Ausgegeben werden Eingangsdaten, Hinweise zur Datei, das Urteil, alle Messwerte
mit Intervall und Vertrauensstufe, die nicht messbaren Größen mit Begründung,
der Schichten-Trail und die Plausibilitätsprüfungen. Mit `--json bericht.json`
zusätzlich als Datei.

Oder im Browser: `playground/index.html` öffnen und die Clip-Datei in das Feld
links oben ziehen. Dieselbe Engine, dieselben Zahlen, dazu die Überlagerung von
Detektion und Rekonstruktion Bild für Bild.

## Das Clip-Format

Eine JSON-Datei. Vollständige Definition in
[`engine/src/io/clip.ts`](../engine/src/io/clip.ts); ein fertiges Beispiel
erzeugt

```bash
node --experimental-strip-types tools/export-clip.ts beispiel.json
```

```jsonc
{
  "format": "baseline-vision-clip",
  "version": 1,
  "video": { "fps": 240, "captureFps": 240, "widthPx": 1920, "heightPx": 1080, "hfovDeg": 50 },
  "player": { "heightCm": 191, "hand": "right", "level": "elite", "ageYears": 24 },
  "stroke": "serve",
  "keypointLayout": "mediapipe33",   // oder coco17, halpe26, native, oder eine eigene Liste
  "contactFrame": 276,
  "frames": [
    {
      "t": 0.0,
      "keypoints": [[882.5, 565.3, 0.97], null, ...],  // [x, y, score] je Layout-Punkt
      "depth": [-0.149, null, ...],                    // optional, Meter, wurzelrelativ
      "racket": { "grip": [910, 700], "head": [880, 540], "score": 0.8 },  // optional
      "ball": { "x": 903, "y": 512, "radiusPx": 5, "score": 0.7 }          // optional
    }
  ]
}
```

Ein vierter Eintrag `1` in einem Keypoint markiert einen Punkt, den der
Detektor selbst als verdeckt meldet.

Zwei Fallstricke, die die Datei prägen:

* **Keypoints unter Score 0,15 gelten als nicht gesehen.** MediaPipe gibt in
  jedem Bild alle 33 Landmarks aus und markiert die nicht gefundenen mit einer
  Sichtbarkeit nahe null. Wörtlich gelesen kommt ein nicht gefundenes
  Handgelenk als selbstbewusster Punkt im Bildursprung an und zieht die ganze
  Pose in die linke obere Ecke.
* **Tiefe wird nur für tatsächlich gesehene Gelenke übernommen**, und die
  Rumpfpunkte (Becken, Sternum, Hals, Wirbelsäule) werden aus Hüften und
  Schultern abgeleitet — genauso, wie Layer 4 es in der Bildebene tut. Ohne
  Beckentiefe hat die Tiefenkette keinen Anker; in der Messung fiel die Güte
  der Rekonstruktion dadurch von 87 auf 33.

## Was fehlende Angaben kosten

Gemessen an derselben simulierten Bewegung (wahre maximale Knieflexion 66°),
über `tools/analyse-clip.ts`:

| Clip enthält | Analysequalität | Knieflexion | Urteil |
| --- | --- | --- | --- |
| Pose + Tiefe + Schläger + Ball | 89 | 60,7 ± 7,3° | Bewertung |
| Pose + Tiefe + markierter Treffpunkt | 83 | 60,7 ± 7,4° | Bewertung |
| Pose + Schläger + Ball, **keine Tiefe** | 80 | 24,3 ± 7,4° bei Vertrauen 0,31 | **keine Bewertung** |
| nur Pose, sonst nichts | 56 | wird nicht zitiert | **keine Bewertung** |

Die dritte Zeile ist die wichtigste. Ohne Tiefeninformation löst der rein
geometrische Ansatz die Tiefenrichtung nicht auf; die Winkel kippen in Richtung
ihrer Bildprojektion, und 24° statt 66° ist genau der Fehler des alten
Verfahrens. Das System erkennt das an seiner eigenen Spiegelungssicherheit
(0,35 statt 0,90) und wertet jede Größe ab, die von der Tiefenrichtung abhängt
— siehe `MIRROR_RESOLVED` in Layer 10. Der Wert steht dann noch im Bericht,
aber unterhalb der Zitierschwelle und ohne Gesamturteil.

## Was das noch nicht ist

Die Zahlen oben stammen aus simulierten Aufnahmen, die durch dieselbe Datei
geschleust wurden wie ein echtes Video. Damit ist der **Importpfad** geprüft,
nicht die Leistung eines Pose-Estimators auf echtem Videomaterial. Was auf
echten Aufnahmen dazukommt:

* Ein Aufschlag ist für jeden Estimator ein schwerer Fall: Der Schlagarm bewegt
  sich mit über 30 m/s, verschwindet in Bewegungsunschärfe und verdeckt sich
  selbst. Erwarten Sie deutlich schlechtere Keypoint-Scores als in der
  Simulation — und entsprechend niedrigere Analysequalität.
* MediaPipes `pose_world_landmarks` sind nicht auf Tennis trainiert. Die
  Tiefenspur ist besser als keine, aber die 55 mm, mit denen die Validierung
  rechnet, sind eine optimistische Annahme.
* `extract-pose.py` wurde in dieser Umgebung nicht gegen ein echtes Modell
  ausgeführt — die nötigen Pakete lassen sich hier nicht installieren. Geprüft
  ist der Vertrag zwischen Skript und Importer: Die vom Skript geschriebene
  Datei wird eingelesen und ausgewertet. Ob MediaPipe auf Ihrem Video brauchbare
  Punkte liefert, zeigt der erste Lauf — der Bericht sagt es Ihnen, unter
  „Pose-Tracking".

Der ehrliche Erwartungswert: Mit einer Stativaufnahme bei 120 fps oder mehr,
bekannter Brennweite, markiertem Treffpunkt und MediaPipe-Tiefenspur sollte die
Ladephase (Knieflexion, Rumpfneigung, Beckenhub) messbar sein. Die
Kettenzeitpunkte brauchen mehrere Wiederholungen, und die absoluten
Zeitdifferenzen bleiben auch dann unauflösbar — siehe
[11 Risiken und Grenzen](11-risiken.md).
