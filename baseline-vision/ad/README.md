# Werbefilm

35 Sekunden, 1920×1080, ohne Ton. Der Film erzählt denselben Befund wie
`docs/12-ergebnis.html`: ein Weltklasse-Aufschlag, vom alten Werkzeug mit
4,8 von 10 bewertet, weil es Winkel in der Bildebene mit Laborwerten aus drei
Dimensionen verglich — und was an seine Stelle getreten ist.

Die Animation ist keine Illustration. `skel.ts` exportiert genau den
Fixture-Aufschlag, gegen den die Acceptance-Tests laufen, projiziert durch die
erhöhte Seitenkamera; der Film zeigt also die Bewegung, die das Projekt selbst
als Prüfstein benutzt.

## Bauen

```bash
cd ad
npm install @fontsource/archivo @fontsource/ibm-plex-mono ffmpeg-static playwright
node --experimental-strip-types skel.ts     # Skelettdaten aus der Engine
node build-ad.mjs                           # ad.html (Schriften eingebettet)
node record.mjs                             # baseline-vision-ad.mp4
```

`ad.html` spielt im Browser von selbst und in Schleife. Beim Aufzeichnen setzt
`record.mjs` ein Flag, das den Selbstlauf abschaltet und die Zeitachse Bild für
Bild stellt — deshalb ist die Datei ein Film und nicht die Aufnahme eines
Browsers, der sein Bestes gibt.
