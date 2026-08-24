# 08 · Trainer-Dashboard

Der Prototyp liegt in `dashboard/index.html` und wird aus echtem
Pipeline-Output gebaut (`engine/tools/build-demo.ts`). Nichts darin ist
Beispieldatensatz: Jedes Panel rendert aus demselben `AnalysisReport`, den die
Engine an jeden Aufrufer gibt.

Das ist eine bewusste Einschränkung. Ein Mockup zeigt bereitwillig Dinge, die die
Engine gar nicht produzieren kann, und genau in dieser Lücke kehrt das
Überversprechen zurück.

## Was der Trainer in wenigen Sekunden sehen muss

| Frage                            | Panel                                              |
| -------------------------------- | -------------------------------------------------- |
| Was sehe ich?                    | Kopfzeile, Video-Overlay, Phasen-Timeline          |
| Wie sicher ist die Analyse?      | Analysequalität mit sechs Komponenten und Abhilfen |
| Was ist auffällig?               | Befunde, nach erwartetem Nutzen sortiert           |
| Warum ist es auffällig?          | Interpretation und Konsequenz je Befund            |
| Was bedeutet es für den Schlag?  | Konsequenz je Befund                               |
| Was kann ich trainieren?         | Empfehlung je Befund, als Hypothese formuliert     |
| Hat sich der Spieler verbessert? | Verlauf mit Eigenvergleich                         |

## Die Panels

### Urteil

Entweder ein Gesamtwert mit sichtbaren Komponenten, Gewichten und den Kenngrößen,
aus denen jede Komponente stammt — oder, deutlich hervorgehoben, „Keine
zuverlässige Bewertung möglich" mit den Gründen.

Ein hoher Wert wird ausdrücklich eingeordnet. 100/100 heißt nicht „technisch
perfekt", sondern: _auf keiner messbaren Dimension liegt eine Abweichung vor, für
die es einen biomechanischen Wirkmechanismus gäbe._ Ohne diesen Satz ist eine
100 dieselbe Art falscher Präzision wie eine 63.

Darunter stehen die Plausibilitäts-Issues mit ihren Belegen und der Prüfliste.

### Analysequalität

Sechs Komponenten als Balken. Liegt eine unter 75, erscheint direkt darunter die
konkrete Abhilfe — nicht „Qualität niedrig", sondern „Kamera weiter weg und
höher aufstellen, Platzlinien mit ins Bild nehmen".

### Video und Overlay

- Skelett aus den erkannten 2D-Gelenken (grau) **und** die zurückprojizierte
  3D-Rekonstruktion (Lehm). Weichen beide voneinander ab, passt die
  Rekonstruktion nicht zum Bild — das ist die schnellste verfügbare Sichtprüfung
  und der Grund, beide gleichzeitig zu zeigen.
- Schlägerachse und Schlägerkopfbahn der letzten 0,4 Sekunden. Der Racket-Drop
  ist als Schleife hinter dem Rücken direkt sichtbar.
- Ball, wo er detektiert wurde.
- Ausschnitt auf die Bewegung beschnitten, nicht auf den vollen Sensor.
- Zeitlupe (0,1× / 0,25× / 0,5× / 1×), Einzelbildschritt, Pfeiltasten,
  Leertaste, Zeitleiste.
- Phasenmarker als anklickbare Bänder; die Deckkraft codiert die Sicherheit der
  jeweiligen Phasengrenze.
- Statuszeile mit Bildnummer, Zeit, **Abstand zum Treffpunkt in Millisekunden**,
  aktueller Phase mit Confidence und Treffpunkt-Confidence.

### 3D-Ansicht

Frei drehbare orthographische Darstellung der rekonstruierten Positionen im
Platzsystem, mit Bodenraster und Voreinstellungen (seitlich, von hinten, von
oben). Sie zeigt ausdrücklich **nicht** das Videobild — sie zeigt, was das System
zu sehen glaubt.

### Kennzahlen

