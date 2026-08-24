# 07 · Plausibilitätsprüfung und Fehlerdiagnose

## Der Sinner-Test als Systembestandteil

Wenn ein hochwertiges Video eines Weltklasse-Spielers analysiert wird und
„schlechter Aufschlag" herauskommt, darf die erste Frage nicht lauten, wie man
das Ergebnis besser formuliert, sondern **welcher Teil der Analysekette falsch
ist — und wie wir das belegen**.

Layer 13 führt diese Prüfung als Code aus, nicht als Grundsatz.

## Die Erwartungsprüfung

```ts
EXPECTED_BAND[player.level]; // z. B. elite → [70, 100]
```

Liegt der Gesamtwert mehr als 10 Punkte außerhalb des Bandes, das zum
angegebenen Leistungsniveau gehört, wird ein **blockierendes** Issue erzeugt:
Die Analyse ist erstellt, aber sie wird nicht als Urteil ausgegeben.

Das ist bewusst keine Korrektur des Ergebnisses. Der Wert wird nicht
zurechtgebogen und nicht heimlich angehoben — es wird festgestellt, dass sich
Ergebnis und Erwartung widersprechen, und dass einer von beiden falsch ist.
Danach bekommt der Trainer die Prüfliste, in Pipeline-Reihenfolge:

1. Ist die Pose in der relevanten Phase korrekt erkannt?
2. Ist die Kameraperspektive für die betroffenen Größen überhaupt geeignet?
3. Ist der Schläger korrekt erkannt?
4. Ist der Treffpunkt korrekt erkannt?
5. Sind die Bewegungsphasen korrekt segmentiert?
6. Sind die 3D-Werte physiologisch plausibel?
7. Passt die Referenzkohorte zu diesem Spieler?
8. Widersprechen sich einzelne Messungen?
9. Wie hoch ist die Unsicherheit der ausschlaggebenden Kenngrößen?

Als Belege liefert das Issue die Qualitätskomponenten und alle Kenngrößen mit
|z| > 1 samt ihrer kombinierten Streuung — also genau die Zahlen, die man
braucht, um den Widerspruch aufzulösen.

**Die Prüfung wirkt in beide Richtungen.** Ein Nachwuchsspieler, der plötzlich
94/100 erhält, löst dasselbe Issue aus. Ein zu gutes Ergebnis ist genauso ein
Symptom einer kaputten Kette wie ein zu schlechtes — und es fällt in der Praxis
niemandem auf, weil niemand sich über ein Lob beschwert.

## Widerspruchsprüfungen

Diese fangen eine kaputte Pipeline, wenn jede Einzelzahl für sich noch möglich
aussieht. Die Physik erlaubt es nicht, einen Treffpunkt auf dem 1,6-fachen der
eigenen Körperhöhe zu erreichen, ohne Beinantrieb und mit gebeugtem Arm.

| Prüfung                 | Was sie erkennt                                                              |
| ----------------------- | ---------------------------------------------------------------------------- |
| `reach_vs_elbow`        | Sehr hoher Treffpunkt bei stark gebeugtem Ellbogen — geometrisch unvereinbar |
| `reach_vs_shoulder`     | Sehr hoher Treffpunkt bei niedriger Schulterelevation                        |
| `drive_vs_racket_speed` | Hohe Schlägerkopfgeschwindigkeit ohne messbaren Beinantrieb                  |
| `sequence_internal`     | Becken-Peak, Rumpf-Peak und deren Abstand sind untereinander inkonsistent    |

`sequence_internal` ist eine reine Selbstkonsistenzprüfung: Der Abstand muss
gleich der Differenz der beiden Einzelwerte sein. Weicht er um mehr als 20 ms ab,
stimmt etwas mit der Peak-Lokalisierung nicht — ein Fehler, den keine
Einzelmessung zeigen würde.

## Physiologische Bereiche

Jede Kenngröße hat einen Bereich, außerhalb dessen sie nicht plausibel ist —
nicht „ungewöhnlich", sondern **unmöglich**:

