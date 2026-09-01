# Herkunft dieser Dateien

Aus [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision)
und den Modelldateien von Google, Apache License 2.0.

| Datei | was es ist |
| --- | --- |
| `vision_bundle.mjs` | die JavaScript-Bibliothek |
| `vision_wasm_internal.js` | der Emscripten-Lader, der das WebAssembly startet |
| `vision_wasm_internal.wasm` | die Laufzeit selbst |
| `pose_landmarker_lite.task` | das Modell: 33 Körperpunkte, 2D im Bild und 3D im Raum |

Sie liegen hier statt in einem Paketverzeichnis, weil MOTUS zur Laufzeit nichts
nachlädt. Ein Werkzeug, das ohne Internet nicht startet, startet auf einer
Sportanlage regelmäßig nicht.

Neu holen — die Version muss zusammenpassen, Bibliothek und WebAssembly stammen
aus demselben Paket:

```bash
npm pack @mediapipe/tasks-vision@0.10.22
tar -xzf mediapipe-tasks-vision-*.tgz
cp package/vision_bundle.mjs package/wasm/vision_wasm_internal.* vendor/
curl -o vendor/pose_landmarker_lite.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
```
