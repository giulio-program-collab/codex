# MOTUS

**Bewegung, in Zahlen.**

Ein Video hineinziehen, und MOTUS sagt, wie sich der Körper darin bewegt hat:
Gelenkwinkel über die Zeit, Wiederholungen, Spannweiten, und wo man den Zahlen
nicht trauen sollte. Es läuft vollständig im Browser — das Video verlässt das
Gerät nicht, weil es nirgendwohin geschickt wird.

MOTUS weiß nicht, welche Sportart es sieht, und braucht es nicht zu wissen.
Kniebeugen, Bizepscurls, Aufschläge, Sprünge, Reha-Übungen: Was es misst, sind
Winkel und Wiederholungen, und die gibt es überall.

## Ausprobieren

```bash
npm run serve      # → http://localhost:8100/
```

Oder ohne alles: `node build.mjs` baut `motus.html`, eine einzige Datei von
10 MB, in der Modell, Programm und WebAssembly stecken. Die lässt sich
doppelklicken — kein Server, kein Internet, keine Installation.

```bash
npm test           # 27 Tests für die Rechenschritte
```

---

## Wie es funktioniert

Sechs Schritte, jeder in einer eigenen Datei. Die Nummern im Ordner `src/` sind
die Reihenfolge; wer den Code liest, liest ihn in derselben Reihenfolge, in der
die Daten durchlaufen.

### Schritt 1 · Video → Einzelbilder `src/01-frames.js`

Der bequeme Weg wäre, das Video abzuspielen und im Vorbeigehen Bilder
abzugreifen. Das geht gut, solange die Analyse schneller läuft als das Video —
und ein Pose-Modell braucht pro Bild gern 30 Millisekunden. Sobald es klemmt,
überspringt der Browser Bilder, ohne das zu melden. Die Auswertung hat dann
Löcher an genau den Stellen, an denen am meisten passiert ist, weil dort am
meisten zu rechnen war. Beim zweiten Durchlauf sind es andere Löcher.

MOTUS spult stattdessen: Zeitpunkt setzen, warten, bis der Browser dort ist,
Bild lesen. Langsamer, aber es überspringt nichts, und zweimal dieselbe Datei
ergibt zweimal dasselbe Ergebnis.

Vorher wird gemessen, wie schnell das Video **wirklich** ist. „60 fps" in den
Metadaten heißt nicht, dass 60 verschiedene Bilder pro Sekunde drin sind:
Bildschirmaufnahmen und viele Handy-Exporte wiederholen Bilder. Gemessen wird
über die tatsächlichen Bildwechsel, und genommen wird nicht deren Mittelwert,
sondern ein niedriges Perzentil — ausgelassene Bilder machen einzelne Abstände
doppelt so groß und würden einen Mittelwert nach unten ziehen.

### Schritt 2 · Bild → 33 Körperpunkte `src/02-pose.js`

Das einzige gelernte Modell der Kette: Googles PoseLandmarker. Es liefert die
Punkte doppelt, und der Unterschied ist der wichtigste in diesem Programm.

| | was es ist | wofür |
| --- | --- | --- |
| `landmarks` | Position **im Bild**, als Anteil von Breite und Höhe | das Skelett über das Video zeichnen |
| `worldLandmarks` | Position **im Raum**, in Metern, relativ zur Hüftmitte | Winkel rechnen |

Nur die zweite Sorte taugt zum Messen. Warum, steht in Schritt 4.

### Schritt 3 · Aufräumen `src/03-clean.js`

Ein Pose-Modell liefert in jedem Bild eine Schätzung, auch dann, wenn es nichts
Vernünftiges sieht. Ein verdecktes Knie bekommt trotzdem eine Koordinate, und
die springt von Bild zu Bild um eine halbe Beinlänge.

1. Punkte mit zu geringer Sichtbarkeit werden zu Lücken erklärt.
2. Ausreißer — ein Punkt, der sich schneller bewegt, als ein Körperteil kann —
   ebenfalls. Geprüft wird auf beiden Seiten: Ein echter schneller Durchgang ist
   auf einer Seite schnell, ein Sprung des Modells springt hin und sofort zurück.
3. Kurze Lücken (bis vier Bilder) werden linear überbrückt, lange bleiben Lücken.
   Am Anfang und am Ende wird gar nicht überbrückt — dort gibt es keine zwei
   Stützstellen, und raten hieße, sich etwas auszudenken.
