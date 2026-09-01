# Datenspezifikation: MOTUS als Bewegungsexperte

Diese Spezifikation beantwortet eine konkrete Frage — *wie viele Trainingsdaten,
in welcher Form* — für den Umbau von MOTUS von „misst und zählt" zu „urteilt
über Technik, sportartübergreifend". Sie ist als Auftrag an ein
Datenerhebungsteam geschrieben, nicht als Diskussionspapier: Schemata,
Stichprobenpläne und Abnahmekriterien sind so konkret gehalten, dass man morgen
mit der Erhebung anfangen könnte.

Was sie nicht ist: ein trainiertes Modell. Diese Umgebung hat keinen Zugriff auf
Sportvideo-Bestände, keine Kooperation mit Trainern oder Physiotherapeuten und
keine Möglichkeit, Personen zu filmen. Die Erhebung selbst muss von Menschen mit
genau diesem Zugang durchgeführt werden. Was hier entsteht, ist der Plan, den
sie brauchen.

## 0. Die Frage zerfällt in drei, mit sehr unterschiedlichem Datenbedarf

„Das Tool soll wissen, was die Winkel bedeuten" klingt nach einer Aufgabe. Es
sind drei, und sie kosten unterschiedlich viel:

| | Frage | Beispiel | Schwierigkeit |
|---|---|---|---|
| **A. Erkennung** | Welche Bewegung ist das? | „Das ist eine Kniebeuge, keine Kreuzheben-Wiederholung." | leicht — klassisches Muster­erkennungsproblem auf wenigen Zahlen |
| **B. Fehlerprüfung** | Liegt ein *benannter* technischer Mangel vor? | „Die Knie fallen beim Absenken nach innen (Valgus)." | mittel — braucht Fachurteil, aber pro Fehler eng umrissen |
| **C. Gesamturteil** | Wie gut ist die Ausführung insgesamt? | „7 von 10." | am teuersten — und genau das Format, an dem das alte Tennis-Werkzeug in diesem Projekt gescheitert ist |

Abschnitt 5 begründet, warum diese Spezifikation **A und B** vorsieht und **C
bewusst ausklammert**. Die kurze Fassung: eine einzelne Zahl ist keine
Kenngröße, sie ist eine Behauptung, und das Projekt existiert, weil diese
Behauptung beim Sinner-Aufschlag falsch war.

## 1. Warum nicht auf dem Rohvideo trainiert wird

Der naheliegende Ansatz — Video rein, Modell lernt Technikfehler direkt aus den
Pixeln — würde die Bildverarbeitung, die MediaPipe bereits gelöst hat, ein
zweites Mal lösen wollen, und dafür wirklich Hunderttausende Videos brauchen.

MOTUS hat diese Arbeit schon getan. `buildReport()` in `src/06-report.js`
verdichtet ein Video auf eine handhabbare Zahl benannter, physikalisch
verankerter Werte:

```
472 Bilder × 33 Landmarken × 4 Zahlen   (Schritt 2, roh)
   ↓
289 Bilder × 9 Gelenkwinkel             (Schritt 4, nach Bereinigung)
   ↓
9 Gelenke × (min, max, Spannweite, …)   (Schritt 6, der Bericht)
```

Trainiert wird auf der letzten Stufe: pro Wiederholung ein Vektor aus rund 30
Zahlen (die Werte je Gelenk, siehe Abschnitt 2), dazu der Aufnahmekontext
(Sichtbarkeit, Tiefenanteil, Bildrate). Das ist ein tabellarisches Problem, für
das Gradient-Boosting-Bäume oder eine kleine logistische Regression die
richtigen Werkzeuge sind — kein tiefes Netz, kein Bild-Encoder. Das senkt den
Datenbedarf um Größenordnungen gegenüber einem Modell, das bei Pixeln anfängt.

## 2. Die Form eines Trainingsbeispiels

Ein Beispiel ist **eine Wiederholung**, nicht ein Video — ein Satz Kniebeugen
liefert zehn Beispiele, keins. Format: eine Zeile JSONL pro Wiederholung.

