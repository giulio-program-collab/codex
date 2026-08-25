# 05 · Biomechanisches Feature-Set

## Was gemessen wird

Sechzehn Kenngrößen, jede als `Measure` mit Unsicherheit und
Beobachtbarkeitsklasse. Keine wird aus einem Einzelbild gelesen; alle laufen über
Monte-Carlo-Replikate der gesamten rekonstruierten Sequenz.

### Ladephase

| Kenngröße                   | Was sie erfasst                                           | Wirkmechanismus                                                                                               |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `kneeFlexionPeak`           | Maximale Flexion des vorderen Knies                       | Der Beinantrieb ist der Anfang der Kette und der einzige Punkt, an dem gegen den Boden gearbeitet werden kann |
| `trunkTiltAtTrophy`         | Rumpfneigung zur Vertikalen in der Trophy-Position        | Ohne Neigung keine Bogenspannung; der Aufschlag wird aus dem Arm gespielt                                     |
| `hipShoulderSeparationPeak` | Maximale Winkeldifferenz zwischen Hüft- und Schulterachse | Speichert die elastische Energie, die der Rumpf danach freisetzt                                              |

### Beschleunigung und kinetische Kette

| Kenngröße                   | Was sie erfasst                                                      |
| --------------------------- | -------------------------------------------------------------------- |
| `pelvisPeakAngularVelocity` | Maximale Rotationsgeschwindigkeit des Beckens                        |
| `trunkPeakAngularVelocity`  | Maximale Rotationsgeschwindigkeit des Rumpfes                        |
| `pelvisPeakLead`            | Zeitlicher Abstand des Becken-Peaks zum Treffpunkt                   |
| `trunkPeakLead`             | Zeitlicher Abstand des Rumpf-Peaks zum Treffpunkt                    |
| `sequenceMargin`            | Abstand zwischen beiden Peaks — positiv heißt proximal-distal intakt |
| `racketHeadPeakSpeed`       | Spitzengeschwindigkeit des Schlägerkopfs                             |

Die drei zeitlichen Größen unterliegen einem harten Gate: Unter 60 Hz werden sie
gar nicht erzeugt, und ohne genug Wiederholungen werden sie zwar gemessen, aber
nicht gegen eine Referenzverteilung gestellt. Siehe
[12 Sitzung und Verlauf](12-sitzung-und-verlauf.md).

`sequenceMargin` ist die wichtigste Einzelgröße des Aufschlags. Kehrt sich die
Reihenfolge um — dreht der Rumpf vor dem Becken —, ist jede Diskussion über
Timing-Feinheiten verfrüht, weil dem Rumpf die Basis fehlt, gegen die er
arbeiten könnte.

### Treffpunkt

| Kenngröße                           | Beobachtbarkeit                                                           |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `shoulderElevationAtContact`        | rekonstruiert                                                             |
| `elbowFlexionAtContact`             | rekonstruiert                                                             |
| `contactHeightRatio` (× Körperhöhe) | rekonstruiert — robuster als der Absolutwert                              |
| `contactHeightM`                    | rekonstruiert, zusätzlich mit der gemeinsamen Skalenunsicherheit belastet |
| `contactAheadOfFrontFoot`           | benötigt die Zielrichtung; ohne sie **nicht messbar**                     |

### Antrieb und Landung

| Kenngröße             | Was sie erfasst                                                                   |
| --------------------- | --------------------------------------------------------------------------------- |
| `legDriveRise`        | Vertikaler Weg des Beckens zwischen tiefster Ladung und Treffpunkt                |
| `landingLateralShift` | Seitliche Abweichung der Landung, als Hinweis auf Antrieb quer zur Schlagrichtung |

## Keine isolierten Winkel

Der klassische Fehler schlechter Sportanalyse lautet: „Ellbogen 104°, optimal
110°, also schlecht." Drei Mechanismen verhindern das hier.

**1. Wirkrichtung.** Jedes Referenzband trägt eine `concernDirection`. Bei der
Knieflexion ist nur _zu wenig_ ein Befund — mehr Beugung als die Referenz ist
kein Fehler und senkt den Wert nicht. Eine beidseitige Abweichung wird nur dort
als solche behandelt, wo es dafür einen Mechanismus gibt.

**2. Wirkmechanismus statt Abweichung.** Ein Befund entsteht nur, wenn dem
Messwert ein `mechanism` zugeordnet ist — eine Aussage darüber, _warum_ die
Abweichung etwas mit dem Schlag macht. Eine Abweichung ohne Mechanismus ist ein
Unterschied, keine Schwäche.

