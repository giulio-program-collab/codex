# 01 · Bestandsanalyse: warum das bestehende System falsche Ergebnisse erzeugt

## Was das Tool heute tut

Aus dem ausgelieferten Bundle rekonstruiert:

1. Der Trainer wählt eine Videodatei, gibt Aufnahme- und Wiedergabebildrate an
   und wählt die Schlagart.
2. Er kalibriert den Maßstab, indem er zwei Punkte anklickt — Kopf und Füße des
   stehenden Spielers. Daraus wird ein einzelner Faktor `pxPerCm` gebildet.
3. Er markiert zwei Schlüsselbilder (Trophy-Position, Ballkontakt) und klickt
   darauf je fünf bis sechs Gelenkpunkte.
4. Die App berechnet vier Winkel **in der Bildebene** und vergleicht jeden mit
   einer publizierten Mittelwert-/Streuungsangabe.
5. Aus den vier Einzelwerten wird ein ungewichteter Mittelwert gebildet: die
   „Ähnlichkeit" von 0 bis 10.

Die Ähnlichkeitsfunktion, verbatim aus dem Bundle:

```js
P3 = (value, mean, sd) => {
  const z = (value - mean) / sd;
  return { z, score: Math.max(0, Math.min(10, 10 * Math.exp(-(z * z) / 8))) };
};
```

Die Referenzwerte, ebenfalls verbatim:

| Kenngröße                    | Mittel | SD    | Quelle im Tool                                                 |
| ---------------------------- | ------ | ----- | -------------------------------------------------------------- |
| Rumpfneigung (Trophy)        | 25,0°  | 7,1°  | Frontiers in Sports and Active Living (2024), ISB-normalisiert |
| Vordere Knieflexion (Trophy) | 64,5°  | 9,7°  | dieselbe Metaanalyse                                           |
| Schulterelevation (Kontakt)  | 110,7° | 16,9° | dieselbe Metaanalyse                                           |
| Ellbogenflexion (Kontakt)    | 30,1°  | 15,9° | dieselbe Metaanalyse                                           |

Das Tool benennt seine Methode selbst korrekt: „2D-Videodigitalisierung … keine
automatische Erkennung". Der Fehler liegt nicht in dem, was es verschweigt,
sondern in dem, was es aus 2D-Winkeln ableitet.

## Der Nachweis

`engine/test/legacy-comparison.test.ts` implementiert genau dieses Verfahren und
füttert es mit dem **bestmöglichen Input, den es je bekommen könnte**: einem
Aufschlag, dessen 3D-Gelenkpositionen exakt bekannt sind, mit fehlerfrei
angeklickten Punkten, auf exakt den richtigen Schlüsselbildern. Jeder verbleibende
Fehler ist damit dem Verfahren zuzurechnen, nicht dem Nutzer.

### Weltklasse-Aufschlag (Wahrheit: Knieflexion 66°, Ellbogenflexion 17°)

| Kamera          | Rumpfneigung | Knieflexion   | Schulterelevation | Ellbogenflexion | Gesamt  |
| --------------- | ------------ | ------------- | ----------------- | --------------- | ------- |
| seitlich        | 25° (10,0)   | **19°** (0,6) | 170° (2,2)        | 1° (6,6)        | **4,8** |
| diagonal        | 21° (9,6)    | 56° (9,1)     | 176° (1,6)        | 11° (8,4)       | 7,2     |
| von hinten      | 9° (5,1)     | 66° (10,0)    | 166° (2,7)        | 17° (9,1)       | 6,7     |
| von vorn        | 4° (3,5)     | 66° (10,0)    | 165° (2,7)        | 17° (9,1)       | 6,3     |
| erhöht seitlich | 26° (10,0)   | **21°** (0,8) | 170° (2,2)        | 0° (6,4)        | **4,8** |

### Schwacher Nachwuchsaufschlag (Wahrheit: Knieflexion 28°, umgekehrte Sequenz)

| Kamera          | Gesamt |
| --------------- | ------ |
| seitlich        | 4,3    |
| diagonal        | 3,8    |
| von hinten      | 4,8    |
| von vorn        | 4,9    |
| erhöht seitlich | 4,0    |

## Die fünf Ursachen

### 1. Projizierte Winkel sind nicht die Winkel, gegen die verglichen wird

Die Referenzwerte stammen aus Mehrkamera-Markersystemen und beschreiben
anatomische Winkel im Körperkoordinatensystem. Das Tool misst den Winkel
zwischen drei Bildpunkten. Diese beiden Größen stimmen nur überein, wenn die
gesamte Gliederkette parallel zur Bildebene liegt — was bei einem Aufschlag
grundsätzlich nicht der Fall ist, weil die Bewegung rotatorisch ist.

Die Knieflexion des Weltklasse-Aufschlags beträgt tatsächlich 66°. Aus der
Seitenperspektive misst das Tool 19°, aus der Rückperspektive 66°. Derselbe
Moment, dieselbe Person, **47° Unterschied allein durch den Kamerastandort**.
Der Referenz-SD beträgt 9,7° — der Perspektivfehler ist also fast das Fünffache
der Streuung, gegen die er gescort wird.

### 2. Eine Konventionsverwechslung erzeugt einen konstanten Abzug