```jsonc
{
  "schemaVersion": 1,
  "exampleId": "sq-0417-r03",

  // -------- Herkunft: wer, womit, wie aufgenommen --------------------
  "provenance": {
    "subjectId": "S-0417",            // pseudonymisiert, siehe Abschnitt 6
    "sessionId": "S-0417-2026-03-02",
    "movementLabel": "back_squat",    // aus der Taxonomie, Abschnitt 3
    "skillLevel": "intermediate",     // novice | intermediate | advanced | elite
    "bodyBuild": "average",           // grobe Kategorie, s. Abschnitt 4 — keine Maße
    "cameraAngle": "side_45",         // front | side | side_45 | behind | above
    "cameraDistanceM": 3.2,
    "fps": 60,
    "resolution": "1080p",
    "equipmentVisible": ["barbell"],
    "clothingContrast": "high"        // ob Kleidung sich vom Untergrund abhebt
  },

  // -------- Eingabe: was MOTUS aus dem Video berechnet hat -----------
  // Direkt der `joints`-Teil aus buildReport(), eine Wiederholung
  // herausgeschnitten (extremesIn + der zugehörige perRep-Eintrag).
  "features": {
    "repIndex": 3,
    "truncated": false,
    "durationS": 0.83,
    "joints": {
      "kneeL":  { "min": 79.2, "max": 176.4, "range": 97.2,
                  "coverage": 0.97, "meanConfidence": 0.94,
                  "depthShare": 0.31, "jitter": 0.0, "reliable": true },
      "kneeR":  { "min": 81.0, "max": 177.1, "range": 96.1,
                  "coverage": 0.95, "meanConfidence": 0.92,
                  "depthShare": 0.29, "jitter": 0.0, "reliable": true }
      // … die übrigen 7 Gelenke aus LM in 04-angles.js, identisches Feldschema
    },
    "symmetry": [
      { "label": "Knie", "difference": -1.8, "perspectiveSuspect": false }
    ]
  },

  // -------- Label: das Fachurteil -------------------------------------
  "labels": {
    "movementConfirmed": "back_squat",   // Frage A: hat der Fachmensch bestätigt?
    "faults": [                          // Frage B: eine Zeile je geprüftem Fehler
      {
        "faultId": "knee_valgus",
        "present": true,
        "severity": "moderate",          // none | mild | moderate | severe
        "onRepetitions": [3, 4, 7],       // falls nicht jede Wiederholung betroffen
        "raterConfidence": "certain"      // certain | probable | unsure
      },
      {
        "faultId": "insufficient_depth",
        "present": false,
        "severity": "none",
        "raterConfidence": "certain"
      }
    ]
  },

  // -------- Wer geurteilt hat, und wie einig -------------------------
  "rating": {
    "raterIds": ["R-02", "R-07"],
    "raterQualification": ["cert_strength_coach_5y", "physio_msc"],
    "agreement": "unanimous",           // unanimous | majority | split
    "adjudicated": false,               // ob ein dritter Rater entscheiden musste
    "labeledAt": "2026-03-04"
  }
}
```

Wichtig an diesem Schema: **Herkunft, Eingabe und Label sind getrennte
Blöcke.** Das ist keine Formsache — Abschnitt 4 zeigt, warum ein Modell ohne
die `provenance`-Felder unweigerlich die Kameraperspektive statt der Technik
lernt.

## 3. Fehlertaxonomie — pro Bewegungsmuster, nicht pro Sportart

„Sportartübergreifend" heißt nicht ein Modell für alle Sportarten. Es heißt:
dieselbe Infrastruktur (Schema, Erhebung, Abnahme) für jedes **Bewegungsmuster**,
von denen es weit weniger gibt als Sportarten. Eine Kniebeuge im Krafttraining,
eine Landung nach einem Sprung und die Ladephase eines Aufschlags sind
unterschiedliche Bewegungen — aber der tiefe Kniebeuge-Griff im Basketball und
die Kniebeuge im Fitnessstudio sind, biomechanisch, dieselbe Bewegung mit
demselben Fehlerkatalog.