4. Der Rest wird geglättet, mit **Savitzky-Golay** statt mit einem gleitenden
   Mittel.

Der letzte Punkt ist keine Geschmacksfrage. Ein gleitendes Mittel zieht
Extremwerte zur Mitte — und Extremwerte sind genau das, was hier gemessen wird.
Ein Boxfilter ließe jede Kniebeuge flacher aussehen, und zwar umso mehr, je
verrauschter das Video ist. Savitzky-Golay legt stattdessen in jedem Fenster
eine Parabel durch die Punkte; Krümmung überlebt das, Rauschen nicht. Zwei
Tests halten beide Hälften fest: dass die Verzerrung klein bleibt, und dass die
Dämpfung so stark ist, wie die Filtertheorie es zulässt — nicht stärker.

### Schritt 4 · Punkte → Gelenkwinkel `src/04-angles.js`

Hier biegen die meisten Werkzeuge falsch ab: Sie messen den Winkel **im Bild**.
Drei Punkte auf dem Bildschirm, Arcuskosinus, fertig. Das ist aber nicht der
Kniewinkel, sondern dessen Schatten an der Wand — und der hängt davon ab, wo die
Kamera stand.

Ein Knie, exakt 60° gebeugt, gemessen in der Projektion:

| Unterschenkel liegt … | im Raum | im Bild |
| --- | --- | --- |
| quer zur Kamera | 60° | 60° |
| zur Kamera hin gedreht | 60° | **0°** |

Dieselbe Beugung, dieselbe Person, ein anderer Kamerawinkel. Deshalb rechnet
MOTUS in den Weltkoordinaten aus Schritt 2 und nicht in den Bildkoordinaten.

Diese 3D-Schätzung hat eine bekannte Schwäche: Die Tiefe ist deutlich unsicherer
als die Bildebene. Also wird sie mitgeführt statt verschwiegen. Jeder Winkel
trägt zwei Begleitzahlen:

- **Sichtbarkeit** — wie sicher das Modell war, die Punkte überhaupt zu sehen.
- **Tiefenanteil** — wie stark das Gelenk auf die Kamera zu zeigt. Bei 0 liegt
  alles in der Bildebene; bei 1 steckt der ganze Winkel in der am schlechtesten
  bestimmten Richtung.

Beide werden getrennt geführt, weil sie verschiedene Dinge sind und verschieden
behoben werden: schlechte Sichtbarkeit durch mehr Licht, hoher Tiefenanteil
durch eine andere Kameraposition.

Gemessen werden Knie, Hüfte, Ellbogen und Schulter je Seite, dazu die
Rumpfneigung gegen die Senkrechte.

### Schritt 5 · Winkel → Wiederholungen `src/05-reps.js`

MOTUS bekommt nicht gesagt, was geübt wird, und zählt trotzdem. Wiederholungen
sind im Winkelverlauf genau das, was sie im Wortsinn sind: wiederkehrende
Ausschläge.