Die Schulterelevation wird in allen fünf Perspektiven mit 152° bis 176° gemessen,
verglichen gegen einen Mittelwert von 110,7°. Das ergibt durchgehend z ≈ 3 bis 4
und damit 1,6 bis 4,7 von 10 Punkten — **für jeden Aufschlag, unabhängig von der
Technik**.

Das ist keine Messung, sondern ein Fixabzug. Die publizierten 110,7° beziehen
sich mit hoher Wahrscheinlichkeit auf eine andere Konvention (Abduktion in der
Thoraxebene statt Winkel zwischen Rumpfachse und Humerus). Eine Referenz, deren
Messkonvention nicht bestätigt ist, darf nicht in eine Bewertung eingehen.

### 3. `pxPerCm` ist ein einziger Faktor für eine perspektivische Szene

Der Maßstab wird an der stehenden Person gemessen und danach auf alle Distanzen
angewandt — auch auf den Treffpunkt, der 1,5 m höher und typischerweise 1 bis 2 m
näher oder weiter von der Kamera entfernt liegt. Bei üblichen Filmabständen sind
das 5 bis 15 % Skalenfehler, still angewandt auf jede ausgegebene Länge.

Physikalisch korrekt ist der Maßstab keine Konstante, sondern eine Funktion der
Tiefe: `m/px = Tiefe / Brennweite`.

### 4. Der Gesamtwert ist ein ungewichteter Mittelwert über zufällig verfügbare Größen

```js
one = (e) => {
  const t = e.filter((r) => r.sim).map((r) => r.sim.score);
  return t.length ? t.reduce((r, n) => r + n, 0) / t.length : null;
};
```

Vier Größen, gleiches Gewicht, keine Rückfrage, ob sie überhaupt unterscheidbar
gemessen wurden. Zwei davon (Schulterelevation, Rumpfneigung) sind fast reine
Perspektivartefakte; sie bestimmen die Hälfte des Ergebnisses.

### 5. Es gibt keine Unsicherheit — und damit keine Möglichkeit zu schweigen

Es existiert kein Confidence-Begriff, keine Schwelle, unterhalb derer keine
Aussage erzeugt wird, und keine Prüfung, ob das Ergebnis zum erwartbaren
Leistungsprofil passt. Ein Wert entsteht immer. Damit hat das System keinen
Mechanismus, mit dem der Sinner-Fall überhaupt auffallen könnte.

## Die entscheidende Konsequenz

Aus der Seitenperspektive — der von der Biomechanikliteratur empfohlenen und
vom Trainer am häufigsten gewählten — erhält der Weltklasse-Aufschlag **4,8** und
der technisch schwache Nachwuchsaufschlag **4,3**. Ein halber Punkt trennt sie.

Das Werkzeug misst überwiegend die Kameraposition, nicht die Technik. Solange
das so ist, ist jede Verbesserung der Formulierung, der Referenzdatenbank oder
der Oberfläche wirkungslos.

## Was übernommen werden kann

Nicht alles am bestehenden System ist falsch. Weiterverwendbar sind:

- **Die Bildraten-Sperre.** Das Tool verweigert Zeitmessungen unter 60 fps und
  begründet das mit einer Trefferquote von 61 % bei 30 fps. Diese Logik ist
  korrekt und ist in `l01-ingest.ts` übernommen.
- **Der Verzicht auf absolute Beträge bei Junioren.** „Kein 13-Jähriger soll an
  ATP-Schlägergeschwindigkeit gemessen werden" ist die richtige Haltung und wird
  im Referenz-Layer als Kohortenanpassung formalisiert.
- **Der Objektivitätsgrad.** Der Anteil der Bewertungsgrundlage, der auf
  gemessenen statt geschätzten Daten beruht, ist ein gutes Konzept und wird als
  Analysequalität weitergeführt.
- **Die Referenzquellen selbst.** Die zitierten Studien sind einschlägig. Was
  fehlt, ist die Angabe der Messkonvention je Referenz — ohne sie darf keine
  Bewertung entstehen.
- **Die gesamte Oberfläche außerhalb der Videoanalyse** (Matches, Tests,
  Trainingsdokumentation, Entwicklungsschwerpunkte) ist von diesem Befund nicht
  berührt.

## Was ersetzt werden muss

| Komponente                               | Status     | Ersatz                                                       |
| ---------------------------------------- | ---------- | ------------------------------------------------------------ |
| Manuelles Klicken von Gelenkpunkten      | ersetzen   | Automatische Pose-Estimation mit Confidence je Gelenk (L4)   |
| `pxPerCm`-Kalibrierung                   | ersetzen   | Vollständiges Kameramodell, Maßstab je Tiefe (L2)            |
| 2D-Winkel als biomechanische Messwerte   | ersetzen   | 3D-Rekonstruktion mit Kovarianz (L6)                         |
| Referenzvergleich ohne Konventionsangabe | ersetzen   | Referenzen mit Konvention, Kohorte und Wirkmechanismus (L11) |
| Ungewichteter Mittelwert als Gesamtnote  | ersetzen   | Transparente Komponenten mit Gate und Confidence (L12/L13)   |
| Bildraten-Sperre                         | übernehmen | unverändert (L1)                                             |
| Kohortenbewusstsein bei Junioren         | übernehmen | formalisiert (L11)                                           |