Startkatalog, geordnet nach dem, was MOTUS heute schon misst (kniedominant,
hüftdominant, Wurf-/Schlagbewegung, Rumpfrotation):

| Bewegungsmuster | Typische Fehler (Startliste) | Aus MOTUS-Gelenken ableitbar |
|---|---|---|
| Kniebeuge-artig | `knee_valgus`, `insufficient_depth`, `forward_lean_excessive`, `heel_rise` | kneeL/R, hipL/R, trunkLean |
| Hüftdominant (Kreuzheben, Rumpfbeuge) | `lumbar_rounding`, `hip_hinge_insufficient`, `knee_lock_early` | hipL/R, trunkLean, kneeL/R |
| Überkopf-Wurf/Schlag | `shallow_load`, `no_leg_drive`, `sequence_reversed`, `early_arm_extension` | shoulderL/R, elbowL/R, kneeL/R, trunkLean |
| Sprung/Landung | `stiff_landing`, `asymmetric_landing`, `valgus_on_landing` | kneeL/R, hipL/R, Seitenvergleich |

Die ersten drei Zeilen ihrer letzten Spalte sind wörtlich `MECHANICAL_RULES` aus
`baseline-vision/engine/src/layers/l13-interpretation.ts` — dort schon als
Schwelle/Richtung/Deutung/Konsequenz/Empfehlung kodiert. Diese Spezifikation
sammelt die Daten, um zu **prüfen und zu erweitern**, was dort bereits von
Sportwissenschaft abgeleitet, nicht gelernt, feststeht — siehe Abschnitt 5 für
die Arbeitsteilung zwischen den beiden Wegen.

## 4. Warum Stichprobenvielfalt wichtiger ist als Stichprobengröße

Der teuerste Fehler in einer Erhebung dieser Art passiert nicht beim Labeln,
sondern bei der Auswahl der Aufnahmen. Zwei Effekte, beide belegt und beide
tödlich für Verlässlichkeit:

**Perspektiven-Confounding.** Wenn alle Aufnahmen einer Kniebeuge mit
Valgus-Fehler zufällig aus derselben Kameraperspektive stammen (weil ein
einzelnes Studio das Material geliefert hat), lernt das Modell „diese
Kameraperspektive bedeutet Valgus" statt „diese Kniebewegung bedeutet Valgus".
MOTUS selbst dokumentiert genau dieses Risiko: `depthShare` und
`perspectiveSuspect` im Bericht existieren, weil eine Asymmetrie aus einer
einzelnen Kamera meistens Perspektive ist, nicht Körper. Ein Trainingssatz, der
diese Vermischung nicht durch Design ausschließt, vererbt sie an das Modell —
nur dass das Modell sie dann mit einer Zahl kaschiert, die nach Objektivität
aussieht. Das ist der exakte Rückfall in den Fehler, den dieses Projekt beheben
sollte.

**Personen-Clustering.** Zehntausend Wiederholungen von zwanzig Personen sind
eine viel schwächere Stichprobe als zweitausend Wiederholungen von zweihundert
Personen. Wiederholungen derselben Person in derselben Sitzung sind stark
korreliert — sie teilen Körperbau, Beweglichkeit, Tagesform, Kleidung,
Kameraaufbau. Was zählt, ist die Zahl der **unabhängigen Sitzungen**, nicht die
Zahl der Wiederholungen.

Daraus folgt die Stichprobenmatrix — Mindestbesetzung pro Zelle, bevor eine
Zelle als „abgedeckt" gilt:

| Dimension | Kategorien | Mindestbesetzung je Zelle |
|---|---|---|
| Kameraperspektive | front, side, side_45, behind, above | ≥ 15 Sitzungen |
| Erfahrungsstufe | novice, intermediate, advanced, elite | ≥ 15 Sitzungen |
| Körperbau (grob) | schlank, durchschnittlich, kräftig | ≥ 15 Sitzungen |
| Kleidungskontrast | hoch, niedrig | ≥ 10 Sitzungen |