**3. Kontextregeln über mehrere Größen.** Layer 13 prüft Kombinationen, bevor es
Einzelwerte bewertet: Ein flacher Ellbogenwinkel bei gleichzeitig hoher
Armstreckung und hohem Treffpunkt ist ein Messproblem, kein technisches. Diese
Konsistenzprüfungen (`reach_vs_elbow`, `reach_vs_shoulder`,
`drive_vs_racket_speed`, `sequence_internal`) laufen _vor_ der Befundbildung.

## Referenzmodell

Referenzbänder sind keine Datenbank aus „ATP-Spieler = perfekt". Jedes Band
trägt:

```ts
{
  featureId, mean, sd, unit, sourceId,
  concernDirection,           // in welche Richtung eine Abweichung wirkt
  mechanism,                  // warum sie wirkt
  definitionMatch,            // ist es überhaupt dieselbe Messgröße?
  definitionNote?             // wenn nicht: was genau unklar ist
}
```

### `definitionMatch` — der Sinner-Fehler, explizit gemacht

Gelenkwinkel haben mehrere unvereinbare Konventionen: ISB-Elevation, Abduktion
in der Skapularebene, Winkel zur Rumpflängsachse, Winkel zur Horizontalen. Die
Publikationen sagen nicht immer, welche gemeint ist.

Die Schulterelevation im Treffpunkt ist der konkrete Fall. Die Quelle gibt
110,7° ± 16,9° an; dieses System misst den Winkel zwischen Rumpflängsachse und
Humerus, der bei einem Aufschlag im Treffpunkt bei 160–170° liegt. Sechzig Grad
Unterschied sind mit hoher Wahrscheinlichkeit **zwei Konventionen und nicht ein
technischer Fehler**. Solange die Konvention der Quelle nicht gegen ihren
Methodenteil bestätigt ist, wird das Band angezeigt, aber nicht bewertet und
erzeugt keinen Befund.

Genau diese Prüfung fehlte im alten System — dort erzeugte dieselbe Größe einen
konstanten Abzug von 6 bis 8 Punkten, für jeden Aufschlag.

### Kohorten-Mismatch verbreitert, statt zu verschieben

Ein 13-Jähriger von 1,65 m ist kein kleiner ATP-Profi. Der Vergleich mit einer
Elite-Erwachsenenkohorte wird nicht _verschoben_ — das wäre eine Erfindung —,
sondern die **Vorhersagestreuung wird verbreitert**, was statistisch korrekt ist:
Wer nicht zur Kohorte gehört, für den ist das Intervall breiter.

Verbreitert wird nach Niveauabstand, relativer Körpergrößenabweichung und
Erwachsenen-versus-Junior. Wird der Kohorten-Term größer als der Abstand des
Spielers zum Referenzwert, meldet Layer 13 das ausdrücklich: der Eigenvergleich
ist dann aussagekräftiger als der Referenzvergleich.

### Vier Vergleichsdimensionen

1. **Allgemeines biomechanisches Referenzmodell** — publizierte Verteilungen mit
   Konvention und Kohorte.
2. **Ähnliche Spieler** — dieselbe Kohorte, sobald genug eigene Daten vorliegen.
3. **Eigene Historie** — der aussagekräftigste Vergleich, weil systematische
   Messfehler sich weitgehend aufheben.
4. **Ausgewählte Profivideos** — als Kontext, nie als Sollwert.

Der Eigenvergleich verlangt zwei Bedingungen gleichzeitig: Die Veränderung muss
das Messrauschen übersteigen (Signifikanz) **und** eine trainingsrelevante
Mindestgröße erreichen. Eine statistisch signifikante Veränderung von zwei Grad
ist für einen Trainer nichts.

## Was ableitbar ist und was nicht

**Aus einem einzelnen Video zuverlässig ableitbar:**
Gelenkwinkel und ihre Verläufe; Rotationswinkel und -geschwindigkeiten von Becken
und Rumpf; zeitliche Abstände zwischen Segment-Peaks (ab 60 Hz); Treffpunkthöhe
relativ zur Körperhöhe; Beckenhub; Phasendauern; Konsistenz über mehrere
Wiederholungen.

**Nur unter Bedingungen ableitbar:**
Schlägerkopfgeschwindigkeit (ab 120 Hz); absolute Längen (mit Platzkalibrierung
deutlich besser); Treffpunkt relativ zum Körper (braucht eine bestimmbare
Zielrichtung); Rotationsvorzeichen (braucht eine sichere Chiralitätsauflösung).

**Grundsätzlich nicht ableitbar** — siehe [04](04-3d-konzept.md), Abschnitt
„Was mehrere Kameras oder Sensorik brauchen würde".
