# 06 · Confidence- und Unsicherheitssystem

## Warum keine analytische Fehlerfortpflanzung

Gelenkwinkel, Trennungswinkel und zeitliche Abstände zwischen Segment-Peaks sind
stark nichtlineare Funktionen von Gelenkpositionen. Eine Gauß-Approximation
erster Ordnung unterschätzt die Streuung genau dort, wo es am meisten darauf
ankommt: in der Nähe eines verkürzt abgebildeten Gliedes, wo die Ableitung des
projizierten Winkels nach der Tiefe explodiert.

Jede abgeleitete Größe wird deshalb auf **N = 120 gestörten Replikaten** des
rekonstruierten Skeletts berechnet. Die Streuung der Ergebnisse _ist_ die
Unsicherheit. Das kostet wenige Millisekunden je Kenngröße und ist bei jedem Grad
von Nichtlinearität ehrlich.

## Zwei Fehlerarten, getrennt behandelt

### Typ A — was die Streuung der Daten hergibt

Das Monte-Carlo. Gestört wird je Gelenk mit der Kovarianz, die Layer 6 meldet:
`sigmaInPlane` über die beiden Bildachsen, `sigmaDepth` entlang der optischen
Achse.

**Zeitliche Korrelation.** 60 % des Positionsfehlers eines Gelenks wird als über
den Clip konstant modelliert, 40 % als je Bild unabhängig. Das ist keine
Stellschraube, sondern eine Aussage darüber, woher der Fehler kommt: Der
Tiefenskalenfehler, der Brennweitenfehler und der anthropometrische
Knochenlängenfehler sind in jedem Bild identisch; nur das Detektorzittern ist
unabhängig.

Den gesamten Fehler als unabhängig zu behandeln, würde jede Geschwindigkeit und
jeden zeitlichen Abstand weit verrauschter aussehen lassen als er ist —
Differenzieren verstärkt weißes Rauschen. Ihn als vollständig korreliert zu
behandeln, würde das Gegenteil tun. Die Aufteilung wirkt sich genau auf die
Größen aus, von denen die Analyse der kinetischen Kette lebt.

**Gemeinsame Skala getrennt geführt.** Die Distanz zur Kamera ist um einige
Prozent unsicher — bei acht Metern über einen halben Meter. Diese Zahl in die
Kovarianz des Wurzelgelenks zu schreiben, hieße, in jedem Replikat das Becken
einen halben Meter _relativ zum restlichen Körper_ zu verschieben. Das tut der
Fehler nicht: Er verschiebt das ganze Skelett gemeinsam. Er wird deshalb als
`scaleRelSd` geführt und nur auf absolute Längen angewandt, wo er tatsächlich
wirkt. Bei Winkeln und Verhältniswerten entfällt er.

Der Effekt dieser Trennung war groß: Vorher waren die Intervalle der Gelenkwinkel
um das Drei- bis Zehnfache zu breit, und eine kalibrierte 240-fps-Aufnahme
meldete, dass sich nichts von nichts unterscheiden lasse.

**Treffpunktzeit als Zufallsgröße.** Der Treffpunkt ist kein bekannter Zeitpunkt,
sondern eine Schätzung mit eigener Streuung, und jede „im Treffpunkt" gelesene
Größe erbt sie. Bei 30 m/s Schlägerkopfgeschwindigkeit ist ein Bild bei 240 fps
13 cm Treffpunkthöhe. Der Treffpunkt wird deshalb je Replikat neu gezogen.

### Typ B — was das Verfahren systematisch falsch macht

Das Monte-Carlo beantwortet die Frage „wie stark würde sich diese Zahl bewegen,
wenn die Gelenke innerhalb ihrer Kovarianz woanders lägen". Einen **Bias** kann
es nicht sehen — einen Fehler, den das Verfahren jedes Mal gleich macht.

Die Validierungssuite zeigt mehrere: Die Schulterelevation im Treffpunkt liest
etwa zehn Grad zu hoch, die Schulter-Hüft-Trennung etwa acht Grad zu niedrig. Ein
Intervall, das einen bekannten Bias ignoriert, ist nicht konservativ, sondern
falsch.

`METHOD_BIAS` in `l10-features.ts` führt je Kenngröße einen gemessenen
Restsystematikwert, der quadratisch zur Monte-Carlo-Streuung addiert wird. Die
Werte sind an der synthetischen Suite bestimmt und damit eine **untere
Schranke** — sie müssen vor jedem Produktiveinsatz gegen markerbasierte
Referenzdaten an echten Spielern neu bestimmt werden. Eine synthetische Fixture
kann keinen Bias zeigen, der daher rührt, wie echte Pose-Estimatoren versagen.

## Confidence ist nicht Streuung

```
sd          = Streuung eines Wertes, den wir zu messen glauben
confidence  = Wahrscheinlichkeit, dass wir überhaupt das Richtige gemessen haben
```

