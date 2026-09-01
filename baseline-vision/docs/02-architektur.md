# 02 · Architektur

## Grundprinzip: Analyse ≠ Bewertung

Die Kette ist so geschnitten, dass an keiner Stelle von Pixeln direkt auf ein
Urteil geschlossen werden kann. Jeder Layer hat einen eigenen Status, eine
eigene Güte und eigene Diagnosewerte, und jeder ist ohne die anderen testbar.

```
Video
  ↓ L1  Ingestion & Qualitäts-Gate        fps, Auflösung, Zeitregularität
  ↓ L2  Kamerakalibrierung                Brennweite ± SD, Distanz, Perspektivklasse
  ↓ L3  Spielererkennung & Track          Identitätswechsel
  ↓ L4  Pose-Estimation                   2D-Gelenke + Score je Gelenk
  ↓ L5  Temporales Tracking               Ausreißer, Gliedmaßentausch, Lücken
  ↓ L6  3D-Rekonstruktion                 Posen + Kovarianz, Vertikale, Chiralität
  ↓ L7  Schlägertracking                  Griff, Kopf, Kopfbahn, Geschwindigkeit
  ↓ L8  Balltracking                      2D-Bahn, Treffpunktindiz
  ↓ L9  Bewegungssegmentierung            Phasen + Treffpunkt, je mit Confidence
  ↓ L10 Biomechanische Merkmale           Measures mit Unsicherheit
  ↓ L11 Referenzvergleich                 Kohorten, Bänder, Eigenvergleich
  ↓ L12 Confidence-Aggregation            Analysequalität, Bewertungs-Gate
  ↓ L13 Interpretation                    Plausibilität, Befunde, Urteil
  ↓ L14 Report                            Trainer-Modell
       ↓
  Sitzung (analyseSession)                Mittelwert, Konstanz, Ausreißer
Trainer-Dashboard
```

## Der zentrale Datentyp

Alles, was diese Kette produziert, ist ein `Measure`:

```ts
interface Measure {
  value: number | null; // null heißt: nicht gemessen, nicht geschätzt
  sd: number | null; // 1-Sigma in der Einheit von value
  confidence: number; // 0..1 — haben wir überhaupt das Richtige gemessen?
  unit: string;
  observability: Observability;
  provenance: string[]; // welche Layer beigetragen haben
  notes: string[]; // Vorbehalte, die zu genau dieser Zahl gehören
}
```

`sd` und `confidence` sind bewusst getrennt. `sd` ist die Streuung eines Wertes,
den wir zu messen glauben; `confidence` ist die Wahrscheinlichkeit, dass wir
überhaupt das Richtige gemessen haben — richtiges Gelenk, richtiges Bild,
richtiger Spieler. Eine Schulterrotation kann eine enge Streuung und eine
niedrige Confidence haben, wenn die Phasenerkennung unsicher war.

`observability` hält fest, ob die Kamera diese Größe überhaupt sehen konnte:

| Klasse          | Bedeutung                                                                  |
| --------------- | -------------------------------------------------------------------------- |
| `direct`        | Skalen- und blickwinkelinvariant, oder in einer Ebene nahe der Bildebene   |
| `reconstructed` | Aus der 3D-Rekonstruktion; Unsicherheit kommt aus deren Kovarianz          |
| `depth_limited` | Von der Tiefenrichtung dominiert; nur bei günstiger Perspektive berichtbar |
| `unobservable`  | Aus dieser Aufnahme grundsätzlich nicht bestimmbar                         |

Die Klasse wird **nicht** aus einer Tabelle gelesen, sondern gemessen: Layer 10
lässt jede Größe zweimal durch die Fehlerfortpflanzung laufen — einmal mit dem
vollen Fehlermodell, einmal mit abgeschalteter Tiefenkomponente — und liest die
Klasse am Verhältnis der beiden Streuungen ab. Damit entdeckt der Code selbst,
dass eine Schulterrotation von der Seite tiefenlimitiert und von oben gut messbar
ist, ohne dass jemand eine Tabelle pflegen muss.

## Layer-Status und Diagnose

```ts
interface LayerReport {
  id: string; // "L6"
  name: string;
  status: "ok" | "degraded" | "failed" | "skipped";
  quality: number; // 0..1, geht in die Analysequalität ein
  notes: string[];
  diagnostics: Record<string, number | string | null>;
}
```

