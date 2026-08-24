# 09 · Validierung

## Der Grundsatz

Getestet wird nicht, ob die Visualisierung gut aussieht, sondern ob die Zahlen
stimmen — und wo sie nicht stimmen, ob das System es sagt.

Die Suite umfasst **60 Tests**: 11 Acceptance-Tests entlang der geforderten
Prüffälle, 11 Validierungstests gegen Ground Truth, 3 Tests, die das Verfahren
des bestehenden Systems nachrechnen, und 35 Layer-Unit-Tests.

```bash
cd engine && node --experimental-strip-types --test "test/*.test.ts"
```

## Ground Truth ohne Motion-Capture-Labor

`src/fixtures/serve-model.ts` erzeugt einen **parametrischen, physikalisch
konsistenten 3D-Aufschlag**: konstante Knochenlängen, jeder Freiheitsgrad ein
benannter Parameter, ein ballistischer Ballwurf mit exakt 9,81 m/s².
`src/fixtures/render.ts` projiziert ihn durch eine virtuelle Kamera und erzeugt
das, was ein realer Pose-Estimator ausgibt: Pixelrauschen, das mit
Bewegungsunschärfe wächst, Confidence, die mit Selbstverdeckung fällt,
ausgefallene Gelenke und gelegentliche Links/Rechts-Vertauschungen.

Die Timing-Parameter sind exakt die Größen, die die Biomechanik-Schicht
zurückzugewinnen behauptet. Meldet die Pipeline auf einem mit
`pelvisPeakLeadS: -0,075` erzeugten Clip einen Becken-Peak von −75 ms, ist das
eine echte Messung ihrer Genauigkeit.

**Was das ersetzt und was nicht.** Es ersetzt keine annotierten echten
Aufnahmen — der Plan dafür steht unten. Es ist ein Regressionsrahmen mit
bekannten Antworten, und das ist die einzige Möglichkeit, eine Änderung, die die
Pipeline verbessert hat, von einer zu unterscheiden, die nur die Zahlen
verschoben hat.

Zuerst wird die Fixture selbst geprüft: Knochenlängen konstant über den Clip
(< 1 % Variation), Übereinstimmung mit der anthropometrischen Tabelle (< 2 %),
Rückgewinnung der kommandierten Kinematik, Schlägerkopfgeschwindigkeit im
plausiblen Bereich (30–50 m/s).

## Gemessene Genauigkeit

### 3D-Rekonstruktion, mittlerer Gelenkfehler

Mit 55-mm-Tiefenprior (Produktionskonfiguration), gegen Ground Truth, nach
Abzug von Wurzelversatz und einer globalen Gierdrehung:

| Perspektive     | mit Tiefenprior | nur Geometrie |
| --------------- | --------------- | ------------- |
| seitlich        | 36 mm           | 330 mm        |
| diagonal        | 47 mm           | 428 mm        |
| erhöht seitlich | 36 mm           | 342 mm        |
| von hinten      | 48 mm           | 503 mm        |
| von vorn        | 49 mm           | 225 mm        |

Die Pipeline setzt auf einen 55-mm-Prior praktisch nichts obendrauf. Der
geometrische Rückfallpfad ist um eine Größenordnung schlechter — und meldet das
über seine Spiegelungssicherheit (typisch 0,35) und die Güte der
Rekonstruktions-Komponente.

### Vertikale

| Perspektive     | Fehler |
| --------------- | ------ |
| seitlich        | 0,3°   |
| erhöht seitlich | 1,8°   |
| von hinten      | 2,5°   |
| diagonal        | 2,8°   |
| von vorn        | 3,5°   |

Implizite Schwerkraft aus dem Ballwurf: 9,0 bis 10,7 m/s² — eine unabhängige
Prüfung der gesamten Skalenkette.

### Körpermaßstab

