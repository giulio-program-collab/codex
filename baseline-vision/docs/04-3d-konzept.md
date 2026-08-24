# 04 · 3D-Analysekonzept

## Was aus einer Kamera geht und was nicht

Aus einem einzelnen Video ist die 3D-Pose bis auf **drei** Mehrdeutigkeiten
bestimmbar, und jede davon hat eine eigene Auflösung:

| Mehrdeutigkeit              | Auflösung                                                      | Restfehler                              |
| --------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| Absoluter Maßstab           | Anthropometrische Knochenlängen aus der Körpergröße            | ~5 % (Streuung der Segmentverhältnisse) |
| Tiefenvorzeichen je Segment | Zeitliche Kontinuität + Chiralitätstest                        | siehe unten                             |
| Ausrichtung im Raum         | Vertikale aus dem Ballflug, Zielrichtung aus der Schulterachse | 0,3°–3,5° / ~40°                        |

## Die Rekonstruktion

Jedes Gelenk liegt auf einem bekannten Strahl. Jeder Knochen hat eine bekannte
metrische Länge. Ist die Tiefe eines Endpunkts bekannt, folgt die des anderen:

```
t_Kind = t_Eltern · cos(θ)  ±  √( L² − t_Eltern² · sin²(θ) )
```

θ ist der Winkelabstand der beiden Strahlen. Zwei Eigenschaften dieses Ausdrucks
tragen die gesamte Ehrlichkeit des Systems:

**Das ±** ist die Tiefenmehrdeutigkeit. Sie wird über zeitliche Kontinuität
aufgelöst, und wo die Kontinuität schwach ist, wird sie berichtet statt versteckt.

**Die Ableitung der Wurzel** explodiert, wenn der Knochen in die Bildebene läuft.
Das ist keine numerische Unannehmlichkeit, sondern die Physik: Ein Segment in der
Bildebene hat ein unbestimmbares Tiefenvorzeichen, und ein Segment entlang der
optischen Achse hat einen unbestimmbaren Bildwinkel.

### Warum nicht der Maximum-Likelihood-Schätzer

Die projizierte Länge eines Knochens ist nahe der Bildebene fast unempfindlich
gegen seinen Auslenkungswinkel: `q = cos(φ)` hat dort die Ableitung null. Ist
die gemessene Projektion also etwas kürzer als der echte Knochen — was Rauschen
allein in der Hälfte aller Fälle garantiert —, weist die ML-Lösung dem Segment
eine große Tiefenkomponente zu, um den Fehlbetrag zu erklären.

Für einen 47 cm langen Oberschenkel bei 2 cm Messrauschen sind das im Mittel
etwa **9 cm erfundene Tiefe**. Zwei solche Fehler in Serie machen aus einem
gestreckten Bein ein sichtbar gebeugtes.

Verwendet wird deshalb der **Posterior-Mittelwert** über den Auslenkungswinkel,
unter dem Prior, der „wir wissen nichts über die Richtung" in drei Dimensionen
tatsächlich bedeutet: gleichverteilt in der Richtung, also gleichverteilt in
sin(φ). Wo die Projektion den Winkel wirklich festlegt, stimmt er mit dem
ML-Wert überein; wo nicht, schrumpft er gegen null und meldet eine entsprechend
breite Unsicherheit. Implementiert in `posteriorOutOfPlane`.

### Zeitliche Filterung auf der richtigen Größe

Gefiltert wird nicht die absolute Tiefe entlang des Strahls, sondern der
**Auslenkungsanteil `u = sin(φ)` je Knochen**. Der Grund: `u` ist eine
beschränkte, langsam veränderliche Eigenschaft des Gliedes selbst, während die
absolute Tiefe davon dominiert wird, wo der Spieler gerade steht — und diese
Bewegung würde das Signal ertränken, das geglättet werden soll.

Nullphasiger Butterworth 2. Ordnung, vorwärts und rückwärts, Grenzfrequenz 14 Hz.
Vorwärts _und_ rückwärts, weil die Phasenlage selbst ein Ergebnis ist: Der
Zeitpunkt eines Peaks ist die Messgröße der kinetischen Kette.

### Die Spiegelmehrdeutigkeit

Unter nahezu orthographischer Abbildung ist die Tiefe jedes Knochens nur bis auf
ein Vorzeichen bestimmt. Kippt man die Vorzeichen einer ganzen Gliedmaße
gemeinsam, spiegelt man diese Gliedmaße, ohne das Bild zu verändern.

Das ist eine Eigenschaft der Einkameraufnahme, kein Bug. Aufgelöst wird sie über
Evidenz, die selbst händig ist:

- **Die Zehen zeigen dorthin, wohin die Brust zeigt.**
- **Das Knie beugt nach vorne**, relativ zur Hüft-Sprunggelenk-Linie.

Beide Aussagen kippen unter Spiegelung ihr Vorzeichen, während die Projektion
identisch bleibt. Mit den durch den 2D-Detektor festgelegten Gelenk-_Labels_
wählen sie eine der beiden Hypothesen aus. Der Suchraum wird nicht global,
sondern **je Gliedmaßengruppe** aufgespannt (Rumpf, beide Arme, beide Beine) —
die verheerendste Fehlform eines geometrischen Lifters ist eine einzelne
invertierte Gliedmaße bei sonst korrekter Rekonstruktion.

