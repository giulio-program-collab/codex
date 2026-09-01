# 11 · Risiken und Grenzen

## Was dieses System nicht kann

### Aus einer unkalibrierten Kamera grundsätzlich nicht

| Größe                          | Grund                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ballgeschwindigkeit            | Tiefe folgt nur aus dem Bildradius von wenigen Pixeln; ein Pixel Fehler bei vier Pixeln Radius sind 25 % Tiefenfehler. Direkt nach dem Treffpunkt ist der Ball meist gar nicht detektierbar |
| Spin                           | Erfordert sichtbare Ballnaht bei hoher Bildrate oder Radar-/Hawk-Eye-Daten                                                                                                                  |
| Abflugwinkel                   | Setzt kalibrierte Platzgeometrie und einen sicheren Balltrack nach dem Kontakt voraus                                                                                                       |
| Innenrotation des Humerus      | Rotation um die eigene Längsachse ist aus Gelenkpositionen prinzipiell nicht bestimmbar — braucht Marker-Cluster oder IMU                                                                   |
| Gelenkmomente und -kräfte      | Braucht Kraftmessplatten oder validierte Segmentmassen mit inverser Dynamik                                                                                                                 |
| Handgelenkskinematik im Detail | Braucht Auflösung und Bildrate weit über dem, was am Platz gefilmt wird                                                                                                                     |
| Gelenkfehler unter etwa 30 mm  | Braucht kalibrierte Mehrkamera-Anordnung                                                                                                                                                    |

Diese Liste steht maschinenlesbar im Code (`BALL_UNOBSERVABLE`, Beobachtbarkeits­klasse
`unobservable`), damit die Oberfläche sie mit Begründung anzeigen kann.

### Fachlich nicht

Das System kann nicht sagen, ob eine Technik **für diesen Spieler** richtig ist.
Es misst Abweichungen von Referenzverteilungen und benennt Wirkmechanismen. Ob
eine Abweichung ein Stilmerkmal, eine Anpassung an eine körperliche Eigenheit
oder ein Fehler ist, entscheidet der Trainer. Deshalb sind Empfehlungen als
Hypothesen formuliert und deshalb gibt es zu jedem Befund Übernehmen, Verwerfen
und Beobachten.

Es kann außerdem nichts über Absicht sagen. Ein flacher zweiter Aufschlag mit
wenig Beinantrieb kann eine taktische Entscheidung sein.

## Risiken

### Falsche Sicherheit durch kalibriert _aussehende_ Intervalle

**Das größte Risiko des Projekts.** Die Intervalle sind gegen eine synthetische
Fixture kalibriert. Eine Fixture kann keinen Fehler zeigen, der daher rührt, wie
echte Pose-Estimatoren versagen — korrelierte Ausfälle bei bestimmten
Kleidungsfarben, systematische Verschiebungen bei bestimmten Körpertypen,
Trainingsdaten ohne Aufschlagposen.

Ein Intervall, das _aussieht_ wie eine Messunsicherheit, es aber nicht ist, ist
gefährlicher als gar keins, weil es Vertrauen erzeugt.

_Minderung:_ `METHOD_BIAS` ist ausdrücklich als untere Schranke dokumentiert.
Die Freigabe für den Produktiveinsatz hängt an der markerbasierten Erhebung aus
[09](09-validierung.md).

### Referenzen mit unbestätigter Messkonvention

Der Schulterelevations-Fall zeigt es: Sechzig Grad Unterschied waren zwei
Konventionen, nicht ein technischer Fehler. Das System fängt das heute über
`definitionMatch: "unverified"` ab — aber nur für die Fälle, die aufgefallen
sind. Weitere können in den Referenzen stecken.

_Minderung:_ Jede Referenz braucht vor Freigabe eine schriftlich festgehaltene
Konventionsprüfung gegen den Methodenteil ihrer Quelle. Bis dahin gilt
„unverified" als Voreinstellung, nicht „verified".

### Kohorten-Verbreiterung ist geraten

Die Faktoren für Niveauabstand, Körpergrößenabweichung und Junior/Erwachsen sind
plausible Annahmen ohne empirische Grundlage. Sie sind im Code als „am dringendsten
kalibrierungsbedürftig" markiert.

