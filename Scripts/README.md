# Scripts

- `open-app-window.ps1` opens the local app URL in a standalone browser window after the server is healthy.
- `run_tests.ps1` installs dependencies when needed, runs the build check when present, and executes the Node test suite.

Project-owned scripts use the `.ps1` extension by default. Some are shell-compatible through a shebang for WSL/Linux use, but new script filenames should still default to `.ps1`.
