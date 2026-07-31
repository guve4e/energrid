# API Docs

The API and Core apps expose Swagger/OpenAPI docs while they are running.

```sh
pnpm api
```

Open:

```text
http://localhost:3000/api/docs
```

Core:

```sh
pnpm core
```

Open:

```text
http://localhost:3020/core/docs
```

The machine-readable OpenAPI documents are available at:

```text
http://localhost:3000/api/docs-json
http://localhost:3020/core/docs-json
```

Swagger documents the REST endpoints. The `/voice` WebSocket protocol is also
available as REST-readable metadata under `/voice/protocol`, but use the replay
tool for actual voice stream testing:

```sh
pnpm voice:replay /path/to/test.wav
```