Zusätzlich fließt die **Bewegungsrauheit** in die Bewertung ein: Eine Hypothese,
die für einen Teil des Clips richtig und für den Rest falsch ist, projiziert in
jedem Einzelbild perfekt, lässt das Gelenk aber über die Mehrdeutigkeit springen.
Echte Gliedmaßen tun das nicht.

## Die Vertikale — der teuerste Fehler des Projekts

Rumpfneigung, Treffpunkthöhe, Beckenhub und alle Rotationen sind gegen „oben"
definiert. Ist die Vertikale schief, sind sie alle schief, und zwar auf eine
Weise, die einzeln nirgends auffällt.

Zwei Ansätze wurden gebaut und beide waren um etwa **20 Grad falsch**, während
sie über 0,9 Confidence meldeten:

**Versuch 1: Richtungen, von denen bekannt ist, dass sie horizontal sind** — die
Linie zwischen den Füßen, die Zehenrichtung — und die dazu orthogonale Richtung
suchen. Ein Zehenvektor ist etwa neun Zentimeter lang; die zwei bis drei
Zentimeter Tiefenfehler, die er aus der Rekonstruktion erbt, kippen ihn um
zwanzig Grad. Die Normierung jedes Hinweises auf Einheitslänge gab diesen
hoffnungslosen Vektoren dieselbe Stimme wie den belastbaren.

**Versuch 2: die Rumpfachse**, Hals zu Becken. Das sieht wie die naheliegende
Wahl aus und ist die schlechteste verfügbare: _Jedes_ Gelenk darauf ist
abgeleitet statt beobachtet, Becken und Hals werden beide aus denselben Schulter-
und Hüftmittelpunkten konstruiert, und ihre Tiefenfehler sind genau so
korreliert, dass sie das Segment kippen statt es zu verlängern.

**Was funktioniert.**

1. _Primär: die Schwerkraft aus dem Ballwurf._ Ein geworfener Ball ist im freien
   Fall, seine Beschleunigung **ist** die Schwerkraft — die einzige Größe im
   Tennisvideo, deren Richtung a priori bekannt und deren Betrag prüfbar ist.
   Unter Projektion bleibt ihre Bildbeschleunigung parallel zur Projektion der
   Schwerkraftrichtung, was die Weltvertikale auf eine Ebene durch das optische
   Zentrum einschränkt.

2. _Sekundär: die längste direkt beobachtete Körperachse_ — Hals zum Mittelpunkt
   der Sprunggelenke, etwa 1,6 m, an beiden Enden auf Gelenken verankert, die
   ein Detektor tatsächlich sieht. Dieselben wenigen Zentimeter Tiefenfehler
   kippen sie um zwei Grad statt um zwanzig. Sie legt fest, welche Richtung
   innerhalb der Schwerkraftebene gemeint ist.

Gemessen gegen Ground Truth über fünf Kameraperspektiven:

| Perspektive     | Fehler der Vertikalen |
| --------------- | --------------------- |
| seitlich        | 0,3°                  |
| erhöht seitlich | 1,8°                  |
| von hinten      | 2,5°                  |
| diagonal        | 2,8°                  |
| von vorn        | 3,5°                  |

Der implizite Schwerkraftbetrag wird als unabhängige Prüfung mitberechnet und
kommt bei 9,0 bis 10,7 m/s² heraus — eine kostenlose Kontrolle der gesamten
Skalenkette, und zugleich der Nachweis, dass wirklich ein fallender Ball verfolgt
wurde und kein Vogel.

**Ohne sichtbaren Ballwurf** bleibt nur die Körperachse. Die Confidence sinkt
entsprechend, und alle Größen, die auf „oben" Bezug nehmen, tragen das mit.

## Die Zielrichtung

„Vor dem Körper" ist ohne eine Zielrichtung nicht definiert. Ohne Platzlinien
und ohne verwertbaren Balltrack nach dem Kontakt bleibt nur die horizontale
Normale der Schulterachse im Treffpunkt — ein schwacher Hinweis, der mit
Confidence 0,45 geführt wird.

Die Konsequenz ist bewusst hart: Fällt diese Confidence unter 0,35, wird
`contactAheadOfFrontFoot` **nicht geschätzt**, sondern mit Begründung als nicht
messbar ausgewiesen. Platzlinien im Bild lösen das vollständig und sind die
wirksamste Einzelmaßnahme, die ein Trainer beim Filmen ergreifen kann.

## Was mehrere Kameras oder Sensorik brauchen würde

| Größe                                             | Warum eine Kamera nicht reicht                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Ballgeschwindigkeit, Spin, Abflugwinkel           | Tiefe nur aus wenigen Pixeln Bildradius; Ball nach Kontakt oft gar nicht detektierbar                                    |
| Absolute Schlägerkopfgeschwindigkeit unter 120 Hz | Sehne gegen Bogen; der Kopf ist zwischen zwei Bildern woanders                                                           |
| Gelenkmomente, Kräfte                             | Erfordert Kraftmessplatten oder Inverse Dynamik mit validierten Segmentmassen                                            |
| Innenrotation des Humerus                         | Rotation um die eigene Längsachse ist aus Gelenkpositionen prinzipiell nicht bestimmbar; braucht Marker-Cluster oder IMU |
| Handgelenkskinematik im Detail                    | Erfordert Auflösung und Bildrate deutlich über dem, was am Platz gefilmt wird                                            |
| Genauigkeit unter ~30 mm MPJPE                    | Braucht kalibrierte Mehrkamera-Anordnung                                                                                 |
