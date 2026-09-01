# 12 · Sitzung und Verlauf

## Warum eine Sitzungsebene überhaupt existiert

Nicht aus Bequemlichkeit, sondern weil das System sich selbst eine Regel
auferlegt hat und diese Regel eingehalten wird.

Layer 1 rechnet aus, dass ein zeitlicher Abstand zwischen Segment-Peaks bei
120 Hz erst ab drei und bei 60 Hz erst ab fünf Wiederholungen als Mittelwert
zitiert werden darf. Layer 10 setzt das durch. Ein einzelner Clip kann diese
Bedingung deshalb **nie** erfüllen — und ohne eine Möglichkeit, der Pipeline
mehr als einen Schlag zu geben, wäre der biomechanisch wertvollste Teil der
Analyse dauerhaft unerreichbar.

Vorher war das eine Inkonsistenz: Die Regel wurde in Layer 1 berechnet, in einer
Diagnosezeile ausgegeben — und in Layer 10 ignoriert. Ein einzelner Aufschlag
bei 120 Hz lieferte einen Becken-Peak so selbstbewusst wie dreißig. Genau diese
Form von Fehler soll das System verhindern: eine Regel, die in einer Schicht
formuliert und in einer anderen gebrochen wird.

## Was der Gate tut

| Situation                          | Verhalten                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unter 60 Hz                        | Keine Zeitgröße wird erzeugt. Sie erscheint unter „Nicht messbar" mit Begründung.                                                                                                  |
| Ab 60 Hz, zu wenige Wiederholungen | Der Wert wird gemessen und angezeigt — er ist eine echte Messung _dieses_ Schlags —, darf aber nicht gegen eine Referenzverteilung gescort werden. Der Grund steht an der Messung. |
| Ab 60 Hz, genug Wiederholungen     | Der Mittelwert wird gegen die Referenz verglichen.                                                                                                                                 |

Die Aussage über die **Reihenfolge** (dreht das Becken vor dem Rumpf?) ist davon
ausgenommen. Sie wird nicht gegen eine Population gescort, sondern gegen die
eigene Unsicherheit der Messung geprüft — und das ist der richtige Test für eine
Vorzeichenaussage. Ein umgekehrter Ablauf ist ein großer, klarer Effekt; ein
Unterschied von 18 ms im Absolutwert ist es nicht.

## Was die Sitzung liefert

`analyseSession(request, options)` nimmt mehrere Wiederholungen desselben
Schlags und gibt zusätzlich zu den Einzelreports:

- **Mittelwert und Median** je Kenngröße
- **Streuung zwischen den Wiederholungen** — die Konstanz des Spielers
- **Variationskoeffizient**, wo er etwas bedeutet
- **Ausreißer**, benannt statt stillschweigend entfernt
- **Genauigkeit des Mittelwerts**, getrennt von der Streuung
- **Referenzvergleiche** auf den Mittelwerten
- **Ausgeschlossene Wiederholungen** mit Begründung

## Die zwei Streuungen

Das Panel zeigt zwei Zahlen nebeneinander, die oft verwechselt werden:

```
Maximale Knieflexion   26,60°   Konstanz ± 3,79° (VK 14,3 %)   Mittelwert genau auf ± 3,38°
```

**Konstanz** ist die Streuung zwischen den Wiederholungen. Sie ist kein
Messfehler, sondern eine Eigenschaft des Spielers — und für einen Trainer oft
die interessantere der beiden. Ein Spieler mit 26° ± 12° hat ein anderes Problem
als einer mit 26° ± 2°.

**Genauigkeit des Mittelwerts** ist, wie genau wir den Durchschnitt kennen. Nur
diese Zahl darf in einen Referenzvergleich eingehen.

## Warum Mitteln die Genauigkeit nicht beliebig verbessert

Der zufällige Anteil des Fehlers schrumpft mit 1/√n. Der systematische nicht.

```
Genauigkeit des Mittelwerts = √( (Streuung/√n)² + systematischer Anteil² )
```

