# Repository Guidelines

## Project Structure & Module Organization

- `src/main/`: Electron lifecycle, IPC handlers, agent execution, provider engines, services, and tools.
- `src/preload/`: the IPC bridge exposed to the renderer.
- `src/renderer/src/`: React components, Zustand state, styles, and UI helpers.
- `src/shared/`: shared contracts, model definitions, and the ACP registry.
- `scripts/`: icon generation and PTY preparation; `resources/` and renderer `assets/`: app assets.
- `out/` and `release/`: generated build and packaging output. Do not edit these directly.

Keep privileged operations in the main process and expose typed interfaces through preload and shared contracts.

## Build, Test, and Development Commands

Use Node.js 22.12+ and npm.

- `npm ci`: install dependencies from the lockfile.
- `npm run dev`: start Electron with the development renderer.
- `npm run typecheck`: check main-process and renderer TypeScript.
- `npm run build`: compile the application into `out/`.
- `npm start`: preview the compiled application.
- `npm run dist`: package a macOS app bundle.
- `npm run dist:dmg`: generate a macOS DMG in `release/`.

## Coding Style & Naming Conventions

Follow existing TypeScript style: two-space indentation, single quotes, and no semicolons. Use PascalCase for React component files and types, camelCase for functions and variables, and descriptive module names such as `projectFiles.ts`. Use `import type` for type-only dependencies and `@shared/*` for shared imports where configured.

No ESLint or Prettier configuration is currently provided; avoid unrelated formatting changes.

## Testing Guidelines

No automated test suite, test script, or coverage threshold is currently configured. Run `npm run typecheck` and `npm run build` for code changes, then manually exercise affected flows with `npm run dev`. For provider changes, verify connection, streaming, cancellation, and approvals when credentials are available. Report untested paths explicitly. If adding automated tests, document the runner, naming convention, and command.

## Commit & Pull Request Guidelines

History uses short, informal subjects such as `Add icon to worked for Ns log`; no enforced commit convention is evident. Prefer concise, imperative subjects describing one focused change.

PRs should explain the problem, resulting behavior, validation performed, and remaining limitations. Link relevant issues and include screenshots for UI changes. Keep generated artifacts and credentials out of commits.

## Security & Configuration

Never commit API keys, authentication files, or local conversation data. Preserve approval checks and the Electron process boundary. Update shared IPC types alongside handlers and preload APIs when changing contracts.