Für ein Bewegungsmuster mit vier Fehlertypen und dieser Matrix sind das keine
zwei Dutzend Videos. Realistisch: **150–250 unabhängige Sitzungen pro
Bewegungsmuster**, von mindestens 60–80 verschiedenen Personen, verteilt über
die Zellen oben. Bei durchschnittlich 8 Wiederholungen pro Sitzung sind das
1.200–2.000 gelabelte Wiederholungen pro Bewegungsmuster — nicht pro Fehler,
weil eine Sitzung gleichzeitig auf alle vier Fehler geprüft wird.

## 5. Wie viele Wiederholungen, konkret — nach Aufgabe

| Aufgabe | Form des Labels | Größenordnung | Begründung |
|---|---|---|---|
| **A. Bewegungserkennung** | ein Kategorie-Label pro Wiederholung, vom Aufnehmenden vergeben (kein Fachurteil nötig) | 300–600 Wiederholungen je Bewegungsmuster, ≥ 20 Personen | reines Muster­erkennungsproblem auf ~30 Zahlen; klassische Verfahren (Gradient Boosting) sättigen früh |
| **B. Fehlerprüfung, je Fehlertyp** | binär oder Schweregrad, von ≥ 2 unabhängigen Fachleuten | 300–500 Positiv- **und** 300–500 Negativbeispiele je Fehler, aus der Matrix in Abschnitt 4 | Klassengleichgewicht nötig — Technikfehler sind in echten Aufnahmen selten, ohne gezielte Erhebung sammelt man vor allem Negativbeispiele |
| **C. Gesamturteil** | — | **wird hier nicht spezifiziert** | siehe unten |

Für den Startkatalog aus Abschnitt 3 (4 Bewegungsmuster × ~4 Fehler) ergibt das
in der Summe rund **6.000–9.000 gelabelte Wiederholungen**, aus schätzungsweise
**300–400 unabhängigen Aufnahmesitzungen**. Das ist eine mehrmonatige Erhebung
mit echten Fachleuten, keine Wochenendaktion — und es ist die ehrliche
Größenordnung, nicht die bequeme.

**Zu C, dem Gesamturteil:** Diese Spezifikation sieht bewusst keine Erhebung für
eine einzelne Qualitätszahl vor. Der Grund ist nicht Datenmangel, sondern
Bedeutungsmangel: „Gut" hängt von Übungsziel, Körperbau und Trainingsphase ab
und ist zwischen zwei Fachleuten oft ähnlich uneinig wie zwischen einem
Fachmenschen und einem Laien. Ein Modell, das diese Uneinigkeit zu einer Zahl
zwischen 0 und 100 verdichtet, verkauft genau die falsche Präzision, an der das
alte Tennis-Werkzeug in diesem Projekt gescheitert ist. Wenn eine
Gesamteinschätzung gewünscht ist, ist sie eine **Zusammenfassung der
Einzelbefunde aus B**, nicht ein eigenes Trainingsziel — konsistent mit
`composeScore()` in der Tennis-Engine, die eine Gesamtnote nur veröffentlicht,
wenn genug Einzelvergleiche sie tragen, und sonst verweigert.

## 6. Labelprotokoll

1. **Mindestens zwei unabhängige Fachleute** pro Wiederholung, dritter bei
   Uneinigkeit (`agreement: "split"` im Schema löst automatisch eine dritte
   Bewertung aus).
2. **Kalibrierungsrunde vor der eigentlichen Erhebung:** alle Rater bewerten
   dieselben 30 Wiederholungen unabhängig; Unstimmigkeiten werden gemeinsam
   besprochen, bevor die Haupterhebung beginnt.
3. **Übereinstimmung messen, nicht annehmen.** Für jeden Fehlertyp wird
   Cohen’s Kappa (bei zwei Ratern) bzw. Fleiss’ Kappa (bei mehr) berechnet.
   **Abnahmeschwelle: κ ≥ 0,6.** Liegt ein Fehlertyp darunter, ist er zu vage
   definiert — die Kategorie wird geschärft (klarere Kriterien, Beispielbilder)
   und neu kalibriert, nicht einfach mit schwächeren Labels weitergeführt.
