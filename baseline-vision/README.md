# Baseline Vision

Eine Neuentwicklung der Videoanalyse in **Baseline Pro** — von einem manuellen
2D-Digitalisierungswerkzeug zu einer Messkette, die zuerst misst und erst danach
bewertet.

## Warum

Die ausgelieferte Videoanalyse bewertet einen Weltklasse-Aufschlag als
mittelmäßig. Das ist kein Formulierungsproblem, sondern ein Messproblem: Sie
vergleicht Winkel, die in der Bildebene abgelesen wurden, mit Mittelwerten aus
Mehrkamera-Laborkinematik. Das sind verschiedene Größen.

`engine/test/legacy-comparison.test.ts` rechnet das Verfahren des bestehenden
Tools nach — unter Idealbedingungen, mit exakt bekannten Gelenkpositionen und
perfekt getroffenen Schlüsselbildern:

| Kamera          | Gesamt (Weltklasse) | Gesamt (schwacher Nachwuchs) |
| --------------- | ------------------- | ---------------------------- |
| seitlich        | **4,8 / 10**        | 4,3 / 10                     |
| diagonal        | 7,2 / 10            | 3,8 / 10                     |
| von hinten      | 6,7 / 10            | 4,8 / 10                     |
| von vorn        | 6,3 / 10            | 4,9 / 10                     |
| erhöht seitlich | **4,8 / 10**        | 4,0 / 10                     |

Zwei Befunde, beide unabhängig vom Nutzer:

1. Derselbe Schlag erhält je nach Kameraposition 4,8 bis 7,2 von 10.
2. Ein Weltklasse-Aufschlag und ein technisch schwacher Nachwuchsaufschlag sind
   im Ergebnis nicht auseinanderzuhalten.

Details in [`docs/01-bestandsanalyse.md`](docs/01-bestandsanalyse.md).

## Was hier liegt

```
engine/       Die Messkette: 14 Layer, jeder einzeln testbar
  src/core/     Geometrie, Kameramodell, Unsicherheitsrechnung, Typen
  src/layers/   L1 Ingest … L14 Report
  src/fixtures/ Parametrisches 3D-Aufschlagmodell + virtuelle Kamera (Ground Truth)
  test/         60 Tests: Acceptance, Validierung, Layer-Unit-Tests, Legacy-Vergleich
  tools/        Baut das Dashboard aus echtem Pipeline-Output
dashboard/    Trainer-Oberfläche, eine eigenständige HTML-Datei
docs/         Analyse, Architektur, Konzepte, Validierung, Plan, Risiken
```

## Ausführen

Node 22 oder neuer, keine Abhängigkeiten.

```bash
cd engine
node --experimental-strip-types --test "test/*.test.ts"   # Testsuite
node --experimental-strip-types tools/build-demo.ts       # Dashboard bauen
```

Danach `dashboard/index.html` im Browser öffnen. Die Datei ist eigenständig —
kein Server, kein Netz.

## Das Grundprinzip

> Lieber „Ich weiß es nicht sicher" als „Der Aufschlag ist 63/100".

Jede abgeleitete Größe ist ein `Measure`: ein Wert, eine 1-Sigma-Unsicherheit
aus Monte-Carlo-Fortpflanzung über die Kovarianz der Rekonstruktion, eine
Vertrauensbewertung und eine **Beobachtbarkeitsklasse**, die festhält, ob die
Kamera diese Größe überhaupt sehen konnte. Bewertet wird erst, wenn das
Qualitäts-Gate es zulässt, und eine Plausibilitätsprüfung kann ein Urteil wieder
zurückziehen, das seinen eigenen Belegen widerspricht.

## Dokumentation

| Dokument                                                   | Inhalt                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| [01 Bestandsanalyse](docs/01-bestandsanalyse.md)           | Warum das bestehende System falsche Ergebnisse erzeugt |
| [02 Architektur](docs/02-architektur.md)                   | Die 14 Layer, Datenfluss, Schnittstellen               |
| [03 Modellauswahl](docs/03-modellauswahl.md)               | Welche CV-Modelle, mit Begründung                      |
| [04 3D-Konzept](docs/04-3d-konzept.md)                     | Rekonstruktion, Mehrdeutigkeiten, Vertikale            |
| [05 Feature-Set](docs/05-feature-set.md)                   | Biomechanische Kenngrößen und ihre Grenzen             |
| [06 Confidence](docs/06-confidence.md)                     | Unsicherheits- und Vertrauenssystem                    |
| [07 Plausibilität](docs/07-plausibilitaet.md)              | Fehlerdiagnose und Selbstprüfung                       |
| [08 Dashboard](docs/08-dashboard.md)                       | Trainer-Oberfläche                                     |
| [09 Validierung](docs/09-validierung.md)                   | Teststrategie und gemessene Genauigkeit                |
| [10 Implementierungsplan](docs/10-implementierungsplan.md) | Reihenfolge, Aufwand, Priorisierung                    |
| [11 Risiken und Grenzen](docs/11-risiken.md)               | Was das System nicht kann und nie können wird          |
