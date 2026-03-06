import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = 'C:/Users/Christian/Documents/Nerd/Holden-nerd-portal'
const PORT = 8082

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

createServer((req, res) => {
  let url = req.url.split('?')[0]
  if (url.endsWith('/')) url += 'index.html'
  let filePath = join(ROOT, url)

  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  // If path is a directory, serve index.html inside it
  if (statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html')
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
  }

  const ext = extname(filePath)
  const mime = MIME[ext] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime })
  res.end(readFileSync(filePath))
}).listen(PORT, () => console.log(`Serving on http://localhost:${PORT}`))