4. **Kein Fachmensch bewertet eine Aufnahme, die er selbst erhoben hat**, wo
   organisatorisch vermeidbar — sonst vermischt sich Fachurteil mit Erwartung.
5. Rohvideo wird **nicht** an das Label angehängt; das Label hängt am
   `exampleId` und an den bereits extrahierten Merkmalen. Das erzwingt, dass
   das Modell aus denselben Zahlen lernt, die MOTUS zur Laufzeit auch hat —
   nicht aus Bildinformationen, die im Betrieb gar nicht zur Verfügung stehen.

## 7. Abnahmekriterien, bevor ein Modell „verlässlich" heißen darf

Ein Modell besteht diese Prüfung, oder es wird nicht ausgeliefert:

- **Prüfung auf ungesehenen Personen, nicht auf ungesehenen Wiederholungen.**
  Aufteilung in Trainings-/Testdaten nach `subjectId`, nie nach `exampleId` —
  sonst testet man Wiedererkennung derselben Person, nicht Verallgemeinerung.
- **Schlägt die bestehende Regel, wo eine existiert.** Für die drei Fehler, die
  schon als `MECHANICAL_RULES` kodiert sind, muss das gelernte Modell auf dem
  Testsatz nachweislich genauer sein als die feste Schwelle — sonst ersetzt man
  eine nachvollziehbare Regel durch eine undurchsichtige, ohne Gewinn.
  Für neue Fehler ohne bestehende Regel gilt ersatzweise: Genauigkeit ≥ 85 %
  gegen das Mehrheitsurteil der Fachleute auf dem Testsatz.
- **Verweigert bei schlechter Sicht, statt zu raten.** Wo `reliable: false`
  am betroffenen Gelenk steht (siehe `isReliable()` in `06-report.js`) oder
  `depthShare` über der Schwelle liegt, muss das Modell den Fehlerbefund als
  „nicht bestimmbar" ausweisen statt eine Vermutung mit hoher Sicherheit zu
  äußern. Das ist keine Zusatzanforderung, es ist dieselbe Regel, die die
  Rechenschritte 1–6 schon für Zahlen durchsetzen, jetzt für Urteile.
- **Stichprobenherkunft im Testsatz unterscheidet sich von der Trainingsmenge**
  in mindestens einer Dimension aus Abschnitt 4 (anderes Studio, andere
  Kamerahersteller, andere Region) — sonst misst der Test nur, ob das Modell
  seine eigene Erhebung wiedererkennt.

## 8. Empfohlener Ablauf

1. **Pilot an einem Bewegungsmuster** (Kniebeuge — am besten durch bestehende
   Regeln in der Tennis-Engine vorgeprüft) mit einem Fehler, ~300 Wiederholungen,
   um die Kalibrierung, das Werkzeug und die Kappa-Werte real zu erproben, bevor
   in die Breite skaliert wird.
2. Erst nach bestandener Abnahme (Abschnitt 7) auf **A** für den gleichen
   Bewegungstyp erweitern, dann auf weitere Fehler desselben Musters.
3. **Neues Bewegungsmuster erst nach Abschluss des vorherigen**, nicht parallel
   — die Stichprobenmatrix pro Muster ist selbst schon aufwendig genug, dass
   Parallelisierung eher zu überall dünnen als zu einer Erhebung gut gefüllten
   Zellen führt.
4. Bis ein Bewegungsmuster diesen Prozess durchlaufen hat, bleibt es bei den
   **regelbasierten** Befunden aus der Tennis-Engine, verallgemeinert auf das
   jeweilige Muster — nutzbar ab heute, ohne eine einzige gelabelte Aufnahme.
   Das ist die Alternative, die in der vorausgehenden Rückfrage als Weg A
   angeboten wurde und weiterhin offensteht.
