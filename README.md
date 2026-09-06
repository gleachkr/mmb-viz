# mmb-viz

A visual explainer and debugger for Metamath Zero binary proof files (`.mmb`).

## Develop

```bash
npm install
npm run dev        # http://localhost:5173, or add #example=peano.mmb
npm test           # vitest: header decoding, span partition, corpus
npm run typecheck
npm run build      # static site in dist/
```