Die Confidence entsteht multiplikativ aus benannten Vertrauensfaktoren — ein
schlechter Faktor genügt, um eine starke Aussage zu unterdrücken:

- Gelenkabdeckung der beteiligten Gelenke nach der Bereinigung
- Sicherheit der Phasenerkennung
- Sicherheit der Treffpunktbestimmung
- Sicherheit der Vertikalen
- Sicherheit der Tiefenrichtung (für vorzeichenbehaftete Größen)
- Sicherheit der Zielrichtung (für richtungsbezogene Größen)
- Güte des schwächsten beteiligten Layers
- Anteil der Monte-Carlo-Replikate, in denen die Größe überhaupt berechenbar war

## Die Schwellen

| Schwelle                  | Wert     | Bedeutung                                                     |
| ------------------------- | -------- | ------------------------------------------------------------- |
| `QUOTABLE_CONFIDENCE`     | 0,35     | Darunter wird die Zahl dem Trainer nicht als Messwert gezeigt |
| `ACTIONABLE_CONFIDENCE`   | 0,60     | Darunter darf die Zahl keine Trainingsempfehlung tragen       |
| `MIN_QUALITY_FOR_VERDICT` | 55 / 100 | Darunter entsteht überhaupt kein Gesamturteil                 |
| `MIN_SCORING_FEATURES`    | 3        | Weniger informative Vergleiche ⇒ kein Gesamtwert              |
| `MIN_TIMING_HZ`           | 60       | Darunter keine Zeitmessung, unabhängig von allem anderen      |
| `MIN_RACKET_SPEED_HZ`     | 120      | Darunter keine Schlägerkopfgeschwindigkeit                    |

Die Trennung von `QUOTABLE` und `ACTIONABLE` ist wesentlich: Es gibt einen
Bereich, in dem ein Wert es wert ist, gezeigt zu werden, aber nicht, danach zu
trainieren.

## „Informativ" — die entscheidende Prüfung

Ein Vergleich zählt nur, wenn er überhaupt etwas hätte entdecken können. Formal:

```
z_eff = (Wert − Referenzmittel) / √(sd_Referenz² + sd_Messung² + sd_Kohorte²)
```

Ist `sd_Messung` größer als `sd_Referenz`, läge **jeder** Wert im Band —
unabhängig von der tatsächlichen Technik. Ein solcher Vergleich ist nicht
„unauffällig", er ist nichtssagend, und er darf den Gesamtwert nicht bewegen.

Diese Prüfung sorgt auch dafür, dass eine schlechtere Aufnahme nie ein besseres
Ergebnis liefern kann — ein Fehler, den fast jedes naive Scoring-System hat.

## Analysequalität

Sechs Komponenten, jede mit einer konkreten Abhilfe:

| Komponente         | Abhilfe bei schlechtem Wert                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| Pose-Tracking      | Bessere Ausleuchtung, Spieler vollständig im Bild, ruhiger Hintergrund          |
| 3D-Rekonstruktion  | Kamera weiter weg und höher, Platzlinien mit ins Bild, Brennweite dokumentieren |
| Schläger-Tracking  | Höhere Bildrate (≥ 120 fps), kürzere Belichtungszeit                            |
| Ball-Tracking      | Höhere Bildrate, kontrastreicher Hintergrund, nicht gegen die Sonne             |
| Phasenerkennung    | Gesamten Bewegungsablauf inklusive Landung aufnehmen                            |
| Kamerakalibrierung | Platzlinien im Bild, Brennweite aus den Metadaten erhalten                      |

Der Gesamtwert ist das **Minimum-gewichtete Mittel**, nicht das arithmetische:
Eine perfekte Pose-Schätzung auf einer zusammengebrochenen Rekonstruktion ist
immer noch eine kaputte Messung.

## Ausgabeform

Jede Zahl erscheint als Wert ± Streuung, mit 95-%-Intervall, Confidence in
Prozent und Beobachtbarkeitsklasse:

| Kenngröße                   | Wert                     | Confidence     | Beobachtbarkeit          |
| --------------------------- | ------------------------ | -------------- | ------------------------ |
| Treffpunkthöhe              | 1,61 ± 0,05 × Körperhöhe | 77 % · mittel  | rekonstruiert            |
| Schulter-Hüft-Trennung      | 27,4 ± 11,2°             | 44 % · niedrig | tiefenlimitiert          |
| Becken-Peak vor Treffpunkt  | −0,075 ± 0,015 s         | 83 % · hoch    | rekonstruiert            |
| Schlägerkopfgeschwindigkeit | nicht messbar            | —              | 30 fps reichen nicht aus |

Bei 44 % Confidence darf daraus keine starke Schlussfolgerung gezogen werden,
und das System zieht auch keine.
