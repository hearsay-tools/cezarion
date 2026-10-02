// The dev server the live-preview e2e registers (#781): `node preview-app.mjs <port>`.
// One page, one button at a fixed spot. A click sets `location.hash = 'clicked'`, which the
// preview's address field must show.
import { createServer } from 'node:http'

const port = Number(process.argv[2])

// The button's centre is (140, 140) in page pixels; the spec clicks there.
const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Preview fixture</title>
    <style>
      html, body { margin: 0; background: #ffffff; }
      button { position: fixed; left: 40px; top: 100px; width: 200px; height: 80px; border: 0; background: #12b76a; color: #ffffff; font: 600 20px sans-serif; }
    </style>
  </head>
  <body>
    <button id="go" onclick="location.hash = 'clicked'">Click me</button>
  </body>
</html>`

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(port, '127.0.0.1', () => console.log(`preview-app listening on ${port}`))