```
Maximale Beckenrotationsgeschwindigkeit: 40 – 1400 °/s
Rumpfneigung (Trophy):                     0 –   55 °
Treffpunkt vor dem vorderen Fuß:        −0,6 –  0,8 × Körperhöhe
```

Messungen außerhalb werden **verworfen**, nicht begrenzt. Eine geclippte Messung
sieht plausibel aus und ist es nicht; eine verworfene ist als fehlend erkennbar.
Die Zahl der Verwerfungen ist selbst ein Issue: Drei verworfene Messungen sind
ein Hinweis auf ein Kettenproblem, nicht auf drei unabhängige Ausreißer.

## Ausreißer- und Trackingfehlererkennung

In Layer 5, mit den Fehlerarten, nach denen die Aufgabenstellung fragt:

| Fehlerart                             | Verfahren                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Fehlerhafte Bilder                    | Score-Schwelle je Gelenk                                                       |
| Tracking-Sprünge                      | Physiologische Geschwindigkeitsgrenzen je Gelenkgruppe                         |
| Unrealistische Gelenkwinkel           | Knochenlängenprüfung im Bild (Projektion ≤ echte Länge)                        |
| Unmögliche Geschwindigkeitsänderungen | Spike-Test gegen lokalen Median, MAD-skaliert                                  |
| Plötzlich verschwindende Körperteile  | Lückenerkennung; über drei Bilder hinaus keine Interpolation                   |
| Falsch erkannter Schläger             | Abdeckungs- und Confidence-Schwellen in Layer 7                                |
| Falsch erkannter Ball                 | Geschwindigkeitssprung-Prüfung; implizite Schwerkraft muss zu 9,81 m/s² passen |
| Falscher Spieler                      | Identitätsprüfung über Schwerpunktsprung und scheinbare Körpergröße            |
| Links/Rechts-Vertauschung             | Zuordnungskostenvergleich mit deutlichem Abstand                               |

Ein Gelenk darf ohne plausible biomechanische Ursache in einem Bild nicht 40 cm
springen — und wenn es das tut, wird die Stichprobe verworfen und gezählt.

## Die Diagnose-Pipeline im Dashboard

```
L1  Video-Ingestion & Qualitäts-Gate     ok        100 %
L2  Kamerakalibrierung                   ok         88 %
L3  Spielererkennung & Track             ok        100 %
L4  Pose-Estimation                      ok         90 %
L5  Temporales Tracking                  degraded   41 %   verworfen 9,7 %
L6  3D-Rekonstruktion                    ok         75 %   Spiegelungssicherheit 0,90
L7  Schlägererkennung                    failed      2 %   Abdeckung 4 %
L8  Ballerkennung                        ok         50 %
L9  Bewegungssegmentierung               failed     19 %   Treffpunkt unsicher
L10 Biomechanische Merkmale              degraded   48 %
L11 Referenzvergleich                    ok        100 %
L12 Confidence                           ok        100 %
L13 Interpretation                       ok        100 %
L14 Report                               ok        100 %
```

Jeder Layer meldet zusätzlich seine eigenen Diagnosewerte — Verwerfungsrate,
Knochenresiduum in Zentimetern, Anteil geometrisch unmöglicher Segmente, Quelle
der Vertikalen, implizite Schwerkraft, Abweichung zwischen den beiden
Vertikalschätzungen. Damit ist ein falsches Ergebnis lokalisierbar, statt nur
korrigierbar.

Im Beispiel oben ist der Fehler eindeutig L7; L9 und L10 sind Folgeschäden. Ohne
diesen Trail würde man an L10 zu optimieren beginnen.

## Was die Prüfung nicht tut

Sie korrigiert das Ergebnis nicht. Sie hebt keinen Wert an, sie unterdrückt keine
unbequeme Messung und sie führt keine Ausnahme für berühmte Spieler ein. Sie
stellt fest, dass zwei Dinge sich widersprechen, blockiert das Urteil und legt
die Belege daneben.

Ein System, das den Sinner-Fall dadurch löst, dass es Weltklasse-Aufschläge
besser bewertet, hätte nichts gelernt.