Gesucht wird über **Prominenz**, nicht über eine Schwelle. Eine Schwelle
(„zähle, wenn der Winkel unter 90° geht") scheitert an dem, was Menschen
tatsächlich tun: Die erste Kniebeuge geht auf 78°, die letzte nur noch auf 104°,
und die Zählung verliert die Hälfte. Prominenz fragt stattdessen: *Wie weit muss
man von diesem Gipfel absteigen, bevor man wieder höher hinaufkommt?* Ein echtes
Tal zwischen zwei Wiederholungen ist tief, egal auf welcher Höhe es liegt.

Dazu drei Schranken, ohne die sich das Verfahren selbst betrügt:

- Eine **relative** (ein Tal muss 35 % der Spannweite tief sein) — sie macht das
  Zählen unabhängig davon, wie groß die Bewegung ist.
- Zwei **absolute** (mindestens 15° Bewegung insgesamt, mindestens 8° je
  Ausschlag) — ohne sie erfüllt reines Zittern die 35 % brav, und aus Rauschen
  werden zwanzig „Wiederholungen". Ein Test hält das fest.
- Eine **zeitliche** (mindestens 0,35 s) — am Ende einer Aufnahme läuft die
  Person aus dem Bild, das Modell verliert sie, und die Winkel schlagen ein paar
  Bilder lang wild aus. Das sieht in der Kurve aus wie ein Ausschlag und ist
  einer — nur keiner des Körpers.

Die Richtung findet MOTUS selbst: Es probiert beide (Winkel wird kleiner /
größer) und nimmt die, die mehr saubere Wiederholungen ergibt.

### Schritt 6 · Bericht `src/06-report.js`

Vier Auskünfte, und eine fünfte, die keine Kennzahl ist.

1. **Was war die Bewegung?** Spannweite und Extremwerte je Gelenk.
2. **Wie oft, wie lange?** Wiederholungen mit Dauer und Tiefe. Die erste und die
   letzte können vom Videoschnitt abgeschnitten sein; sie werden gezeigt, zählen
   bei den Dauern aber nicht mit.
3. **Bleibt es gleich?** Streuung über die Wiederholungen — und ein Trend nur
   dann, wenn er einer ist. Durch drei Punkte lässt sich immer eine Gerade legen,
   und sie hat immer eine Steigung; bei drei Wiederholungen mit ±47° Streuung
   „−40° pro Wiederholung" zu melden, ist keine Beobachtung, sondern eine
   ausgerechnete Zufälligkeit. Geprüft wird die Steigung gegen ihren eigenen
   Standardfehler, und es müssen mindestens vier Wiederholungen sein.
4. **Ist links wie rechts?** Nur, wo beide Seiten ordentlich sichtbar waren —
   aus einer einzelnen Kamera ist eine Asymmetrie meistens Perspektive.
5. **Worauf man sich hier nicht verlassen sollte.** Lückenhafte Gelenke,
   perspektivisch heikle Winkel, schwach erkannte Punkte, abgerissene
   Verfolgung, zu niedrige Bildrate — jeweils mit der Abhilfe für die nächste
   Aufnahme.

Der schwierigste dieser Fälle ist die **abgerissene Verfolgung**: Die Person
läuft aus dem Bild, das Modell greift sich jemanden im Hintergrund, und Abdeckung
und Sichtbarkeit sehen dabei tadellos aus. Erkennen lässt sich das nur an der
Physik — ein Gelenk kann schnell sein, aber es kann nicht in einem Bild vor und
im nächsten zurück.

Und wenn alle Prüfungen bestehen, behauptet MOTUS nicht „alles in Ordnung",
sondern zählt auf, was geprüft wurde — und was nicht.

## Was MOTUS nicht tut

**Benoten.** Es gibt keine Punktzahl und keinen Vergleich mit einer
Referenzgruppe. Ob 92° Kniebeugung gut sind, hängt von der Übung, vom Körperbau
und von der Absicht ab. Das weiß der Mensch vor dem Bildschirm und nicht das
Programm.

## Damit es funktioniert

- **Eine Person im Bild**, mindestens halbe Bildhöhe hoch.
- **Seitlich oder schräg** filmen. Frontal ist die schlechteste Perspektive:
  Dann zeigt jedes Beugegelenk auf die Kamera zu.
- **Kamera still halten**, am besten auflegen oder aufstellen.
- **Ganze Person im Bild**, durchgehend, inklusive Füße.
- 30 fps reichen für Winkel; für Geschwindigkeiten sind 60 fps besser.

## Aufbau

```
src/01-frames.js    Video → Einzelbilder            Browser
src/02-pose.js      Bild → 33 Körperpunkte          Browser
src/03-clean.js     Aufräumen und Glätten           rein rechnerisch, getestet
src/04-angles.js    Punkte → Gelenkwinkel           rein rechnerisch, getestet
src/05-reps.js      Winkel → Wiederholungen         rein rechnerisch, getestet
src/06-report.js    alles → Bericht                 rein rechnerisch, getestet
src/ui-*.js         Skelett-Overlay und Diagramm
src/app.js          ruft die sechs Schritte auf, sonst nichts
build.mjs           packt alles in eine Datei
```

Die vier Rechenschritte sind reine Funktionen ohne Browser-Abhängigkeit — genau
deshalb lassen sie sich mit `npm test` gegen Bewegungen prüfen, deren Antwort
bekannt ist.

## Herkunft

Pose-Erkennung: [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
(Apache 2.0), Modell und Laufzeit liegen unter `vendor/` und werden nicht
nachgeladen.
