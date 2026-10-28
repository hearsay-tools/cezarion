// The dev server the live-preview e2e registers (#781): `node preview-app.mjs <port>`.
// One page, one button at a fixed spot. Each click sets `location.hash = 'clicked-<n>'`, n
// counted in page memory, which the preview's address field must show: a reload would restart n.
// Below the button, a block of small text and a band of 1px stripes are the stream-quality
// comparison fixture (hearsay-tools/cezarion#2066): JPEG compression rings around the glyphs and
// flattens the stripes, so High must leave the text's white background whiter and the stripes
// sharper than Normal.
import { createServer } from 'node:http'

const port = Number(process.argv[2])

// The button's centre is (140, 140) in page pixels; the spec clicks there. The text block and the
// stripes sit at the page pixels the spec reads (TEXT and STRIPES in live-preview.e2e.ts).
const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Preview fixture</title>
    <style>
      html, body { margin: 0; background: #ffffff; }
      button { position: fixed; left: 40px; top: 100px; width: 200px; height: 80px; border: 0; background: #12b76a; color: #ffffff; font: 600 20px sans-serif; }
      #text { position: fixed; left: 40px; top: 220px; width: 360px; height: 60px; margin: 0; overflow: hidden; color: #000000; font: 11px/15px sans-serif; }
      #stripes { position: fixed; left: 40px; top: 300px; width: 200px; height: 40px; background: repeating-linear-gradient(90deg, #000000 0 1px, #ffffff 1px 2px); }
    </style>
  </head>
  <body>
    <button id="go" onclick="location.hash = 'clicked-' + (window.clicks = (window.clicks || 0) + 1)">Click me</button>
    <p id="text">The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow. 0123456789</p>
    <div id="stripes"></div>
  </body>
</html>`

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(port, '127.0.0.1', () => console.log(`preview-app listening on ${port}`))
