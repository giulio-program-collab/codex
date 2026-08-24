# 03 · Modell- und Algorithmenauswahl

Die Auswahl folgt einer Regel: Ein Modell kommt nur in Frage, wenn es entweder
eine Unsicherheit mitliefert oder wenn sich eine belastbare Unsicherheit für es
messen lässt. Ein genaueres Modell ohne Unsicherheit ist für dieses System
weniger wert als ein ungenaueres mit.

## Layer 3/4 — Personendetektion und 2D-Pose

**Anforderung.** Ganzkörper, 25–30 Gelenke, Score je Gelenk, stabil bei starker
Bewegungsunschärfe, tolerant gegenüber Selbstverdeckung im Racket-Drop.

**Empfehlung: RTMPose (Top-Down, RTMDet als Detektor), Halpe-26-Keypoints.**

- Liefert einen kalibrierbaren Score je Gelenk. Bottom-Up-Verfahren wie
  OpenPose liefern das ebenfalls, sind aber bei Einzelpersonen unnötig und in
  der Gelenkzuordnung instabiler.
- Halpe-26 enthält Kopf, Hals und Füße — COCO-17 hat keine Füße, und ohne
  Zehenrichtung fehlt ein Chiralitätshinweis (siehe [04](04-3d-konzept.md)).
- Läuft in Echtzeit auf einer mittleren GPU, was für eine Trainer-App zählt.

**Alternative: ViTPose-H**, wenn Genauigkeit vor Durchsatz geht. Etwa 2–3 Punkte
AP besser auf COCO, etwa fünfmal langsamer.

**Zu vermeiden: MediaPipe Pose (BlazePose).** Es liefert eine Pseudo-Tiefe je
Landmark, für die kein Fehlermaß existiert und die auf Alltagsbewegungen
trainiert ist. Eine Tiefe ohne Fehlerangabe ist in dieser Architektur nicht
anschließbar — genau das ist die Klasse von Zahl, die den Sinner-Fall erzeugt
hat.

## Layer 5 — Temporales Tracking

Kein Modell, sondern Verfahren, und zwar in dieser Reihenfolge:

1. **Score-Schwelle.** Unter 0,3 wird ein Keypoint nicht als Messung verwendet.
2. **Links/Rechts-Tauschprüfung.** Der klassische Trackerfehler: jedes Gelenk
   bleibt für sich plausibel, während jede seitenabhängige Größe zerstört wird.
   Erkannt über den Vergleich der Zuordnungskosten mit deutlichem Abstand —
   Gliedmaßen kreuzen sich im Aufschlag tatsächlich, ein knapper Vorsprung
   beweist nichts.
3. **Physiologische Geschwindigkeitsgrenzen** je Gelenkgruppe. Eine
   Aufschlaghand erreicht etwa 12 m/s, ein Becken nie mehr als 4,5 m/s.
4. **Spike-Test gegen einen lokalen Median**, robust skaliert über die MAD.
   Bewegung ist glatt, Detektionsfehler sind es nicht.
5. **Knochenlängenprüfung im Bild.** Ein projiziertes Segment kann nie länger
   sein als das echte.
6. **Lückenschluss** nur über maximal drei Bilder, und interpolierte Werte
   tragen dauerhaft eine reduzierte Confidence.
7. **Nullphasige Glättung** mit Halbbreite 1 — genug gegen Detektorzittern, kurz
   genug, um die Peaks nicht zu verschieben, an denen die Timing-Analyse hängt.

Die **Verwerfungsrate** ist selbst das aussagekräftigste Qualitätssignal: Ein
Clip mit 2 % und einer mit 25 % verworfener Stichproben verdienen sehr
unterschiedliches Vertrauen, auch wenn die übrig gebliebenen Zahlen gleich
aussehen.

## Layer 6 — 3D-Rekonstruktion

**Produktionspfad: gelerntes monokulares Tiefenmodell + geometrische Constraints.**

Empfehlung **MotionBERT** oder **VideoPose3D** als Lifter, mit zwei Auflagen:

1. Das Modell muss eine Unsicherheit liefern. Bei Modellen, die das nicht tun,
   wird sie über Test-Time-Augmentation (horizontale Spiegelung, zeitliche
   Verschiebung, Ensemble über Checkpoints) empirisch bestimmt und gegen
   markerbasierte Referenzdaten kalibriert. Ohne diesen Schritt darf das Modell
   nicht in Produktion.
2. Die Ausgabe wird nicht direkt verwendet, sondern als Prior in den
   geometrischen Solver gegeben. Der Solver erzwingt Knochenlängen, prüft
   Chiralität und rechnet Kovarianz — Dinge, die ein Lifter nicht tut.

**Rückfallpfad: rein geometrischer Solver.** Er ist implementiert und läuft ohne
Modell. Er ist deutlich ungenauer und sagt das auch (siehe
[09 Validierung](09-validierung.md)).

**Warum kein SMPL-Mesh-Recovery (HMR2.0, 4D-Humans)?** Die Modelle sind stark
und liefern ein vollständiges Körpermodell, aber ihre Pose ist an einen
Formprior gekoppelt, der auf Alltagsposen trainiert ist. Bei extremen
Aufschlagposen — Racket-Drop hinter dem Rücken, maximale Bogenspannung — zieht
dieser Prior die Lösung zur Normalpose. Für Formrekonstruktion sind sie besser,
für Extrempose-Kinematik schlechter. Als _zusätzlicher_ Prior sind sie sinnvoll,
als alleinige Quelle nicht.

## Layer 7 — Schläger

