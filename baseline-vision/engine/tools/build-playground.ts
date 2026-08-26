import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { bundle } from "./bundle.ts";

/**
 * Builds the playground: one HTML file that carries the entire engine.
 *
 * Two files come out of the same parts. `index.html` is a complete document to
 * open from disk; `artifact.html` is the same page as a fragment, for hosts
 * that supply their own document skeleton.
 */

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = join(here, "..");
const playgroundDir = join(engineDir, "..", "playground");

const engine = bundle(join(engineDir, "playground", "entry.ts"), {
  globalName: "BaselineVision",
  root: engineDir,
});

// The engine is delivered inside a <script> element and re-read as text to
// start the worker, so a literal closing tag anywhere in it would end the
// element early and corrupt the page.
if (/<\/script/i.test(engine)) {
  throw new Error("the bundled engine contains a literal </script; the page would break");
}

const template = readFileSync(join(playgroundDir, "template.html"), "utf8");
const app = readFileSync(join(playgroundDir, "app.js"), "utf8");

const fragment = template.replace("<!--ENGINE-->", engine).replace("<!--APP-->", app);

// The video page is the same page with a pose estimator in front of it. It is
// built separately because that estimator is fifteen megabytes of model and
// WebAssembly served from `playground/vendor/`, which only exists once
// `tools/fetch-models.ts` has run and which no single-file build could carry.
const videoApp = readFileSync(join(playgroundDir, "video-app.js"), "utf8");

const document = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${fragment.slice(0, fragment.indexOf("</style>") + "</style>".length)}
</head>
<body>
${fragment.slice(fragment.indexOf("</style>") + "</style>".length)}
</body>
</html>
`;

const videoFragment = fragment.replace(
  "</body>",
  `<script type="module">
${videoApp}
</script>
</body>`,
);
const videoDocument = document.replace(
  "</body>",
  `<script type="module">
${videoApp}
</script>
</body>`,
);

writeFileSync(join(playgroundDir, "index.html"), document);
writeFileSync(join(playgroundDir, "artifact.html"), fragment);
writeFileSync(join(playgroundDir, "video.html"), videoDocument);
void videoFragment;

const kb = (s: string) => (s.length / 1024).toFixed(0);
console.log(`engine bundle  ${kb(engine)} kB`);
console.log(`index.html     ${kb(document)} kB`);
console.log(`artifact.html  ${kb(fragment)} kB`);
console.log(`video.html     ${kb(videoDocument)} kB`);
