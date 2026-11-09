# Contributing to Exocortex

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run checks: `npm run check`
5. Commit and push
6. Open a Pull Request

## Development Setup

```bash
cp .env.example .env
npm run setup
npm run db:up
npm run db:init
```

The repo is an npm workspace (`memory`, `memory-graph`, `runner`) with a single lockfile at the root. Install from the root only.

Fill in your API keys in `.env`. Run `npm run check` before opening a PR. It runs the typecheck and the tests, same as CI. The unit tests use in-memory stores from `memory/testing/`, so they don't need Docker or API keys.

If you touch retrieval or ranking, run `npm run eval:offline` and compare against `eval/results.md`. `npm run eval` runs the same suite with real embeddings and costs a few cents.

## Code Style

- TypeScript strict mode
- Prefer type guards over `as` casts
- Follow SOLID and GRASP principles
- All new features must have tests

## Reporting Issues

- Use GitHub Issues
- Include steps to reproduce
- Include relevant logs if applicable

## Pull Requests

- Keep PRs focused on a single change
- Write descriptive commit messages
- Ensure all tests pass before submitting