Dieser Trail ist im Dashboard sichtbar. Wenn ein Ergebnis falsch aussieht, ist
die erste Frage nicht, wie man es besser formuliert, sondern welcher Schritt
nicht getragen hat:

```
L1  Video-Ingestion & Qualitäts-Gate     ok        100 %
L2  Kamerakalibrierung                   ok         88 %
L3  Spielererkennung & Track             ok        100 %
L4  Pose-Estimation                      ok         90 %
L5  Temporales Tracking                  degraded   41 %   ← 9,7 % verworfen
L6  3D-Rekonstruktion                    ok         75 %
L7  Schlägererkennung                    failed      2 %   ← Abdeckung 4 %
L8  Ballerkennung                        ok         50 %
L9  Bewegungssegmentierung               failed     19 %   ← folgt aus L7
L10 Biomechanische Merkmale              degraded   48 %
```

Der Fehler ist hier eindeutig L7, nicht L9 oder L10 — die sind nur Folgeschäden.

## Datenfluss und Koordinatenkonventionen

Fest für die gesamte Kette:

- **x** entlang der Grundlinie, **y** zum Netz, **z** nach oben, `z = 0` ist der
  Platz. Meter, Grad, Sekunden. Alles andere trägt die Einheit im Namen.
- Die Rekonstruktion entsteht im **Kamerasystem** (Ursprung im optischen
  Zentrum, +z entlang der Blickachse) und wird erst danach in das Platzsystem
  gedreht. Der Grund: Layer 6 kennt die Kamerapose nicht und darf sie nicht
  annehmen — sie wird aus der Rekonstruktion selbst geschätzt (Vertikale aus dem
  Ballflug, Zielrichtung aus der Schulterachse) und trägt dabei ihre eigene
  Confidence.
- Die Achsenbasis der Rekonstruktion ist **rechtshändig gegenüber der Welt**.
  Das ist kein Detail: Ein physikalisches Kamerasystem (rechts, oben, vorwärts)
  ist linkshändig, und eine rechtshändig deklarierte Rekonstruktionsbasis
  darüber erzeugt das _Spiegelbild_ der Szene — mit korrekten Knochenlängen,
  korrekten Gelenkwinkeln und perfekter Rückprojektion. Nur die Händigkeit
  kippt, und damit jede Aussage über Drehrichtung und Reihenfolge. Siehe
  `l02-calibration.ts`, `cameraFrameCamera`.

## Schnittstellen zur Austauschbarkeit

Die Layer, die in Produktion durch Modelle ersetzt werden, hängen an schmalen
Interfaces:

```ts
// L4: jeder Pose-Estimator, der 2D-Gelenke mit Score liefert
interface FrameObservation {
  index;
  t;
  pose2d;
  racket?;
  ball?;
}

// L6: jedes lernbasierte Tiefenmodell
interface DepthPrior {
  id: string;
  depthM(frameIndex: number, joint: Joint): number | null;
  sigmaM(frameIndex: number, joint: Joint): number;
}
```

`DepthPrior` ist die wichtigste dieser Schnittstellen. Der geometrische Solver
ist ein Rückfallpfad; die Produktionskonfiguration liefert Tiefe aus einem
gelernten Modell. Der Unterschied ist gemessen und liegt bei einer
Größenordnung — siehe [09 Validierung](09-validierung.md).

Entscheidend ist, was das Interface **verlangt**: nicht nur eine Tiefe, sondern
auch deren Unsicherheit. Ein Modell, das nur einen Punktschätzer liefert, kann
hier nicht angeschlossen werden, ohne dass jemand eine Unsicherheit angibt und
verantwortet.

## Warum kein End-to-End-Modell

Ein Netz, das aus Videoframes direkt eine Note vorhersagt, wäre einfacher zu
bauen und wertlos für einen Trainer. Es hätte keine Zwischenwerte, an denen sich
prüfen ließe, ob ein Ergebnis stimmt; keinen Ort, an dem eine Unsicherheit
entsteht; und keine Möglichkeit, zwischen „der Spieler macht etwas anders" und
„wir haben schlecht gemessen" zu unterscheiden. Genau diese Unterscheidung ist
der Kern des Sinner-Falls.