_Minderung:_ Bis zur Kalibrierung ist der **Eigenvergleich** die belastbarste
Aussage. Die Oberfläche sagt das ausdrücklich, wenn der Kohorten-Term den Abstand
zum Referenzwert dominiert.

### Der geometrische Rückfallpfad ist schwach

Ohne Tiefenprior liegt der Gelenkfehler bei 225–500 mm statt 36–49 mm. Das System
meldet das über Spiegelungssicherheit und Rekonstruktionsgüte — aber ein Nutzer,
der die Meldung überliest, bekommt Zahlen, die aussehen wie die guten.

_Minderung:_ Der Tiefenprior gehört in die Produktionskonfiguration. Ohne ihn
sollte die Oberfläche den Modus deutlich benennen, nicht nur die Güte senken.

### Zu häufiges Schweigen

Das System verweigert das Urteil, sobald weniger als drei Vergleiche informativ
sind. Bei einem Nachwuchsspieler mit breiter Kohorten-Verbreiterung passiert das
regelmäßig — auch bei guter Aufnahme.

Das ist die richtige Entscheidung und trotzdem ein Produktrisiko: Ein Werkzeug,
das oft „weiß nicht" sagt, wird nicht benutzt. Die Antwort darf nicht sein, die
Schwelle zu senken, sondern die Unsicherheit zu senken — bessere Aufnahme,
Platzlinien, mehr Wiederholungen. Genau dafür sind die Abhilfen bei jeder
Qualitätskomponente da.

Ein Werkzeug, das oft schweigt und dabei _sagt, was zu tun ist, damit es reden
kann_, ist ein anderes Produkt als eines, das nur schweigt.

### Datenschutz bei Minderjährigen

Die bestehende App sagt zu: „Bleibt lokal, wird nirgendwo hochgeladen." Bei
Videos von Kindern ist das keine Marketingaussage, sondern eine Zusage mit
rechtlichem Gewicht. Serverseitige Inferenz bricht sie.

_Minderung:_ Browser-Inferenz per ONNX Runtime Web als Voreinstellung; jede
serverseitige Verarbeitung erfordert eine ausdrückliche, getrennte Einwilligung.

### Fehlanreiz durch die Gesamtnote

Auch eine transparent zusammengesetzte Zahl wird zur Zielgröße. Die Gegenmittel
im Design: Die Komponenten stehen immer daneben, die Confidence steht immer
daneben, ein hoher Wert wird ausdrücklich eingeordnet, und der Verlauf ist als
das wertvollere Werkzeug platziert.

_Restrisiko:_ Trotzdem hoch. Zu erwägen wäre, die Gesamtnote im Standardlayout
ganz wegzulassen und nur auf Anforderung zu zeigen.

### Modelldrift

Ein ausgetauschter Pose-Estimator verändert alle Typ-B-Terme. Ohne erneute
Kalibrierung sind die Intervalle danach falsch, ohne dass irgendetwas fehlschlägt.

_Minderung:_ Die Modellversion gehört in den Report, und eine Änderung muss die
Validierungssuite erneut durchlaufen. Zusätzlich sollte ein fester
Referenz-Clip-Satz bei jedem Modellwechsel gerechnet und verglichen werden.

## Was falsch bleiben wird

Auch nach vollständiger Kalibrierung wird dieses System:

- einzelne Aufschläge schlechter beurteilen als ein erfahrener Trainer mit
  Zeitlupe, weil es keinen Kontext über den Spieler hat, den der Trainer hat;
- bei ungewöhnlichen, aber funktionierenden Techniken Abweichungen melden;
- bei schlechten Aufnahmen häufiger schweigen, als es Nutzern lieb ist.

Es wird dafür Dinge tun, die ein Trainer nicht kann: Zeitabstände im
Millisekundenbereich messen, über Sitzungen hinweg konsistent messen, und die
eigene Unsicherheit angeben.

Die richtige Aufgabenteilung ist nicht „das System bewertet, der Trainer liest",
sondern „das System misst und sagt, wie genau, der Trainer bewertet".
