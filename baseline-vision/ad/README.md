# Werbefilm

35 Sekunden, 1920×1080, ohne Ton.

Der Film hat sieben Einstellungen: ein Aufschlag auf einem Platz, aus dem der
Rahmen zurückweicht, bis er sich als Handybildschirm herausstellt; ein Stoß
durch diesen Bildschirm hinein in die App; drei Schritte, in denen die App
erklärt, was sie tut — sehen, messen, einordnen; die Absage, wenn eine Aufnahme
nichts hergibt; und der Name.

## Woher die Bilder kommen

**Die Bewegung** ist keine Illustration. `skel.ts` exportiert genau den
Fixture-Aufschlag, gegen den die Acceptance-Tests laufen, projiziert durch die
erhöhte Seitenkamera. Zu jedem Bild liefert der Export außerdem Pixel pro Meter,
die Tiefe jedes Gelenks und den Fußpunkt seines Schattens — damit `figure.js`
die Gliedmaßen in echten Körpermaßen zeichnen, sie nach Tiefe sortieren und die
Figur auf den Boden stellen kann, statt sie schweben zu lassen.

**Die Bildschirme** sind keine Attrappen. `capture-app.mjs` fotografiert die
laufende Anwendung und liest aus demselben Durchlauf sowohl die Ausschnitte,
die der Film hervorhebt, als auch die Zahlen, die er ausspricht, in
`app-capture.json`. Der Film zitiert also keine Messung, die sein eigener
Screenshot nicht zeigt — genau der Fehler, gegen den dieses Projekt
angeschrieben ist.

Es ist kein Fremdmaterial verwendet: keine Aufnahmen von Spielern, keine
Übertragungsbilder, keine Stockvideos.

## Bauen

```bash
cd engine && node --experimental-strip-types tools/serve.ts   # Fenster 1

cd ad                                                          # Fenster 2
npm install @fontsource/archivo @fontsource/ibm-plex-mono ffmpeg-static playwright
node --experimental-strip-types skel.ts   # skeleton.json aus der Engine
node capture-app.mjs                      # app-*.png und app-capture.json
node build-ad.mjs                         # ad.html, alles eingebettet
node record.mjs                           # baseline-vision-ad.mp4
```

`skel.ts` und `capture-app.mjs` müssen nur laufen, wenn sich die Bewegung oder
die Oberfläche geändert hat; ihre Ergebnisse liegen im Repository.

`ad.html` spielt im Browser von selbst und in Schleife. Beim Aufzeichnen setzt
`record.mjs` ein Flag, das den Selbstlauf abschaltet und die Zeitachse Bild für
Bild stellt — deshalb ist die Datei ein Film und nicht die Aufnahme eines
Browsers, der sein Bestes gibt.