Rekonstruierte Statur gegen bekannte Körpergröße: unter 5 % mit Tiefenprior,
unter 15 % ohne. Der Maßstab ist das Einzige, was der geometrische Solver
zuverlässig allein kann — er folgt aus Knochenlängen gegen projizierte Längen und
hängt an keiner Vorzeichenauflösung.

### Treffpunkt

Auf 25 ms genau lokalisiert, oder die Treffpunkt-Confidence liegt unter 0,6. Der
Test prüft die Implikation, nicht nur die Genauigkeit: Ein Fehler ist zulässig,
solange das System ihn zugibt.

### Intervall-Abdeckung — die zentrale Behauptung

Der wichtigste Test der Suite: _Bedeuten die Intervalle etwas?_

Über wiederholte Aufnahmen einer bekannten Bewegung muss der wahre Wert
überwiegend im berichteten 95-%-Intervall liegen. Ein Intervall, das in 20 % der
Fälle stimmt, ist eine Lüge; eines, das in 100 % der Fälle stimmt, ist nutzlos
breit.

Gemessen als Verhältnis |Fehler| / berichtete Streuung über sechs Aufnahmen je
Preset:

| Kenngröße                   | Elite | Nachwuchs |
| --------------------------- | ----- | --------- |
| Knieflexion (Peak)          | 0,27  | 0,14      |
| Rumpfneigung (Trophy)       | 0,21  | 0,39      |
| Schulter-Hüft-Trennung      | —     | 0,73      |
| Schulterelevation (Kontakt) | 0,69  | 0,61      |
| Ellbogenflexion (Kontakt)   | 0,32  | 0,81      |
| Becken-Peak vor Kontakt     | 0,69  | 0,61      |
| Rumpf-Peak vor Kontakt      | 0,57  | 0,60      |
| Treffpunkthöhe (Verhältnis) | 0,53  | 1,30      |
| Schlägerkopfgeschwindigkeit | 0,37  | 0,26      |

Alle unter 1,3, die meisten zwischen 0,2 und 0,8 — leicht konservativ, was die
richtige Seite ist, auf der man irren sollte.

### Monotonie der Qualität

Eine schlechtere Aufnahme darf nie eine höhere Analysequalität ergeben. Getestet
über drei Stufen: Laborbedingungen (240 fps, kalibriert) → Handy (120 fps,
diagonal) → schlecht (30 fps, verrauscht, Ausfälle).

### Reproduzierbarkeit

Derselbe Input muss byteidentische Reports erzeugen. Der Test fand einen echten
Fehler: Layer 5 glättete Keypoints _an Ort und Stelle_, sodass zwei Analysen
desselben Clips zwei verschiedene Ergebnisse lieferten. Für einen Trainer, der
die Analyse von gestern wieder öffnet, ist das nicht verhandelbar.

## Die geforderten Acceptance-Tests

| Test    | Was er prüft                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| **T1**  | Ein Weltklasse-Aufschlag wird nie ohne benannten Grund als schlecht bewertet                                     |
| **T1b** | Ein unplausibel hartes Urteil wird von der Erwartungsprüfung abgefangen                                          |
| **T2**  | Schlechte Videoqualität erhöht die Unsicherheit und hält das Urteil zurück                                       |
| **T2b** | Zeitanalyse wird unter der Bildratenschwelle vollständig verweigert                                              |
| **T3**  | Verdeckte Körperteile werden als fehlend gemeldet, nicht in Befunde interpoliert                                 |
| **T4**  | Ein injizierter Trackingfehler wird erkannt und berichtet                                                        |
| **T5**  | Die echten Defizite eines Nachwuchsspielers werden gefunden — und nur diese                                      |
| **T5b** | Der Nachwuchsaufschlag ist messbar vom Elite-Aufschlag verschieden                                               |
| **T6**  | Eine echte Veränderung zwischen Sitzungen wird erkannt, eine Nicht-Veränderung nicht                             |
| **T7**  | Blickwinkelinvariante Größen stimmen über Kameraperspektiven überein, blickwinkelabhängige werden gekennzeichnet |
| **T7b** | Eine Kamera, die eine Achse nicht sehen kann, meldet diese Achse als nicht messbar                               |