Der systematische Anteil wird direkt aus `METHOD_BIAS` genommen, nicht aus den
Daten geschätzt. Die naheliegende Schätzung `√(gemeldete Unsicherheit² −
Streuung²)` ist in einer Richtung falsch, die zählt: Wenn ein Spieler zwischen
den Wiederholungen stark schwankt, übersteigt die Streuung die gemeldete
Messunsicherheit, der geschätzte systematische Anteil fällt auf null, und der
Mittelwert wird als `Streuung/√n` genau ausgewiesen. Das verspricht, dass dreißig
Wiederholungen einen Becken-Peak auf zwei Millisekunden festlegen. Tun sie
nicht: Das Verfahren trägt einen Bias von etwa zwölf, und eine verzerrte Messung
dreißigmal zu mitteln erzeugt eine sehr präzise falsche Antwort.

Das Dashboard schreibt den systematischen Anteil ausdrücklich hin:

> ± 3,38° · davon 3,00 systematisch — durch weitere Wiederholungen nicht zu verringern

## Ausreißer

Erkannt über robuste Abweichungen vom Median, aber erst ab fünf Wiederholungen:
Bei dreien ist die robuste Streuungsschätzung selbst Rauschen, und einen von drei
Werten zu verwerfen entfernt eher die Wahrheit als einen Fehler.

Der Maßstab wird nie kleiner als die **Messunsicherheit selbst**. Ohne diese
Untergrenze bricht die Regel zusammen, sobald die Wiederholungen zufällig eng
beieinanderliegen: Die robuste Streuung geht gegen null, und ein Wert wenige
Millimeter neben dem Median kommt als Fünf-Sigma-Ausreißer heraus. Ein Wert
innerhalb des eigenen Messrauschens ist nach keiner brauchbaren Definition ein
Ausreißer, egal wie viele robuste Abweichungen er formal entfernt liegt.

Verworfene Wiederholungen erscheinen mit Nummer, Wert und Abstand — ein Trainer
soll sehen, dass ein Schlag anders war, nicht nur, dass er verschwunden ist.

## Eine Wiederholung, die nicht mitzählt

Liegt die Analysequalität einer Wiederholung unter 45/100, geht sie nicht in den
Mittelwert ein. Eine schlechte Messung mit guten zu mitteln verdünnt sie nicht,
sie verunreinigt sie. Der Einzelreport bleibt trotzdem erhalten und abrufbar.

## Der Tiefenprior gehört zur Wiederholung, nicht zur Sitzung

`SessionRepetition` trägt ihren eigenen `depthPrior`. Das ist kein Detail: Ein
Tiefenprior wird über den Bildindex _dieses Clips_ abgefragt. Einen einzigen
Prior an alle Wiederholungen zu geben, würde funktionieren aussehen — die
Schnittstelle nimmt einen Bildindex und liefert eine Zahl — und dabei still die
Tiefen des ersten Aufschlags in den sechsten lesen.

## Eine gemessene Grenze

Auch mit sechs Wiederholungen bei 240 Hz bleiben die publizierten Timing-Bänder
am Rand des Auflösbaren:

| Kenngröße               | Referenz-SD | kombinierte SD (6 Wdh.) | informativ?           |
| ----------------------- | ----------- | ----------------------- | --------------------- |
| Becken-Peak vor Kontakt | 0,008 s     | 0,0166 s                | nein (Schwelle 0,016) |
| Rumpf-Peak vor Kontakt  | 0,004 s     | 0,0134 s                | nein                  |
| Abstand Becken zu Rumpf | 0,009 s     | 0,0194 s                | nein (Schwelle 0,018) |

Der Grund ist der systematische Anteil von etwa 12 ms, der durch keine Zahl von
Wiederholungen kleiner wird — gegen Referenz-Streuungen von 4 bis 9 ms. Das ist
kein Fehler, sondern eine quantifizierte Grenze des Verfahrens, und sie sagt
etwas Konkretes: **Der Unterschied zwischen Elite und High-Performance im
absoluten Timing ist mit einer Kamera nicht auflösbar.**

Was mit denselben Daten sehr wohl geht:

1. Die **Reihenfolge** der Segment-Peaks — ein großer Effekt mit klarem
   Vorzeichen.
2. Der **Eigenvergleich** über Sitzungen, weil der systematische Anteil sich
   dabei weitgehend aufhebt.
3. Die **Konstanz** über die Wiederholungen, die gar keinen Referenzwert braucht.

Die drei sind zusammen mehr wert als ein Vergleich mit einem publizierten
Millisekundenwert, den das Verfahren nicht tragen kann.