**Empfehlung: YOLOv8/RT-DETR auf Griff und Schlägerkopf als zwei Keypoints**,
feinjustiert auf Tennisaufnahmen. Zwei Punkte statt einer Box, weil die
Schlägerachse gebraucht wird und eine achsenparallele Box sie nicht enthält.

Die 3D-Position des Kopfes wird wie ein Knochen gelöst: Der Griff sitzt an der
Hand, deren 3D-Position Layer 6 bereits kennt, und die Schlägerlänge ist
bekannt — dieselbe quadratische Gleichung, dieselbe Mehrdeutigkeit, dieselbe
zeitliche Auflösung.

**Bildratenanforderung.** Schlägerkopfgeschwindigkeit wird unter 120 Hz gar nicht
ausgegeben. Bei 40 m/s legt der Kopf zwischen zwei Bildern bei 30 fps über einen
Meter zurück; die Sehne unterschätzt den Bogen dann um mehr als 10 %, und die
Zahl wäre eine Erfindung.

## Layer 8 — Ball

**Empfehlung: TrackNetV3** oder ein vergleichbares heatmapbasiertes Verfahren
mit Mehrbild-Eingang. Einzelbilddetektoren verlieren den Ball unmittelbar nach
dem Treffpunkt vollständig, weil er über 40 Pixel verschmiert.

Der Ball leistet hier **zwei** Dinge, und nur diese:

1. Ein Treffpunktindiz über den Geschwindigkeitssprung in der Bildbahn.
2. **Die Richtung der Schwerkraft.** Der Ballwurf ist ein freier Fall; seine
   Bildbeschleunigung ist parallel zur Projektion der Schwerkraft. Das ist die
   verlässlichste Vertikalreferenz, die ein Tennisvideo enthält, und sie ist die
   Grundlage von Layer 6 (siehe [04](04-3d-konzept.md)).

Ballgeschwindigkeit, Spin und Abflugwinkel werden **grundsätzlich nicht**
geschätzt. Die Tiefe des Balls folgt aus einem Bildradius von wenigen Pixeln;
ein Pixel Fehler bei vier Pixeln Radius sind 25 % Tiefenfehler. Die Gründe stehen
maschinenlesbar in `BALL_UNOBSERVABLE`, damit die Oberfläche sie anzeigen kann,
statt die Größe stillschweigend wegzulassen.

## Layer 9 — Segmentierung

**Aktuell: signalbasiert mit Sub-Frame-Interpolation.** Phasen werden an
Extrema kontinuierlicher 3D-Signale lokalisiert (maximale Knieflexion, tiefster
Punkt des Schlägerkopfs, maximale Armstreckung), jeweils parabolisch verfeinert.

Sub-Frame-Verfeinerung ist keine Kosmetik: Bei 60 fps ist ein Bild 17 ms, und der
zu unterscheidende Unterschied zwischen Elite und High-Performance im Becken-Peak
liegt bei etwa 18 ms. Ohne Verfeinerung wäre die Messung reines Quantisierungs­rauschen.

**Ausbaustufe: gelernte zeitliche Segmentierung** (MS-TCN++ oder ASFormer) auf
den 3D-Merkmalsverläufen, sobald annotierte Daten vorliegen. Der Gewinn liegt bei
den unscharfen Übergängen — Beginn des Unit Turn, Ende der Ladephase —, die kein
sauberes Extremum haben. Die scharfen Ereignisse (Treffpunkt, Racket-Drop) löst
das Signalverfahren bereits gut.

**Der Treffpunkt wird aus mehreren Indizien gemittelt**, und die _Übereinstimmung_
der Indizien ist die Confidence. Ein einzelnes Indiz kann richtig sein, aber es
lässt sich nicht prüfen — und ein ungeprüfter Treffpunkt entwertet jede
Zeitmessung, die auf ihn Bezug nimmt.

## Layer 13 — Interpretation

**Kein Sprachmodell im Bewertungspfad.** Die Zuordnung von Messwerten zu
Befunden ist eine Tabelle aus Wirkmechanismen, kein Textgenerierungsproblem. Ein
Sprachmodell kann eine Beobachtung nicht falsifizieren und würde die
Nachvollziehbarkeit zerstören, die der ganze Punkt dieser Architektur ist.

Sinnvoll wäre ein Sprachmodell an genau einer Stelle: der sprachlichen
Ausformulierung eines bereits feststehenden Befundes für einen bestimmten
Adressaten (Trainer, Spieler, Eltern). Diese Stelle liegt hinter allen
Entscheidungen und kann keine erfinden.

## Zusammenfassung

| Layer   | Verfahren                                    | Warum                                                             |
| ------- | -------------------------------------------- | ----------------------------------------------------------------- |
| L3/L4   | RTMDet + RTMPose (Halpe-26)                  | Score je Gelenk, Füße enthalten, echtzeitfähig                    |
| L5      | Regelbasiert, sieben Stufen                  | Fehlerarten sind bekannt und einzeln prüfbar                      |
| L6      | Gelernter Tiefenprior + geometrischer Solver | Prior bringt Genauigkeit, Solver bringt Constraints und Kovarianz |
| L7      | Keypoint-Detektor auf Griff/Kopf             | Achse wird gebraucht, Box enthält sie nicht                       |
| L8      | TrackNetV3                                   | Mehrbild-Eingang; Ball verschwindet sonst nach Kontakt            |
| L9      | Signalbasiert, später gelernt                | Scharfe Ereignisse sind gelöst, unscharfe nicht                   |
| L10–L14 | Deterministisch                              | Nachvollziehbarkeit ist die Anforderung                           |
