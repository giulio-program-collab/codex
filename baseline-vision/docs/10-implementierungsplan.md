# 10 · Implementierungsplan und Priorisierung

## Priorisierung

Die Reihenfolge folgt der Vorgabe: Zuverlässigkeit vor biomechanischer Tiefe vor
Trainernutzen vor Komfort. Ein schönes UI mit einer schlechten Analyse ist kein
erfolgreiches Produkt.

### P0 — Zuverlässigkeit

Ohne diese Stufe ist jede weitere Arbeit Aufbau auf Sand.

| Aufgabe                                          | Status     | Aufwand                   |
| ------------------------------------------------ | ---------- | ------------------------- |
| Qualitäts-Gate, Bildratensperren                 | **fertig** | —                         |
| Kameramodell statt `pxPerCm`                     | **fertig** | —                         |
| Ausreißer- und Trackingfehlererkennung           | **fertig** | —                         |
| 3D-Rekonstruktion mit Kovarianz                  | **fertig** | —                         |
| Unsicherheits- und Confidence-System             | **fertig** | —                         |
| Plausibilitäts- und Erwartungsprüfung            | **fertig** | —                         |
| Pose-Estimator anschließen (RTMPose)             | offen      | 1–2 Wochen                |
| Tiefenprior anschließen (MotionBERT/VideoPose3D) | offen      | 2–3 Wochen                |
| Unsicherheit des Tiefenmodells kalibrieren       | offen      | 1–2 Wochen                |
| Markerbasierte Referenzdaten erheben             | offen      | 3–4 Wochen inkl. Terminen |
| `METHOD_BIAS` gegen echte Daten neu bestimmen    | offen      | 1 Woche                   |

Der Reihenfolge liegt eine harte Abhängigkeit zugrunde: Ohne Referenzdaten sind
die Typ-B-Terme geraten, und ohne kalibrierte Typ-B-Terme sind alle Intervalle
unbelegt. **Die Datenerhebung ist der Engpass des Projekts, nicht die
Modellintegration.**

### P1 — Biomechanische Qualität

| Aufgabe                                | Status                                 | Aufwand                    |
| -------------------------------------- | -------------------------------------- | -------------------------- |
| Kinetische Kette, Timing, Sequenz      | **fertig**                             | —                          |
| Schlägertracking und Kopfbahn          | **fertig** (Schnittstelle)             | Detektor: 2 Wochen         |
| Balltracking, Treffpunkt, Schwerkraft  | **fertig** (Schnittstelle)             | TrackNetV3: 1–2 Wochen     |
| Platzlinien-Kalibrierung (Homographie) | Schnittstelle vorhanden, Solver offen  | 1–2 Wochen                 |
| Vorhand und Rückhand vollständig       | Phasenlogik vorhanden, Features fehlen | 3–4 Wochen                 |
| Gelernte Phasensegmentierung           | offen                                  | 2–3 Wochen nach Annotation |

Die **Platzlinien-Kalibrierung** hat das beste Verhältnis von Aufwand zu Wirkung
auf dieser Stufe: Sie fixiert Brennweite, Bodenebene und Zielrichtung in einem
Schritt und macht damit `contactAheadOfFrontFoot` überhaupt erst messbar,
halbiert die Skalenunsicherheit und stabilisiert die Vertikale zusätzlich.

### P2 — Trainernutzen

| Aufgabe                                                      | Status             | Aufwand               |
| ------------------------------------------------------------ | ------------------ | --------------------- |
| Befunde mit Beobachtung/Interpretation/Konsequenz/Empfehlung | **fertig**         | —                     |
| Trainerentscheidung je Befund                                | **fertig** (lokal) | Serverseitig: 1 Woche |
| Eigenvergleich über Sitzungen                                | **fertig**         | —                     |
| Vergleichsansicht, phasensynchron                            | **fertig**         | —                     |
| Mehrere Wiederholungen je Sitzung aggregieren                | offen              | 1–2 Wochen            |
| Spielerprofil (Verletzungen, Ziele, Stil)                    | offen              | 1 Woche               |
| Export in den bestehenden Berichtsgenerator                  | offen              | 3–5 Tage              |

**Mehrere Wiederholungen** waren wichtiger, als der Aufwand vermuten ließ. Die
Aufgabenstellung verlangt Mittelwert, Median, Streuung, Ausreißer und
Konsistenz — und die Bildratenschwellen des Systems verlangen ohnehin drei bis
fünf Wiederholungen, bevor eine Timing-Aussage zulässig ist. Ein einzelner
analysierter Schlag kann diese Schwelle nie erreichen.

### P3 — Komfort

3D-Ansicht mit Körpervolumen, Überlagerung zweier Skelette in derselben Ansicht,
Anmerkungswerkzeuge im Video, Videoexport mit eingebranntem Overlay,
Team-Freigabe von Analysen.

## Integration in Baseline Pro

Die bestehende App ist ein React-Bundle mit lokaler Datenhaltung. Die Engine ist
abhängigkeitsfreies TypeScript und läuft in beiden Umgebungen.

**Schritt 1 — Engine als Bibliothek einbinden.** `analyse(request, options)` ist
die einzige Schnittstelle. Der bestehende Videoanalyse-Tab ruft sie auf, statt
Klickpunkte zu verrechnen.

**Schritt 2 — Inferenz platzieren.** Pose-Estimation und Tiefenmodell laufen
entweder per ONNX Runtime Web im Browser (Datenschutz: das Video verlässt das
Gerät nicht, wie in der bestehenden App zugesichert) oder serverseitig. Die
Browser-Variante ist bei einem 240-fps-Clip deutlich langsamer, hält aber die
Zusage „bleibt lokal" — die zu brechen bei Aufnahmen von Minderjährigen ein
eigenes Problem wäre.

**Schritt 3 — Datenmodell erweitern.** Die bestehenden `videoAnalyses`-Einträge
speichern eine Ähnlichkeitszahl. Das neue Schema speichert den vollen
`AnalysisReport`. Altdaten bleiben lesbar, werden aber als „nach altem Verfahren"
gekennzeichnet und gehen nicht in den Eigenvergleich ein — sie sind mit den
neuen Werten nicht vergleichbar.

**Schritt 4 — Objektivitätsgrad speisen.** Der bestehende Objektivitätsgrad
bekommt die Analysequalität als Beitrag, gewichtet mit der Confidence statt mit
der bloßen Existenz einer Analyse.

## Was zuerst gebaut werden sollte, wenn Zeit knapp ist

Wäre nur für drei Dinge Zeit:

1. **Pose-Estimator und Tiefenprior anschließen.** Ohne sie ist die
   Rekonstruktion um eine Größenordnung schlechter, und alles Weitere hängt
   daran.
2. **Markerbasierte Referenzdaten erheben.** Ohne sie sind die Intervalle nicht
   kalibriert, und ohne kalibrierte Intervalle ist das ganze Confidence-System
   eine Behauptung.
3. **Platzlinien-Kalibrierung.** Sie fixiert Brennweite, Bodenebene und
   Zielrichtung in einem Schritt und ist die wirksamste Einzelmaßnahme, die ohne
   neue Datenerhebung auskommt.

Die Reihenfolge ist bewusst: Punkt 2 ist der langwierigste und sollte parallel zu
Punkt 1 beginnen, weil er von Terminen mit Spielern und einem Labor abhängt.
