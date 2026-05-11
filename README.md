# AgentSidecar Bridge

AgentSidecar Bridge is the Mac-side local network companion for AgentSidecar. It runs on the Mac where Codex Desktop is installed, reads local Codex chat metadata, and exposes a private LAN API for trusted local clients.

The native iPhone/iPad app is kept in a separate private repository.

## Setup

From a Mac that has Codex installed:

```sh
git clone https://github.com/matteodallombra/AgentSidecar.git
cd AgentSidecar
npm install
npm start
```

The bridge prints local setup URLs, a bearer token, and a pairing QR code. Keep the bridge running while using AgentSidecar on the same local network.

## What It Does

- reads Codex chats from `~/.codex/state_5.sqlite`
- reads transcripts from Codex rollout JSONL files
- reads Codex Desktop pinned chats and queued follow-ups from `~/.codex/.codex-global-state.json`
- stores companion pin additions and image attachments in `~/.codex/lan-companion/`
- submits prompts into the visible Codex Desktop chat by default, so phone activity appears inline on the Mac
- rejects non-private-network clients and requires the bearer token for API access

## Send Modes

Default send mode:

```sh
CODEX_LAN_SEND_MODE=desktop-ui npm start
```

This uses macOS UI automation to paste the prompt into the currently visible Codex Desktop composer and press Return. For this to work:

- the target Codex chat must be open on the Mac
- Terminal or the process running `npm start` needs Accessibility permission in System Settings > Privacy & Security > Accessibility
- the Mac should not be actively typing in another Codex field when a LAN client sends

Saved-history fallback:

```sh
CODEX_LAN_SEND_MODE=cli-resume npm start
```

`cli-resume` writes to Codex saved history but does not make the current desktop renderer update inline.