Tabelle mit Wert ± Streuung, 95-%-Intervall, Confidence in Prozent und Band,
Beobachtbarkeitsklasse und Referenzabweichung mit z-Wert und Kohortenhinweisen.
Verworfene Messungen bleiben sichtbar, durchgestrichen, mit Grund.

Darunter „Nicht messbar" — Größen, die bewusst nicht geschätzt werden, jeweils
mit Begründung. Eine fehlende Zahl mit Grund ist für einen Trainer brauchbar;
eine stillschweigend weggelassene ist es nicht.

### Befunde

Jeder Befund in der geforderten Struktur:

> **Beobachtung** Das Becken steigt zwischen tiefster Ladung und Treffpunkt nur 4 cm (± 3 cm).
> **Interpretation** Der Beinantrieb ist der Anfang der Kette und der einzige Punkt, an dem gegen den Boden gearbeitet werden kann.
> **Konsequenz** Ohne vertikalen Antrieb sinkt der Treffpunkt, und der Aufschlag muss flacher gespielt werden — das kostet Sicherheitsmarge über dem Netz.
> **Empfehlung** Beinantrieb isoliert aufbauen: Ladephase halten, dann Absprung auf eine markierte Landeposition. Zunächst ohne Ball, dann mit reduziertem Tempo.
> **Sicherheit** 85 % · hoch

Sortiert nach erwartetem Nutzen — Confidence mal Effektgröße mal Trainierbarkeit —,
nicht nach Abweichungsgröße.

Empfehlungen sind als Hypothesen formuliert. Bei niedriger Confidence lautet die
Empfehlung ausdrücklich, die Messung erst zu bestätigen:

> Vor einer Trainingsempfehlung sollte eine Aufnahme mit besserer Perspektive
> oder höherer Bildrate bestätigen, dass das Muster reproduzierbar ist.

### Trainerentscheidung

Zu jedem Befund: **Übernehmen · Verwerfen · Beobachten**, dazu ein Kommentarfeld.
Die Entscheidung bleibt lokal im Browser.

Der Trainer entscheidet, nicht das System. Ein wiederholt verworfener Befund ist
selbst eine Information — entweder über den Spieler oder über das System.

### Verlauf

Eigenvergleich gegen frühere Sitzungen: Mittelwert und Streuung der Historie,
aktueller Wert, Veränderung und die Angabe, ob die Veränderung belastbar ist.
Belastbar heißt: über dem Messrauschen **und** über einer trainingsrelevanten
Mindestgröße.

### Vergleich

Zwei Aufnahmen nebeneinander, **synchronisiert nach Bewegungsphase, nicht nach
Zeit**. Zeitliche Synchronisierung vergleicht die Ladephase des einen mit der
Beschleunigung des anderen und lässt jeden Unterschied riesig aussehen.

Fehlt eine Phase in einer der beiden Aufnahmen, wird der Vergleich für diese
Phase nicht angeboten. Kenngrößen werden nur dann als Differenz gezeigt, wenn
beide Einzelmessungen für sich tragfähig sind.

### Diagnose-Pipeline

Der vollständige Layer-Trail mit Status, Güte, Anmerkungen und Diagnosewerten.
Siehe [07](07-plausibilitaet.md).

## Gestaltungshaltung

Die Anwendung soll sich nicht wie ein KI-Chatbot anfühlen, sondern wie ein
Analysewerkzeug. Konkret:

- **Keine Zahl ohne Unsicherheit.** Eine Confidence steht immer daneben.
- **Keine leere Fläche ohne Grund.** Wo nichts steht, steht warum.
- **Farbe codiert Sicherheit, nicht Bewertung.** Jade/Stroh/Rose stehen für
  hoch/mittel/niedrig sicher, nicht für gut/mittel/schlecht.
- **Monospace für Zahlen**, tabellarische Ziffern, damit Spalten vergleichbar
  bleiben.
- **Der Trainer kann jederzeit bis zum Rohsignal durchklicken.**