T5 prüft ausdrücklich beide Richtungen: Die injizierten Defizite müssen gefunden
werden, **und** es dürfen nicht beliebige Unterschiede zum Profi als Fehler
ausgegeben werden.

## Was die Validierung gefunden hat

Fünf echte Fehler, alle mit gesund aussehenden Zahlen:

1. **Händigkeit der Koordinatenbasis.** Das Kamerasystem war linkshändig, die
   Rekonstruktionsbasis rechtshändig — jede Rekonstruktion war gespiegelt.
   Knochenlängen, Gelenkwinkel und Rückprojektion blieben korrekt; nur die
   Chiralität kippte. Der geometrische Solver verdeckte das, weil das Kippen
   aller Tiefenvorzeichen selbst eine Spiegelung ist; sichtbar wurde es erst,
   als ein Tiefenprior die Tiefen festnagelte.
2. **Vertikale aus zentimeterlangen Fußvektoren.** 15 bis 25 Grad daneben bei
   0,92 gemeldeter Sicherheit.
3. **Wurzelgelenk trug die Distanzunsicherheit.** Gelenkwinkel-Intervalle drei-
   bis zehnfach zu breit.
4. **Treffpunktunsicherheit wurde ignoriert.** Treffpunkthöhe mit 1 cm Intervall
   bei 12 cm echtem Fehler.
5. **Schlägerkopfgeschwindigkeit aus der Rohbahn differenziert.** 27 km/h zu
   hoch, durch Rauschen plus die Aufwärtsverzerrung des Maximums.

Dazu zwei Fixture-Fehler, die Tests gegen etwas prüfen ließen, das nie erzeugt
worden war: eine Beckenhöhe, die annahm, das Sprunggelenk stünde unter der Hüfte,
und ein Ballwurf, der auf ein bewegtes Ziel zielte und deshalb keine Parabel war.

## Was noch validiert werden muss

Die synthetische Suite kann keinen Fehler zeigen, der daher rührt, **wie echte
Pose-Estimatoren versagen**. Vor jedem Produktiveinsatz:

1. **Markerbasierte Referenzdaten.** 20–30 Aufschläge, mehrere Spieler,
   gleichzeitig mit Mehrkamera-Motion-Capture und mit einer Platzkamera
   aufgenommen. Ziel: Gelenklokalisierungsfehler, 3D-Rekonstruktionsfehler und
   die Neubestimmung von `METHOD_BIAS` gegen echte Daten.
2. **Annotierte Phasengrenzen.** Zwei bis drei erfahrene Trainer markieren
   unabhängig; die Übereinstimmung zwischen ihnen ist die Obergrenze dessen, was
   von der automatischen Segmentierung zu erwarten ist.
3. **Perspektiv-Matrix.** Derselbe Schlag gleichzeitig aus fünf Positionen. Die
   blickwinkelinvarianten Größen müssen innerhalb ihrer Intervalle
   übereinstimmen; tun sie es nicht, ist das Fehlermodell falsch.
4. **Bildraten-Matrix.** 30 / 60 / 120 / 240 fps derselben Bewegung, aus einer
   240-fps-Aufnahme heruntergerechnet.
5. **Trainer-Übereinstimmung.** Blindvergleich: Trainer bewerten Aufschläge ohne
   das System; gemessen wird die Übereinstimmung mit den Befunden — und
   ausdrücklich auch, ob das System dort schweigt, wo Trainer uneins sind.
6. **Körpergrößen- und Niveau-Spanne.** Junioren ab 1,50 m bis Erwachsene über
   1,95 m, um die Kohorten-Verbreiterung empirisch zu kalibrieren statt
   angenommen zu lassen.

Erst danach dürfen die Referenzvergleiche als kalibriert gelten. Bis dahin ist
der **Eigenvergleich** die belastbarste Aussage, die das System macht.
